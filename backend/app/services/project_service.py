"""Project management service for importing media, orchestrating pipeline runs, and cascade deletion."""

from __future__ import annotations
import re
import shutil
from pathlib import Path
from typing import List, Optional, Tuple

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.audio.exceptions import (
    FFmpegNotFoundError,
    MediaProbeError,
    UnsupportedMediaError,
)
from backend.app.audio.media_probe import MediaProbe
from backend.app.audio.models import SegmentationConfig, WhisperConfig
from backend.app.audio.pipeline import AudioPipeline
from backend.app.core.config import settings
from backend.app.core.security import validate_identifier
from backend.app.db.models import Project, ProjectSettings, Segment
from backend.app.schemas.project import ProjectDetail, ProjectSummary


VIDEO_EXTENSIONS = {".mp4", ".mkv", ".webm", ".avi", ".mov"}


class ProjectService:
    """Handles project lifecycle, filesystem management, and database operations."""

    @staticmethod
    def sanitize_filename(filename: str) -> str:
        """Sanitize filename to prevent directory traversal and unsafe characters."""
        clean = Path(filename).name
        clean = re.sub(r"[^\w\-.]", "_", clean)
        return clean or "media_upload"

    @classmethod
    async def import_project(
        cls,
        session: AsyncSession,
        file: UploadFile,
        title: Optional[str] = None,
        whisper_model: Optional[str] = None,
    ) -> Project:
        """Receive an uploaded media file, persist it on disk, and create the database record."""
        original_name = file.filename or "media_upload"
        safe_name = cls.sanitize_filename(original_name)
        ext = Path(safe_name).suffix.lower()

        if ext not in settings.allowed_media_extensions:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Unsupported media format '{ext}'. Allowed: "
                    f"{', '.join(sorted(settings.allowed_media_extensions))}"
                ),
            )

        media_type = "video" if ext in VIDEO_EXTENSIONS else "audio"
        chosen_title = title.strip() if title and title.strip() else Path(original_name).stem

        # Validate and enforce Whisper model selection
        if settings.is_cloud_mode:
            if whisper_model is None or not whisper_model.strip():
                chosen_model = "tiny"
            else:
                cleaned_model = whisper_model.strip().lower()
                if cleaned_model != "tiny":
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=(
                            f"Unsupported Whisper model '{whisper_model}' in cloud mode. "
                            f"Cloud mode strictly enforces the 'tiny' model."
                        ),
                    )
                chosen_model = "tiny"
        else:
            chosen_model = (
                whisper_model.strip()
                if whisper_model and whisper_model.strip()
                else settings.default_whisper_model
            )

        # Create Project record
        project = Project(
            title=chosen_title,
            original_filename=original_name,
            media_type=media_type,
            whisper_model=chosen_model,
            status="pending",
        )
        session.add(project)
        await session.flush()

        # Prepare isolated project directory on disk
        project_dir = settings.get_project_dir(project.id)
        project_dir.mkdir(parents=True, exist_ok=True)

        persisted = False
        target_path = project_dir / safe_name
        try:
            # Save uploaded file
            try:
                with open(target_path, "wb") as f:
                    while chunk := await file.read(1024 * 64):
                        f.write(chunk)
            except OSError as exc:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Failed to save uploaded file: {exc}",
                )

            # Cloud-only media duration validation (must not exceed 180 seconds)
            if settings.is_cloud_mode:
                try:
                    probe = MediaProbe()
                    meta = probe.probe(target_path)
                except UnsupportedMediaError as exc:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Uploaded file does not contain valid audio streams: {exc}",
                    ) from exc
                except (MediaProbeError, FileNotFoundError) as exc:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Invalid, corrupted, or unreadable media file: {exc}",
                    ) from exc
                except FFmpegNotFoundError as exc:
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail="Media validation failed: ffprobe executable not found on system PATH",
                    ) from exc

                if meta.duration_s is None or meta.duration_s <= 0:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Unable to determine valid audio duration from uploaded media file",
                    )

                if meta.duration_s > settings.cloud_max_duration_seconds:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=(
                            f"Media duration ({meta.duration_s:.1f}s) exceeds cloud limit of "
                            f"{int(settings.cloud_max_duration_seconds)} seconds."
                        ),
                    )

                project.duration_seconds = float(meta.duration_s)

            project.source_file_path = settings.to_relative_path(target_path)

            # Initialize default project settings
            project_settings = ProjectSettings(project_id=project.id)
            session.add(project_settings)

            await session.commit()
            await session.refresh(project)
            persisted = True
            return project
        finally:
            if not persisted:
                if target_path.exists():
                    target_path.unlink()
                if project_dir.exists():
                    shutil.rmtree(project_dir, ignore_errors=True)

    @classmethod
    async def process_project_pipeline(
        cls,
        session: AsyncSession,
        project_id: str,
        pipeline: Optional[AudioPipeline] = None,
    ) -> Project:
        """Run the audio processing pipeline and populate practice segments in SQLite."""
        project_id = validate_identifier(project_id, "project_id")
        project = await session.get(Project, project_id)
        if not project:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

        project.status = "processing"
        await session.commit()

        project_dir = settings.get_project_dir(project.id)
        source_path = settings.resolve_media_path(project.source_file_path)

        try:
            if pipeline is None:
                model_name = "tiny" if settings.is_cloud_mode else project.whisper_model
                whisper_cfg = WhisperConfig(
                    model_size=model_name,
                    device="cpu",
                    compute_type=settings.default_compute_type,
                    cpu_threads=settings.default_cpu_threads,
                    language=settings.default_language,
                )
                segmentation_cfg = SegmentationConfig()
                pipeline = AudioPipeline(
                    whisper_config=whisper_cfg,
                    segmentation_config=segmentation_cfg,
                )

            result = pipeline.process(
                source_media_path=source_path,
                output_dir=project_dir,
                save_manifest=True,
            )

            # Store relative master audio path
            working_audio = Path(result.working_audio_file).resolve()
            project.master_audio_path = settings.to_relative_path(working_audio)
            project.duration_seconds = float(result.media_metadata.duration_s)

            # Clear any pre-existing segments if re-processing / retrying
            await session.execute(delete(Segment).where(Segment.project_id == project.id))

            # Populate segments
            for seg in result.practice_segments:
                db_seg = Segment(
                    project_id=project.id,
                    sequence_index=seg.sequence_index,
                    start_time_ms=seg.start_ms,
                    end_time_ms=seg.end_ms,
                    text=seg.text,
                    raw_transcript=seg.text,
                    is_edited=False,
                )
                session.add(db_seg)

            project.status = "ready"
            project.error_message = None
            await session.commit()
            await session.refresh(project)
            return project

        except Exception as exc:
            project.status = "failed"
            project.error_message = str(exc)
            await session.commit()
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Pipeline processing failed: {exc}",
            )

    @classmethod
    async def list_projects(cls, session: AsyncSession) -> List[ProjectSummary]:
        """Query all projects with metadata and segment counts."""
        # Query project with count of segments
        stmt = (
            select(
                Project,
                func.count(Segment.id).label("segments_count"),
            )
            .outerjoin(Segment, Project.id == Segment.project_id)
            .group_by(Project.id)
            .order_by(Project.created_at.desc())
        )
        result = await session.execute(stmt)
        rows = result.all()

        summaries: List[ProjectSummary] = []
        for proj, seg_count in rows:
            summaries.append(
                ProjectSummary(
                    id=proj.id,
                    title=proj.title,
                    original_filename=proj.original_filename,
                    media_type=proj.media_type,
                    duration_seconds=proj.duration_seconds,
                    whisper_model=proj.whisper_model,
                    status=proj.status,
                    error_message=proj.error_message,
                    segments_count=seg_count,
                    created_at=proj.created_at,
                    updated_at=proj.updated_at,
                )
            )
        return summaries

    @classmethod
    async def get_project_detail(
        cls, session: AsyncSession, project_id: str
    ) -> ProjectDetail:
        """Retrieve full project detail with settings and segment count."""
        project_id = validate_identifier(project_id, "project_id")
        stmt = (
            select(
                Project,
                func.count(Segment.id).label("segments_count"),
            )
            .outerjoin(Segment, Project.id == Segment.project_id)
            .options(selectinload(Project.settings))
            .where(Project.id == project_id)
            .group_by(Project.id)
        )
        result = await session.execute(stmt)
        row = result.first()

        if not row:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

        proj, seg_count = row
        return ProjectDetail(
            id=proj.id,
            title=proj.title,
            original_filename=proj.original_filename,
            media_type=proj.media_type,
            source_file_path=proj.source_file_path,
            master_audio_path=proj.master_audio_path,
            duration_seconds=proj.duration_seconds,
            whisper_model=proj.whisper_model,
            status=proj.status,
            error_message=proj.error_message,
            segments_count=seg_count,
            settings=proj.settings,
            created_at=proj.created_at,
            updated_at=proj.updated_at,
        )

    @classmethod
    async def delete_project(cls, session: AsyncSession, project_id: str) -> None:
        """Cascade delete project from SQLite and erase its folder on disk."""
        project_dir = settings.get_project_dir(project_id)
        projects_root = settings.projects_dir.resolve()

        project = await session.get(Project, project_id)
        if not project:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

        # Delete database record (SQLite CASCADE deletes segments, recordings, settings)
        await session.delete(project)
        await session.commit()

        # Delete filesystem directory (never allowed to match projects root)
        if project_dir.is_dir() and project_dir != projects_root and project_dir.is_relative_to(projects_root):
            shutil.rmtree(project_dir, ignore_errors=True)

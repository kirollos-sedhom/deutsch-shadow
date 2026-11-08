"""User recording persistence, storage path management, and take sequencing service."""

from __future__ import annotations
import asyncio
import os
from pathlib import Path
import shutil
import tempfile
from typing import List, Optional, Tuple
import uuid

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.audio.exceptions import (
    FFmpegNotFoundError,
    MediaProbeError,
    UnsupportedMediaError,
)
from backend.app.audio.media_probe import MediaProbe
from backend.app.core.config import settings
from backend.app.core.security import validate_identifier
from backend.app.db.models import Recording, Segment
from backend.app.schemas.segment import RecordingRead

# Max recording file size: 50 MB
MAX_RECORDING_SIZE_BYTES = 50 * 1024 * 1024
CHUNK_SIZE_BYTES = 64 * 1024  # 64 KB

# Supported media containers mapped to normalized (extension, content_type)
SUPPORTED_CONTAINERS: dict[str, Tuple[str, str]] = {
    "webm": (".webm", "audio/webm"),
    "matroska,webm": (".webm", "audio/webm"),
    "wav": (".wav", "audio/wav"),
    "ogg": (".ogg", "audio/ogg"),
    "mov,mp4,m4a,3gp,3g2,mj2": (".m4a", "audio/mp4"),
    "mp4": (".mp4", "audio/mp4"),
}


class RecordingService:
    """Service handling audio take persistence, validation, streaming paths, and deletion."""

    _probe: Optional[MediaProbe] = None
    _take_lock: asyncio.Lock = asyncio.Lock()

    @classmethod
    def get_probe(cls) -> MediaProbe:
        """Lazily initialize and return the MediaProbe instance."""
        if cls._probe is None:
            cls._probe = MediaProbe()
        return cls._probe

    @classmethod
    def _validate_safe_path(cls, target_path: Path, project_id: str) -> None:
        """Enforce path confinement strictly within the project's recordings directory."""
        expected_parent = (settings.get_project_dir(project_id) / "recordings").resolve()
        resolved_target = target_path.resolve()
        resolved_projects_root = settings.projects_dir.resolve()

        if not (
            resolved_target.is_relative_to(expected_parent)
            and resolved_target.is_relative_to(resolved_projects_root)
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Security violation: recording storage path traversal detected",
            )

    @classmethod
    def _map_container_extension(cls, format_name: str) -> Tuple[str, str]:
        """Match ffprobe format_name to a verified extension and MIME type."""
        normalized = format_name.lower().strip()
        for key, (ext, mime) in SUPPORTED_CONTAINERS.items():
            if key in normalized or normalized in key:
                return ext, mime

        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=(
                f"Unsupported audio container format '{format_name}'. "
                f"Supported formats: webm, wav, mp4/m4a, ogg"
            ),
        )

    @classmethod
    async def create_recording(
        cls,
        session: AsyncSession,
        segment_id: str,
        upload_file: UploadFile,
        client_duration_ms: Optional[int] = None,
    ) -> RecordingRead:
        """Validate and persist an uploaded audio take for a given segment."""
        segment_id = validate_identifier(segment_id, "segment_id")
        # 1. Verify parent segment exists
        segment = await session.get(Segment, segment_id)
        if not segment:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Segment '{segment_id}' not found",
            )

        project_id = segment.project_id
        recordings_dir = (settings.get_project_dir(project_id) / "recordings").resolve()
        recordings_dir.mkdir(parents=True, exist_ok=True)

        # 2. Stream upload to a temporary file, enforcing size limits
        temp_fd, temp_path_str = tempfile.mkstemp(prefix="ds_rec_tmp_", dir=str(recordings_dir))
        temp_path = Path(temp_path_str)
        total_bytes = 0

        try:
            with os.fdopen(temp_fd, "wb") as temp_file:
                while True:
                    chunk = await upload_file.read(CHUNK_SIZE_BYTES)
                    if not chunk:
                        break
                    total_bytes += len(chunk)
                    if total_bytes > MAX_RECORDING_SIZE_BYTES:
                        raise HTTPException(
                            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                            detail=(
                                f"Uploaded audio file exceeds maximum allowed limit of "
                                f"{MAX_RECORDING_SIZE_BYTES // (1024 * 1024)} MB"
                            ),
                        )
                    temp_file.write(chunk)

            if total_bytes == 0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Uploaded audio file is empty (0 bytes)",
                )

            # 3. Probe and validate media container and audio duration
            try:
                probe = cls.get_probe()
                meta = probe.probe(temp_path)
            except UnsupportedMediaError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Uploaded file does not contain valid audio streams: {exc}",
                ) from exc
            except MediaProbeError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid, corrupted, or unreadable audio file: {exc}",
                ) from exc
            except FFmpegNotFoundError as exc:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Audio validation failed: ffprobe executable not found on system PATH",
                ) from exc

            # 4. Determine verified file extension and MIME type
            ext, _ = cls._map_container_extension(meta.format_name)

            # 5. Determine duration (derived from audio packets; minimum 50ms)
            if meta.duration_s is not None and meta.duration_s > 0:
                duration_ms = int(round(meta.duration_s * 1000))
            elif client_duration_ms is not None and client_duration_ms > 0:
                duration_ms = client_duration_ms
            else:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Unable to determine valid audio duration from uploaded file",
                )

            if duration_ms < 50:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Recording duration ({duration_ms}ms) is too short (minimum 50ms required)",
                )

            # 6. Generate UUID and move file into final location
            rec_id = str(uuid.uuid4())
            target_file = (recordings_dir / f"{rec_id}{ext}").resolve()
            cls._validate_safe_path(target_file, project_id)

            shutil.move(str(temp_path), str(target_file))

        except Exception:
            # Clean up temp file on any failure
            if temp_path.is_file():
                temp_path.unlink(missing_ok=True)
            raise

        # 7. Atomic SQLite transaction: calculate take_number, deactivate siblings, insert take
        try:
            async with cls._take_lock:
                # Determine next sequential take number
                max_take_stmt = select(func.max(Recording.take_number)).where(
                    Recording.segment_id == segment_id
                )
                max_take = (await session.execute(max_take_stmt)).scalar_one_or_none()
                take_number = (max_take or 0) + 1

                # Deactivate any existing active takes for this segment
                await session.execute(
                    update(Recording)
                    .where(Recording.segment_id == segment_id)
                    .values(is_active=False)
                )

                new_recording = Recording(
                    id=rec_id,
                    segment_id=segment_id,
                    audio_file_path=settings.to_relative_path(target_file),
                    duration_ms=duration_ms,
                    take_number=take_number,
                    is_active=True,
                )
                session.add(new_recording)
                await session.commit()
                await session.refresh(new_recording)

            return RecordingRead.model_validate(new_recording)

        except Exception:
            await session.rollback()
            if target_file.is_file():
                target_file.unlink(missing_ok=True)
            raise

    @classmethod
    async def list_recordings_for_segment(
        cls, session: AsyncSession, segment_id: str
    ) -> List[RecordingRead]:
        """Retrieve all recorded takes for a segment ordered by take_number ascending."""
        segment_id = validate_identifier(segment_id, "segment_id")
        segment = await session.get(Segment, segment_id)
        if not segment:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Segment '{segment_id}' not found",
            )

        stmt = (
            select(Recording)
            .where(Recording.segment_id == segment_id)
            .order_by(Recording.take_number.asc())
        )
        recordings = (await session.execute(stmt)).scalars().all()
        return [RecordingRead.model_validate(r) for r in recordings]

    @classmethod
    async def get_recording_audio_path(
        cls, session: AsyncSession, recording_id: str
    ) -> Path:
        """Resolve, validate, and return the physical audio file path for a recording."""
        recording_id = validate_identifier(recording_id, "recording_id")
        recording = await session.get(Recording, recording_id)
        if not recording:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Recording '{recording_id}' not found",
            )

        segment = await session.get(Segment, recording.segment_id)
        if not segment:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Associated segment for recording not found",
            )

        file_path = settings.resolve_media_path(recording.audio_file_path)
        cls._validate_safe_path(file_path, segment.project_id)

        if not file_path.is_file():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Recording audio file missing on disk",
            )

        return file_path

    @classmethod
    async def set_active_take(
        cls, session: AsyncSession, recording_id: str
    ) -> RecordingRead:
        """Designate a specific take as the active take for its segment, deactivating others."""
        recording_id = validate_identifier(recording_id, "recording_id")
        recording = await session.get(Recording, recording_id)
        if not recording:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Recording '{recording_id}' not found",
            )

        # Deactivate all sibling takes for this segment
        await session.execute(
            update(Recording)
            .where(Recording.segment_id == recording.segment_id)
            .values(is_active=False)
        )
        recording.is_active = True
        await session.commit()
        await session.refresh(recording)

        return RecordingRead.model_validate(recording)

    @classmethod
    async def delete_recording(
        cls, session: AsyncSession, recording_id: str
    ) -> None:
        """Delete an individual recording from SQLite and unlink its audio file on disk.

        If the deleted take was active, designates the most recent remaining take (highest take_number)
        as active; if no takes remain, leaves no active take.
        """
        recording_id = validate_identifier(recording_id, "recording_id")
        recording = await session.get(Recording, recording_id)
        if not recording:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Recording '{recording_id}' not found",
            )

        segment_id = recording.segment_id
        was_active = recording.is_active
        audio_file_rel = recording.audio_file_path

        # Resolve project_id to validate safe path
        segment = await session.get(Segment, segment_id)
        project_id = segment.project_id if segment else None

        # 1. Resolve and validate safe file path
        file_path = settings.resolve_media_path(audio_file_rel)
        if project_id:
            cls._validate_safe_path(file_path, project_id)

        # 2. Unlink physical file first before committing DB changes.
        # If file deletion fails (e.g. PermissionError / OSError), raise HTTP 500 before committing.
        if file_path.is_file():
            try:
                file_path.unlink()
            except OSError as exc:
                await session.rollback()
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Failed to delete recording audio file from disk: {exc}",
                ) from exc

        # 3. Delete database record
        await session.delete(recording)

        # 4. If deleted take was active, promote the most recent remaining take
        if was_active:
            fallback_stmt = (
                select(Recording)
                .where(Recording.segment_id == segment_id, Recording.id != recording_id)
                .order_by(Recording.take_number.desc())
                .limit(1)
            )
            fallback_take = (await session.execute(fallback_stmt)).scalar_one_or_none()
            if fallback_take:
                fallback_take.is_active = True

        await session.commit()

    @classmethod
    async def delete_recordings_for_segment(
        cls, session: AsyncSession, segment_id: str
    ) -> None:
        """Unlink all physical audio takes belonging to a segment before deletion."""
        stmt = select(Recording).where(Recording.segment_id == segment_id)
        recordings = (await session.execute(stmt)).scalars().all()

        segment = await session.get(Segment, segment_id)
        project_id = segment.project_id if segment else None

        for rec in recordings:
            file_path = settings.resolve_media_path(rec.audio_file_path)
            if file_path.is_file():
                if project_id:
                    cls._validate_safe_path(file_path, project_id)
                file_path.unlink(missing_ok=True)
            await session.delete(rec)

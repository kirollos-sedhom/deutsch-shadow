"""Project management and media import API routes."""

from __future__ import annotations
from typing import List, Optional
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.session import get_db, AsyncSessionLocal
from backend.app.db.models import Project
from backend.app.schemas.project import (
    ProjectDetail,
    ProjectImportResponse,
    ProjectSummary,
)
from backend.app.schemas.segment import SegmentRead
from backend.app.services.project_service import ProjectService
from backend.app.services.segment_service import SegmentService


router = APIRouter(prefix="/projects", tags=["Projects"])


async def run_pipeline_in_background(project_id: str):
    """Background task to run the audio pipeline for an imported project."""
    async with AsyncSessionLocal() as session:
        try:
            await ProjectService.process_project_pipeline(session, project_id)
        except Exception:
            # Error status is already saved in database by process_project_pipeline
            pass


@router.get(
    "",
    response_model=List[ProjectSummary],
    status_code=status.HTTP_200_OK,
    summary="List all projects with metadata and segment counts",
)
async def list_projects(
    session: AsyncSession = Depends(get_db),
) -> List[ProjectSummary]:
    """Retrieve all projects sorted chronologically with active segment tallies."""
    return await ProjectService.list_projects(session)


@router.post(
    "/import",
    response_model=ProjectImportResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Import German audio or video media and trigger processing",
)
async def import_project(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    whisper_model: Optional[str] = Form("base"),
    auto_process: bool = Form(True),
    session: AsyncSession = Depends(get_db),
) -> ProjectImportResponse:
    """Upload media file, store it locally, and start background transcription/segmentation."""
    project = await ProjectService.import_project(
        session=session,
        file=file,
        title=title,
        whisper_model=whisper_model,
    )

    if auto_process:
        background_tasks.add_task(run_pipeline_in_background, project.id)

    return ProjectImportResponse(
        project_id=project.id,
        title=project.title,
        status=project.status,
        message="Project media imported successfully. Pipeline processing initiated.",
    )


@router.get(
    "/{project_id}",
    response_model=ProjectDetail,
    status_code=status.HTTP_200_OK,
    summary="Retrieve project detail by ID",
)
async def get_project(
    project_id: str,
    session: AsyncSession = Depends(get_db),
) -> ProjectDetail:
    """Fetch project details, settings, and processing state."""
    return await ProjectService.get_project_detail(session, project_id)


@router.post(
    "/{project_id}/process",
    response_model=ProjectDetail,
    status_code=status.HTTP_200_OK,
    summary="Run or retry audio processing pipeline asynchronously",
)
async def process_project(
    project_id: str,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
) -> ProjectDetail:
    """Trigger background audio processing/retry pipeline and return current project detail promptly."""
    project = await session.get(Project, project_id)
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Project '{project_id}' not found",
        )

    # Duplicate job protection: do not spin up a second pipeline if already processing
    if project.status == "processing":
        return await ProjectService.get_project_detail(session, project_id)

    # Set status to processing and clear previous error
    project.status = "processing"
    project.error_message = None
    await session.commit()

    # Queue pipeline execution in background
    background_tasks.add_task(run_pipeline_in_background, project.id)

    return await ProjectService.get_project_detail(session, project_id)


@router.delete(
    "/{project_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a project, cascading to its segments, recordings, and media on disk",
)
async def delete_project(
    project_id: str,
    session: AsyncSession = Depends(get_db),
) -> None:
    """Cascade delete the project from SQLite and erase all related files on disk."""
    await ProjectService.delete_project(session, project_id)


@router.get(
    "/{project_id}/segments",
    response_model=List[SegmentRead],
    status_code=status.HTTP_200_OK,
    summary="List all practice speech segments for a project",
)
async def get_project_segments(
    project_id: str,
    session: AsyncSession = Depends(get_db),
) -> List[SegmentRead]:
    """Retrieve all practice segments for a project, sorted in playback sequence order."""
    return await SegmentService.get_segments_by_project(session, project_id)

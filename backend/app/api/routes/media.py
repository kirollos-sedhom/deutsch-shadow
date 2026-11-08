"""Media streaming API routes supporting HTTP 206 Partial Content byte ranges."""

from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.config import settings
from backend.app.core.security import validate_identifier
from backend.app.db.models import Project
from backend.app.db.session import get_db
from backend.app.services.media_service import create_range_streaming_response


router = APIRouter(prefix="/media", tags=["Media"])


@router.get(
    "/{project_id}/master",
    summary="Stream project master audio supporting HTTP Range requests",
)
async def stream_project_master_audio(
    project_id: str,
    request: Request,
    session: AsyncSession = Depends(get_db),
):
    """Serve the master audio file for a project using standard byte-range responses (HTTP 206)."""
    project_id = validate_identifier(project_id, "project_id")
    project = await session.get(Project, project_id)
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Project '{project_id}' not found",
        )

    if not project.master_audio_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Project '{project_id}' does not have a processed master audio file yet (status: {project.status})",
        )

    file_path = settings.resolve_media_path(project.master_audio_path)
    if not file_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Audio file missing on disk: {file_path}",
        )

    return create_range_streaming_response(file_path, request)

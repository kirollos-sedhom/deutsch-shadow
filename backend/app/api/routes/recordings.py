"""User microphone recordings API routes."""

from __future__ import annotations
from typing import List, Optional

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Request,
    UploadFile,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.session import get_db
from backend.app.schemas.segment import RecordingRead
from backend.app.services.media_service import create_range_streaming_response
from backend.app.services.recording_service import RecordingService

router = APIRouter(tags=["Recordings"])


@router.post(
    "/segments/{segment_id}/recordings",
    response_model=RecordingRead,
    status_code=status.HTTP_201_CREATED,
    summary="Upload and persist a new user vocal recording take for a segment",
)
async def create_recording(
    segment_id: str,
    file: UploadFile = File(...),
    duration_ms: Optional[int] = Form(None),
    session: AsyncSession = Depends(get_db),
) -> RecordingRead:
    """Validate audio container, derive duration, store file safely, and insert Recording record."""
    return await RecordingService.create_recording(
        session=session,
        segment_id=segment_id,
        upload_file=file,
        client_duration_ms=duration_ms,
    )


@router.get(
    "/segments/{segment_id}/recordings",
    response_model=List[RecordingRead],
    status_code=status.HTTP_200_OK,
    summary="List all recorded takes for a segment ordered by take number",
)
async def list_recordings(
    segment_id: str,
    session: AsyncSession = Depends(get_db),
) -> List[RecordingRead]:
    """Retrieve all takes for a segment."""
    return await RecordingService.list_recordings_for_segment(session, segment_id)


@router.get(
    "/recordings/{recording_id}/audio",
    summary="Stream user recorded audio take supporting HTTP Range requests",
)
async def stream_recording_audio(
    recording_id: str,
    request: Request,
    session: AsyncSession = Depends(get_db),
):
    """Serve user recording audio file using standard byte-range responses (HTTP 206)."""
    file_path = await RecordingService.get_recording_audio_path(session, recording_id)
    return create_range_streaming_response(file_path, request)


@router.patch(
    "/recordings/{recording_id}/active",
    response_model=RecordingRead,
    status_code=status.HTTP_200_OK,
    summary="Designate a take as active for its segment",
)
async def set_active_take(
    recording_id: str,
    session: AsyncSession = Depends(get_db),
) -> RecordingRead:
    """Activate this take and deactivate all other takes for the same segment."""
    return await RecordingService.set_active_take(session, recording_id)


@router.delete(
    "/recordings/{recording_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a recording take and unlink its audio file from disk",
)
async def delete_recording(
    recording_id: str,
    session: AsyncSession = Depends(get_db),
) -> None:
    """Delete a recording take. If active, automatically promotes the latest remaining take."""
    await RecordingService.delete_recording(session, recording_id)

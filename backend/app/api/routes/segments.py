"""Segment editing, boundary modification, split, and merge API routes."""

from __future__ import annotations
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.session import get_db
from backend.app.schemas.segment import (
    SegmentMergeRequest,
    SegmentMergeResponse,
    SegmentRead,
    SegmentSplitRequest,
    SegmentSplitResponse,
    SegmentUpdate,
)
from backend.app.services.segment_service import SegmentService


router = APIRouter(prefix="/segments", tags=["Segments"])


@router.patch(
    "/{segment_id}",
    response_model=SegmentRead,
    status_code=status.HTTP_200_OK,
    summary="Update segment transcript text or adjust start/end boundaries",
)
async def update_segment(
    segment_id: str,
    payload: SegmentUpdate,
    session: AsyncSession = Depends(get_db),
) -> SegmentRead:
    """Update transcript text or boundary timestamps while validating boundaries and marking is_edited=True."""
    return await SegmentService.update_segment(session, segment_id, payload)


@router.post(
    "/{segment_id}/split",
    response_model=SegmentSplitResponse,
    status_code=status.HTTP_200_OK,
    summary="Split an existing segment into two contiguous segments",
)
async def split_segment(
    segment_id: str,
    payload: SegmentSplitRequest,
    session: AsyncSession = Depends(get_db),
) -> SegmentSplitResponse:
    """Split a segment at a millisecond boundary, shifting subsequent sequence indices atomically."""
    return await SegmentService.split_segment(
        session=session,
        segment_id=segment_id,
        split_time_ms=payload.split_time_ms,
        first_text=payload.first_text,
        second_text=payload.second_text,
    )


@router.post(
    "/{segment_id}/merge",
    response_model=SegmentMergeResponse,
    status_code=status.HTTP_200_OK,
    summary="Merge an existing segment with its preceding or following neighbor",
)
async def merge_segment(
    segment_id: str,
    payload: SegmentMergeRequest,
    session: AsyncSession = Depends(get_db),
) -> SegmentMergeResponse:
    """Merge segment with its neighbor, unifying transcript text and timestamps, and shifting indices."""
    return await SegmentService.merge_segment(
        session=session,
        segment_id=segment_id,
        direction=payload.direction,
    )

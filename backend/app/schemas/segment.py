"""Pydantic schemas for Segment models, boundary adjustments, split, and merge operations."""

from __future__ import annotations
from datetime import datetime
from typing import List, Optional, Literal
from pydantic import BaseModel, Field, ConfigDict


class RecordingRead(BaseModel):
    """User recording representation."""
    model_config = ConfigDict(from_attributes=True)

    id: str
    duration_ms: int
    take_number: int
    is_active: bool
    created_at: datetime


class SegmentRead(BaseModel):
    """Detailed segment representation for shadowing player and editor."""
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    sequence_index: int
    start_time_ms: int
    end_time_ms: int
    duration_ms: int
    text: str
    raw_transcript: str
    is_edited: bool
    recordings_count: int = 0
    created_at: datetime
    updated_at: datetime


class SegmentUpdate(BaseModel):
    """Payload for updating transcript text or nudging boundary timestamps."""
    text: Optional[str] = None
    start_time_ms: Optional[int] = Field(default=None, ge=0)
    end_time_ms: Optional[int] = Field(default=None, ge=0)


class SegmentSplitRequest(BaseModel):
    """Payload for splitting an existing segment into two contiguous segments."""
    split_time_ms: int = Field(..., description="Timestamp in milliseconds where the split occurs")
    first_text: Optional[str] = Field(default=None, description="Optional edited text for the first half")
    second_text: Optional[str] = Field(default=None, description="Optional edited text for the second half")


class SegmentSplitResponse(BaseModel):
    """Response containing both segments after a split."""
    first_segment: SegmentRead
    second_segment: SegmentRead


class SegmentMergeRequest(BaseModel):
    """Payload for merging an existing segment with its neighbor."""
    direction: Literal["next", "previous"] = Field(
        ..., description="Direction of neighbor segment to merge with"
    )


class SegmentMergeResponse(BaseModel):
    """Response containing the unified merged segment."""
    merged_segment: SegmentRead

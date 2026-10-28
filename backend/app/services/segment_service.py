"""Segment management service handling editing, boundary validation, splitting, and merging."""

from __future__ import annotations
import math
from typing import List, Optional

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.db.models import Project, Recording, Segment
from backend.app.schemas.segment import (
    SegmentMergeResponse,
    SegmentRead,
    SegmentSplitResponse,
    SegmentUpdate,
)
from backend.app.services.recording_service import RecordingService


class SegmentService:
    """Manages practice speech segments, user edits, non-destructive splits, and merges."""

    @classmethod
    async def get_segments_by_project(
        cls, session: AsyncSession, project_id: str
    ) -> List[SegmentRead]:
        """Fetch all segments for a project ordered by sequence_index."""
        stmt = (
            select(
                Segment,
                func.count(Recording.id).label("recordings_count"),
            )
            .outerjoin(Recording, Segment.id == Recording.segment_id)
            .where(Segment.project_id == project_id)
            .group_by(Segment.id)
            .order_by(Segment.sequence_index.asc())
        )
        result = await session.execute(stmt)
        rows = result.all()

        return [
            SegmentRead(
                id=seg.id,
                project_id=seg.project_id,
                sequence_index=seg.sequence_index,
                start_time_ms=seg.start_time_ms,
                end_time_ms=seg.end_time_ms,
                duration_ms=seg.duration_ms,
                text=seg.text,
                raw_transcript=seg.raw_transcript,
                is_edited=seg.is_edited,
                recordings_count=rec_count,
                created_at=seg.created_at,
                updated_at=seg.updated_at,
            )
            for seg, rec_count in rows
        ]

    @classmethod
    async def update_segment(
        cls, session: AsyncSession, segment_id: str, payload: SegmentUpdate
    ) -> SegmentRead:
        """Update segment text or boundaries while preserving consistency."""
        segment = await session.get(Segment, segment_id)
        if not segment:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Segment not found")

        is_modified = False

        if payload.text is not None:
            new_text = payload.text.strip()
            if not new_text:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Segment text cannot be empty or whitespace only",
                )
            if new_text != segment.text:
                segment.text = new_text
                is_modified = True

        # Check boundary changes: only validate boundaries if submitted in payload
        if payload.start_time_ms is not None or payload.end_time_ms is not None:
            new_start = (
                payload.start_time_ms
                if payload.start_time_ms is not None
                else segment.start_time_ms
            )
            new_end = (
                payload.end_time_ms
                if payload.end_time_ms is not None
                else segment.end_time_ms
            )

            if new_start != segment.start_time_ms or new_end != segment.end_time_ms:
                if new_start < 0:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Invalid segment bounds: start_time_ms ({new_start}) cannot be negative",
                    )
                if (new_end - new_start) < 100:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Invalid segment bounds: duration ({new_end - new_start}ms) must be at least 100ms",
                    )

                # Validate no overlap with previous segment (touching is permitted: new_start == prev_seg.end_time_ms)
                prev_stmt = select(Segment).where(
                    Segment.project_id == segment.project_id,
                    Segment.sequence_index == segment.sequence_index - 1,
                )
                prev_seg = (await session.execute(prev_stmt)).scalar_one_or_none()
                if prev_seg and new_start < prev_seg.end_time_ms:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=(
                            f"Invalid segment bounds: start_time_ms ({new_start}ms) overlaps with "
                            f"previous segment #{prev_seg.sequence_index} end ({prev_seg.end_time_ms}ms)"
                        ),
                    )

                # Validate no overlap with next segment (touching is permitted: new_end == next_seg.start_time_ms)
                next_stmt = select(Segment).where(
                    Segment.project_id == segment.project_id,
                    Segment.sequence_index == segment.sequence_index + 1,
                )
                next_seg = (await session.execute(next_stmt)).scalar_one_or_none()
                if next_seg and new_end > next_seg.start_time_ms:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=(
                            f"Invalid segment bounds: end_time_ms ({new_end}ms) overlaps with "
                            f"next segment #{next_seg.sequence_index} start ({next_seg.start_time_ms}ms)"
                        ),
                    )

                # If this is the terminal segment, validate against media duration ceiling
                if not next_seg:
                    proj = await session.get(Project, segment.project_id)
                    if proj and proj.duration_seconds and proj.duration_seconds > 0:
                        max_allowed_ms = math.ceil(proj.duration_seconds * 1000)
                        if new_end > max_allowed_ms:
                            raise HTTPException(
                                status_code=status.HTTP_400_BAD_REQUEST,
                                detail=(
                                    f"Invalid segment bounds: end_time_ms ({new_end}ms) cannot "
                                    f"exceed total media duration ({max_allowed_ms}ms)"
                                ),
                            )

                segment.start_time_ms = new_start
                segment.end_time_ms = new_end
                is_modified = True

        if is_modified:
            segment.is_edited = True
            await session.commit()
            await session.refresh(segment)

        # Get recordings count
        rec_count_stmt = select(func.count(Recording.id)).where(Recording.segment_id == segment.id)
        rec_count_res = await session.execute(rec_count_stmt)
        rec_count = rec_count_res.scalar_one_or_none() or 0

        return SegmentRead(
            id=segment.id,
            project_id=segment.project_id,
            sequence_index=segment.sequence_index,
            start_time_ms=segment.start_time_ms,
            end_time_ms=segment.end_time_ms,
            duration_ms=segment.duration_ms,
            text=segment.text,
            raw_transcript=segment.raw_transcript,
            is_edited=segment.is_edited,
            recordings_count=rec_count,
            created_at=segment.created_at,
            updated_at=segment.updated_at,
        )

    @classmethod
    async def split_segment(
        cls,
        session: AsyncSession,
        segment_id: str,
        split_time_ms: int,
        first_text: Optional[str] = None,
        second_text: Optional[str] = None,
    ) -> SegmentSplitResponse:
        """Split a segment into two contiguous segments at split_time_ms."""
        seg = await session.get(Segment, segment_id)
        if not seg:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Segment not found")

        if not (seg.start_time_ms < split_time_ms < seg.end_time_ms):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"split_time_ms ({split_time_ms}) must fall strictly between "
                    f"segment start ({seg.start_time_ms}ms) and end ({seg.end_time_ms}ms)"
                ),
            )

        original_end = seg.end_time_ms
        original_seq = seg.sequence_index
        project_id = seg.project_id

        # Step 1: Shift subsequent segments up by 1 to make room for the new segment
        # We do this from highest to lowest index to avoid collisions
        subsequent_stmt = (
            select(Segment)
            .where(Segment.project_id == project_id, Segment.sequence_index > original_seq)
            .order_by(Segment.sequence_index.desc())
        )
        subsequent_segs = (await session.execute(subsequent_stmt)).scalars().all()
        for s in subsequent_segs:
            s.sequence_index += 1

        # Step 2: Truncate the first segment at split_time_ms
        seg.end_time_ms = split_time_ms
        if first_text is not None:
            seg.text = first_text.strip()
        seg.is_edited = True

        # Step 3: Create the new second segment
        new_text = second_text.strip() if second_text is not None else seg.text
        new_seg = Segment(
            project_id=project_id,
            sequence_index=original_seq + 1,
            start_time_ms=split_time_ms,
            end_time_ms=original_end,
            text=new_text,
            raw_transcript=seg.raw_transcript,
            is_edited=True,
        )
        session.add(new_seg)

        await session.commit()
        await session.refresh(seg)
        await session.refresh(new_seg)

        first_read = SegmentRead(
            id=seg.id,
            project_id=seg.project_id,
            sequence_index=seg.sequence_index,
            start_time_ms=seg.start_time_ms,
            end_time_ms=seg.end_time_ms,
            duration_ms=seg.duration_ms,
            text=seg.text,
            raw_transcript=seg.raw_transcript,
            is_edited=seg.is_edited,
            recordings_count=0,
            created_at=seg.created_at,
            updated_at=seg.updated_at,
        )
        second_read = SegmentRead(
            id=new_seg.id,
            project_id=new_seg.project_id,
            sequence_index=new_seg.sequence_index,
            start_time_ms=new_seg.start_time_ms,
            end_time_ms=new_seg.end_time_ms,
            duration_ms=new_seg.duration_ms,
            text=new_seg.text,
            raw_transcript=new_seg.raw_transcript,
            is_edited=new_seg.is_edited,
            recordings_count=0,
            created_at=new_seg.created_at,
            updated_at=new_seg.updated_at,
        )
        return SegmentSplitResponse(first_segment=first_read, second_segment=second_read)

    @classmethod
    async def merge_segment(
        cls, session: AsyncSession, segment_id: str, direction: str
    ) -> SegmentMergeResponse:
        """Merge a segment with its neighboring segment ('next' or 'previous')."""
        seg = await session.get(Segment, segment_id)
        if not seg:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Segment not found")

        project_id = seg.project_id
        target_seq = (
            seg.sequence_index + 1 if direction == "next" else seg.sequence_index - 1
        )

        neighbor_stmt = select(Segment).where(
            Segment.project_id == project_id, Segment.sequence_index == target_seq
        )
        neighbor = (await session.execute(neighbor_stmt)).scalar_one_or_none()

        if not neighbor:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot merge: no {direction} neighbor segment exists (current sequence {seg.sequence_index})",
            )

        # Determine primary segment and segment to be absorbed
        if direction == "next":
            primary = seg
            absorbed = neighbor
            combined_text = f"{seg.text} {neighbor.text}".strip()
            combined_raw = f"{seg.raw_transcript} {neighbor.raw_transcript}".strip()
            primary.start_time_ms = min(seg.start_time_ms, neighbor.start_time_ms)
            primary.end_time_ms = max(seg.end_time_ms, neighbor.end_time_ms)
            primary.text = combined_text
            primary.raw_transcript = combined_raw
            primary.is_edited = True
            absorbed_seq = absorbed.sequence_index
            await RecordingService.delete_recordings_for_segment(session, absorbed.id)
            await session.delete(absorbed)
        else:
            primary = neighbor
            absorbed = seg
            combined_text = f"{neighbor.text} {seg.text}".strip()
            combined_raw = f"{neighbor.raw_transcript} {seg.raw_transcript}".strip()
            primary.start_time_ms = min(neighbor.start_time_ms, seg.start_time_ms)
            primary.end_time_ms = max(neighbor.end_time_ms, seg.end_time_ms)
            primary.text = combined_text
            primary.raw_transcript = combined_raw
            primary.is_edited = True
            absorbed_seq = absorbed.sequence_index
            await RecordingService.delete_recordings_for_segment(session, absorbed.id)
            await session.delete(absorbed)

        await session.flush()

        # Shift all segments with sequence_index > absorbed_seq down by 1
        subsequent_stmt = (
            select(Segment)
            .where(Segment.project_id == project_id, Segment.sequence_index > absorbed_seq)
            .order_by(Segment.sequence_index.asc())
        )
        subsequent_segs = (await session.execute(subsequent_stmt)).scalars().all()
        for s in subsequent_segs:
            s.sequence_index -= 1

        await session.commit()
        await session.refresh(primary)

        merged_read = SegmentRead(
            id=primary.id,
            project_id=primary.project_id,
            sequence_index=primary.sequence_index,
            start_time_ms=primary.start_time_ms,
            end_time_ms=primary.end_time_ms,
            duration_ms=primary.duration_ms,
            text=primary.text,
            raw_transcript=primary.raw_transcript,
            is_edited=primary.is_edited,
            recordings_count=0,
            created_at=primary.created_at,
            updated_at=primary.updated_at,
        )
        return SegmentMergeResponse(merged_segment=merged_read)

"""SQLAlchemy ORM models defining the relational database schema."""

from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base


def generate_uuid() -> str:
    """Generate a standard UUID4 hex string."""
    return str(uuid.uuid4())


def utc_now() -> datetime:
    """Return timezone-aware current UTC datetime."""
    return datetime.now(timezone.utc)


class Project(Base):
    """Represents an imported German media item and its listening/shadowing workspace."""

    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    media_type: Mapped[str] = mapped_column(String(50), nullable=False)  # "audio" or "video"
    source_file_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    master_audio_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    duration_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    whisper_model: Mapped[str] = mapped_column(String(50), default="base")
    status: Mapped[str] = mapped_column(
        String(50), default="pending"
    )  # "pending", "processing", "ready", "failed"
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    # Relationships
    segments: Mapped[List[Segment]] = relationship(
        "Segment",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="Segment.sequence_index",
    )
    settings: Mapped[Optional[ProjectSettings]] = relationship(
        "ProjectSettings",
        back_populates="project",
        uselist=False,
        cascade="all, delete-orphan",
    )

    def __repr__(self) -> str:
        return f"<Project id={self.id} title={self.title!r} status={self.status!r}>"


class Segment(Base):
    """An individual, bounded practice speech segment extracted from the master audio."""

    __tablename__ = "segments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sequence_index: Mapped[int] = mapped_column(Integer, nullable=False)
    start_time_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_time_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    raw_transcript: Mapped[str] = mapped_column(Text, nullable=False)
    is_edited: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    # Indexes
    __table_args__ = (
        Index("idx_segments_project_sequence", "project_id", "sequence_index"),
    )

    # Relationships
    project: Mapped[Project] = relationship("Project", back_populates="segments")
    recordings: Mapped[List[Recording]] = relationship(
        "Recording",
        back_populates="segment",
        cascade="all, delete-orphan",
        order_by="Recording.take_number",
    )

    @property
    def duration_ms(self) -> int:
        return max(0, self.end_time_ms - self.start_time_ms)

    def __repr__(self) -> str:
        return (
            f"<Segment id={self.id} seq={self.sequence_index} "
            f"range={self.start_time_ms}..{self.end_time_ms}>"
        )


class Recording(Base):
    """A user vocal recording take for an individual speech segment."""

    __tablename__ = "recordings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    segment_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("segments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    audio_file_path: Mapped[str] = mapped_column(String(512), nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    take_number: Mapped[int] = mapped_column(Integer, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    # Relationships
    segment: Mapped[Segment] = relationship("Segment", back_populates="recordings")

    def __repr__(self) -> str:
        return f"<Recording id={self.id} take={self.take_number} segment_id={self.segment_id}>"


class ProjectSettings(Base):
    """User-customized practice and playback settings for a project."""

    __tablename__ = "project_settings"

    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    playback_speed: Mapped[float] = mapped_column(Float, default=1.0)
    auto_pause_multiplier: Mapped[float] = mapped_column(Float, default=1.2)
    blind_mode_default: Mapped[bool] = mapped_column(Boolean, default=True)

    # Relationships
    project: Mapped[Project] = relationship("Project", back_populates="settings")

    def __repr__(self) -> str:
        return f"<ProjectSettings project_id={self.project_id} speed={self.playback_speed}>"

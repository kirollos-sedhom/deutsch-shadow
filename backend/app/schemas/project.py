"""Pydantic schemas for Project models and import payloads."""

from __future__ import annotations
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field, ConfigDict


class ProjectSettingsRead(BaseModel):
    """Practice settings representation."""
    model_config = ConfigDict(from_attributes=True)

    playback_speed: float = 1.0
    auto_pause_multiplier: float = 1.2
    blind_mode_default: bool = True


class ProjectSettingsUpdate(BaseModel):
    """Optional settings update payload."""
    playback_speed: Optional[float] = Field(default=None, ge=0.25, le=2.0)
    auto_pause_multiplier: Optional[float] = Field(default=None, ge=0.5, le=5.0)
    blind_mode_default: Optional[bool] = None


class ProjectSummary(BaseModel):
    """Compact summary of a project for list views."""
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    original_filename: str
    media_type: str
    duration_seconds: float
    whisper_model: str
    status: str
    error_message: Optional[str] = None
    segments_count: int = 0
    created_at: datetime
    updated_at: datetime


class ProjectDetail(BaseModel):
    """Full project detail including settings and metadata."""
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    original_filename: str
    media_type: str
    source_file_path: Optional[str] = None
    master_audio_path: Optional[str] = None
    duration_seconds: float
    whisper_model: str
    status: str
    error_message: Optional[str] = None
    segments_count: int = 0
    settings: Optional[ProjectSettingsRead] = None
    created_at: datetime
    updated_at: datetime


class ProjectImportResponse(BaseModel):
    """Response returned upon importing/creating a project."""
    project_id: str
    title: str
    status: str
    message: str
    whisper_model: str = "base"

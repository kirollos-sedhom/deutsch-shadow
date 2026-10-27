"""Pydantic schemas for hardware capabilities and Whisper models."""

from __future__ import annotations
from typing import List, Optional
from pydantic import BaseModel, ConfigDict


class SystemCapabilities(BaseModel):
    """Host machine hardware specification and environment audit."""
    model_config = ConfigDict(from_attributes=True)

    cpu_physical_cores: int
    cpu_logical_cores: int
    ram_total_gb: float
    cuda_available: bool
    cuda_device_name: Optional[str] = None
    ffmpeg_available: bool
    ffmpeg_path: Optional[str] = None
    ffmpeg_version: Optional[str] = None
    recommended_model: str


class WhisperModelTier(BaseModel):
    """Information regarding a supported or downloaded Whisper model tier."""
    model_config = ConfigDict(from_attributes=True)

    name: str
    size_mb: float
    description: str
    is_downloaded: bool
    is_recommended: bool

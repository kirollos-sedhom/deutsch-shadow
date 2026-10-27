"""System and hardware inspection API routes."""

from __future__ import annotations
from typing import List
from fastapi import APIRouter, status

from backend.app.schemas.system import SystemCapabilities, WhisperModelTier
from backend.app.services.system_service import get_model_tiers, get_system_capabilities


router = APIRouter(prefix="/system", tags=["System"])


@router.get(
    "/capabilities",
    response_model=SystemCapabilities,
    status_code=status.HTTP_200_OK,
    summary="Query hardware capabilities and environment audit",
)
async def query_capabilities() -> SystemCapabilities:
    """Return CPU cores, RAM, CUDA availability, FFmpeg status, and recommended model."""
    return get_system_capabilities()


@router.get(
    "/models",
    response_model=List[WhisperModelTier],
    status_code=status.HTTP_200_OK,
    summary="List supported faster-whisper model tiers",
)
async def query_models() -> List[WhisperModelTier]:
    """Return available Whisper model tiers with size and recommended status."""
    return get_model_tiers()

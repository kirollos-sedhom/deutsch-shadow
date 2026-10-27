"""Audio processing package for Deutsch Shadow."""

from backend.app.audio.models import (
    AudioStreamInfo,
    MediaMetadata,
    Word,
    RawTranscriptionSegment,
    TranscriptionResult,
    PracticeSegment,
    SegmentationConfig,
    WhisperConfig,
    PipelineResult,
)
from backend.app.audio.exceptions import (
    AudioProcessingError,
    FFmpegNotFoundError,
    MediaProbeError,
    UnsupportedMediaError,
    MediaConversionError,
    TranscriberError,
    TranscriberDependencyError,
    SegmentationError,
)
from backend.app.audio.media_probe import MediaProbe
from backend.app.audio.media_converter import MediaConverter
from backend.app.audio.transcriber import AudioTranscriber
from backend.app.audio.segmenter import GermanSegmenter
from backend.app.audio.pipeline import AudioPipeline

__all__ = [
    "AudioStreamInfo",
    "MediaMetadata",
    "Word",
    "RawTranscriptionSegment",
    "TranscriptionResult",
    "PracticeSegment",
    "SegmentationConfig",
    "WhisperConfig",
    "PipelineResult",
    "AudioProcessingError",
    "FFmpegNotFoundError",
    "MediaProbeError",
    "UnsupportedMediaError",
    "MediaConversionError",
    "TranscriberError",
    "TranscriberDependencyError",
    "SegmentationError",
    "MediaProbe",
    "MediaConverter",
    "AudioTranscriber",
    "GermanSegmenter",
    "AudioPipeline",
]

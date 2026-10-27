"""Custom exceptions for the audio processing pipeline."""

class AudioProcessingError(Exception):
    """Base exception for all audio processing pipeline errors."""
    pass


class FFmpegNotFoundError(AudioProcessingError):
    """Raised when FFmpeg or FFprobe executable is not found on the system."""
    pass


class MediaProbeError(AudioProcessingError):
    """Raised when media probing fails or returns unparseable metadata."""
    pass


class UnsupportedMediaError(AudioProcessingError):
    """Raised when the input file format or codec is not supported."""
    pass


class MediaConversionError(AudioProcessingError):
    """Raised when FFmpeg audio extraction or conversion fails."""
    pass


class TranscriberError(AudioProcessingError):
    """Raised when transcription inference fails."""
    pass


class TranscriberDependencyError(TranscriberError):
    """Raised when faster-whisper or required ML runtime dependencies are missing."""
    pass


class SegmentationError(AudioProcessingError):
    """Raised when speech segmentation encounters unrecoverable data anomalies."""
    pass

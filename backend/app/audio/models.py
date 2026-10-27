"""Data models and configuration classes for the Deutsch Shadow audio processing pipeline."""

from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import List, Optional, Dict, Any


@dataclass
class AudioStreamInfo:
    """Audio stream metadata extracted from media file."""
    codec_name: str
    sample_rate: int
    channels: int
    duration_s: float
    bit_rate: Optional[int] = None


@dataclass
class MediaMetadata:
    """High-level media container metadata."""
    file_path: str
    format_name: str
    duration_s: float
    size_bytes: int
    bit_rate: Optional[int] = None
    has_video: bool = False
    audio_streams: List[AudioStreamInfo] = field(default_factory=list)

    @property
    def primary_audio(self) -> Optional[AudioStreamInfo]:
        """Returns the primary audio stream if available."""
        return self.audio_streams[0] if self.audio_streams else None


@dataclass
class Word:
    """Individual recognized word with millisecond-aligned timestamps."""
    word: str
    start_s: float
    end_s: float
    probability: float = 1.0

    @property
    def start_ms(self) -> int:
        return int(round(self.start_s * 1000))

    @property
    def end_ms(self) -> int:
        return int(round(self.end_s * 1000))

    @property
    def duration_ms(self) -> int:
        return max(0, self.end_ms - self.start_ms)


@dataclass
class RawTranscriptionSegment:
    """Raw segment output directly from speech recognition engine."""
    id: int
    start_s: float
    end_s: float
    text: str
    words: List[Word] = field(default_factory=list)


@dataclass
class TranscriptionResult:
    """Overall transcription output."""
    language: str
    language_probability: float
    duration_s: float
    segments: List[RawTranscriptionSegment] = field(default_factory=list)
    all_words: List[Word] = field(default_factory=list)


@dataclass
class PracticeSegment:
    """A refined, deterministic segment ready for German listening and shadowing."""
    id: int
    sequence_index: int
    start_ms: int
    end_ms: int
    text: str
    duration_ms: int = 0
    words: List[Word] = field(default_factory=list)

    def __post_init__(self):
        if not self.duration_ms:
            self.duration_ms = max(0, self.end_ms - self.start_ms)

    @property
    def start_s(self) -> float:
        return self.start_ms / 1000.0

    @property
    def end_s(self) -> float:
        return self.end_ms / 1000.0


@dataclass
class SegmentationConfig:
    """Configurable parameters governing speech segmentation."""
    min_duration_s: float = 1.2
    max_duration_s: float = 7.0
    target_duration_s: float = 4.0
    pause_split_threshold_s: float = 0.6
    lead_in_padding_s: float = 0.08
    tail_out_padding_s: float = 0.08


@dataclass
class WhisperConfig:
    """Configurable parameters for the faster-whisper speech recognition engine."""
    model_size: str = "base"
    device: str = "cpu"
    compute_type: str = "int8"
    cpu_threads: int = 4
    language: str = "de"
    download_root: Optional[str] = None


@dataclass
class PipelineResult:
    """Full result of the audio-processing pipeline."""
    source_file: str
    working_audio_file: str
    media_metadata: MediaMetadata
    whisper_config: WhisperConfig
    segmentation_config: SegmentationConfig
    transcription: TranscriptionResult
    practice_segments: List[PracticeSegment]

    @property
    def total_segments(self) -> int:
        return len(self.practice_segments)

    def to_dict(self) -> Dict[str, Any]:
        """Convert result to a JSON-serializable dictionary."""
        return asdict(self)

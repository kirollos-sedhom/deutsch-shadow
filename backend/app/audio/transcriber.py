"""Local German speech recognition using faster-whisper."""

from __future__ import annotations
import os
from pathlib import Path
from typing import Optional, List

from backend.app.audio.exceptions import (
    TranscriberError,
    TranscriberDependencyError,
)
from backend.app.audio.models import (
    WhisperConfig,
    Word,
    RawTranscriptionSegment,
    TranscriptionResult,
)


class AudioTranscriber:
    """Manages speech-to-text inference with faster-whisper (CTranslate2)."""

    def __init__(self, config: Optional[WhisperConfig] = None):
        """Initialize transcriber with configurable parameters."""
        self.config = config or WhisperConfig()
        self._model = None

    def _load_model(self):
        """Lazy load faster-whisper model only when needed."""
        if self._model is not None:
            return self._model

        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise TranscriberDependencyError(
                "faster-whisper is not installed in the active Python environment. "
                "To enable speech recognition, install it via: pip install faster-whisper"
            ) from exc

        try:
            self._model = WhisperModel(
                model_size_or_path=self.config.model_size,
                device=self.config.device,
                compute_type=self.config.compute_type,
                cpu_threads=self.config.cpu_threads,
                download_root=self.config.download_root,
            )
            return self._model
        except Exception as exc:
            raise TranscriberError(
                f"Failed to initialize faster-whisper model '{self.config.model_size}' "
                f"on {self.config.device} ({self.config.compute_type}): {exc}"
            ) from exc

    def transcribe(self, audio_file_path: str | Path) -> TranscriptionResult:
        """Transcribe audio file into word-level timestamps and raw segments.

        Args:
            audio_file_path: Path to the audio file (typically 16kHz mono WAV).

        Returns:
            TranscriptionResult containing raw segments and word-level timestamps.

        Raises:
            FileNotFoundError: If audio file does not exist.
            TranscriberError: If transcription fails.
        """
        path = Path(audio_file_path).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"Audio file for transcription not found: {path}")

        model = self._load_model()

        try:
            segments_gen, info = model.transcribe(
                str(path),
                language=self.config.language,
                task="transcribe",
                word_timestamps=True,
                vad_filter=True,
            )

            raw_segments: List[RawTranscriptionSegment] = []
            all_words: List[Word] = []

            for seg_idx, seg in enumerate(segments_gen):
                segment_words: List[Word] = []

                if seg.words:
                    for w in seg.words:
                        clean_word = w.word.strip()
                        if not clean_word:
                            continue
                        word_obj = Word(
                            word=clean_word,
                            start_s=float(w.start),
                            end_s=float(w.end),
                            probability=float(getattr(w, "probability", 1.0)),
                        )
                        segment_words.append(word_obj)
                        all_words.append(word_obj)
                else:
                    # Fallback if Whisper did not return word timestamps for this segment
                    text_words = seg.text.strip().split()
                    if text_words:
                        seg_dur = max(0.1, float(seg.end) - float(seg.start))
                        step = seg_dur / len(text_words)
                        for i, tw in enumerate(text_words):
                            w_start = float(seg.start) + (i * step)
                            w_end = w_start + step
                            word_obj = Word(
                                word=tw,
                                start_s=w_start,
                                end_s=w_end,
                                probability=1.0,
                            )
                            segment_words.append(word_obj)
                            all_words.append(word_obj)

                raw_segments.append(
                    RawTranscriptionSegment(
                        id=seg_idx,
                        start_s=float(seg.start),
                        end_s=float(seg.end),
                        text=seg.text.strip(),
                        words=segment_words,
                    )
                )

            return TranscriptionResult(
                language=info.language,
                language_probability=float(info.language_probability),
                duration_s=float(info.duration),
                segments=raw_segments,
                all_words=all_words,
            )

        except Exception as exc:
            if isinstance(exc, (TranscriberError, TranscriberDependencyError)):
                raise
            raise TranscriberError(f"Transcription failed during audio processing: {exc}") from exc

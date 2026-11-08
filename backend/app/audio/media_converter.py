"""Media extraction and standardization service using FFmpeg."""

from __future__ import annotations
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional, Tuple

from backend.app.audio.exceptions import (
    FFmpegNotFoundError,
    MediaConversionError,
)
from backend.app.audio.media_probe import MediaProbe
from backend.app.audio.models import MediaMetadata


class MediaConverter:
    """Safely extracts audio from media files and prepares standardized working copies."""

    def __init__(
        self,
        ffmpeg_path: Optional[str] = None,
        ffprobe_path: Optional[str] = None,
    ):
        """Initialize converter with FFmpeg executable paths."""
        resolved_ffmpeg = ffmpeg_path or shutil.which("ffmpeg")
        if not resolved_ffmpeg:
            raise FFmpegNotFoundError(
                "ffmpeg executable not found on system PATH. Please ensure FFmpeg is installed."
            )
        self.ffmpeg_path = resolved_ffmpeg
        self.probe = MediaProbe(ffprobe_path=ffprobe_path)

    def prepare_working_audio(
        self,
        source_file: str | Path,
        output_dir: str | Path,
        sample_rate: int = 16000,
    ) -> Tuple[MediaMetadata, Path]:
        """Inspect source media and create a standardized mono 16kHz WAV working copy for Whisper.

        The original source file is preserved untouched.

        Generated file purpose:
        - `whisper_working.wav`: 16-bit PCM, mono, 16kHz audio file required by faster-whisper
          to perform accurate, low-latency cross-attention word timestamp recognition without
          runtime resample overhead.

        Args:
            source_file: Path to imported audio or video file.
            output_dir: Directory where the standardized working copy should be placed.
            sample_rate: Target sample rate in Hz (default: 16000).

        Returns:
            Tuple of (source_metadata, working_wav_path).

        Raises:
            MediaConversionError: If FFmpeg fails to extract or convert the audio.
        """
        source_path = Path(source_file).resolve()
        metadata = self.probe.probe(source_path)

        out_dir = Path(output_dir).resolve()
        out_dir.mkdir(parents=True, exist_ok=True)

        # Working file strictly for transcription inference.
        # Use a distinct working filename if the input file itself is named whisper_working.wav
        # or resolves to the same path, preventing FFmpeg same-path exit code 234 collisions.
        working_filename = "whisper_working.wav"
        if source_path.name == working_filename or source_path.resolve() == (out_dir / working_filename).resolve():
            working_filename = "whisper_working_mono16k.wav"
        if source_path.resolve() == (out_dir / working_filename).resolve():
            working_filename = "whisper_working_transcription.wav"
        working_wav_path = out_dir / working_filename

        # FFmpeg command: extract audio stream, downmix to mono, resample to 16kHz PCM 16-bit
        cmd = [
            self.ffmpeg_path,
            "-y",  # Overwrite output if already exists in target dir
            "-i", str(source_path),
            "-vn",  # Exclude video stream
            "-acodec", "pcm_s16le",
            "-ac", "1",  # Mono
            "-ar", str(sample_rate),
            str(working_wav_path),
        ]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception as exc:
            raise MediaConversionError(
                f"Failed to execute FFmpeg for {source_path.name}: {exc}"
            ) from exc

        if result.returncode != 0:
            stderr = result.stderr.strip()
            raise MediaConversionError(
                f"FFmpeg failed to convert {source_path.name} (exit code {result.returncode}): {stderr}"
            )

        if not working_wav_path.is_file() or working_wav_path.stat().st_size == 0:
            raise MediaConversionError(
                f"FFmpeg produced an empty or missing output file: {working_wav_path}"
            )

        return metadata, working_wav_path

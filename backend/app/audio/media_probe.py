"""Media probing service using ffprobe."""

from __future__ import annotations
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from backend.app.audio.exceptions import (
    FFmpegNotFoundError,
    MediaProbeError,
    UnsupportedMediaError,
)
from backend.app.audio.models import AudioStreamInfo, MediaMetadata


class MediaProbe:
    """Inspects audio and video files using ffprobe to extract technical metadata."""

    def __init__(self, ffprobe_path: Optional[str] = None):
        """Initialize probe with ffprobe executable path or resolve from PATH."""
        resolved = ffprobe_path or shutil.which("ffprobe")
        if not resolved:
            raise FFmpegNotFoundError(
                "ffprobe executable not found on system PATH. Please ensure FFmpeg is installed."
            )
        self.ffprobe_path = resolved

    def probe(self, file_path: str | Path) -> MediaMetadata:
        """Probe media file and return structured MediaMetadata.

        Args:
            file_path: Path to the media file to inspect.

        Returns:
            MediaMetadata object containing stream and format details.

        Raises:
            FileNotFoundError: If the file does not exist.
            MediaProbeError: If probing fails or output cannot be parsed.
            UnsupportedMediaError: If the media file has no valid audio streams.
        """
        path = Path(file_path).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"Input media file not found: {path}")

        if path.stat().st_size == 0:
            raise MediaProbeError(f"Input media file is empty (0 bytes): {path}")

        cmd = [
            self.ffprobe_path,
            "-v", "error",
            "-show_entries", "format=format_name,duration,size,bit_rate",
            "-show_entries", "stream=index,codec_type,codec_name,sample_rate,channels,duration,bit_rate",
            "-of", "json",
            str(path),
        ]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception as exc:
            raise MediaProbeError(f"Failed to execute ffprobe: {exc}") from exc

        if result.returncode != 0:
            stderr = result.stderr.strip()
            raise MediaProbeError(f"ffprobe failed (exit code {result.returncode}): {stderr}")

        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise MediaProbeError(f"Failed to parse ffprobe JSON output: {exc}") from exc

        format_info = data.get("format", {})
        streams = data.get("streams", [])

        format_name = format_info.get("format_name", "unknown")
        duration_s = float(format_info.get("duration", 0.0))
        size_bytes = int(format_info.get("size", path.stat().st_size))
        bit_rate_raw = format_info.get("bit_rate")
        bit_rate = int(bit_rate_raw) if bit_rate_raw and bit_rate_raw.isdigit() else None

        audio_streams = []
        has_video = False

        for stream in streams:
            codec_type = stream.get("codec_type")
            if codec_type == "video":
                has_video = True
            elif codec_type == "audio":
                s_duration = float(stream.get("duration", duration_s))
                s_bitrate_raw = stream.get("bit_rate")
                s_bitrate = int(s_bitrate_raw) if s_bitrate_raw and str(s_bitrate_raw).isdigit() else None

                audio_streams.append(
                    AudioStreamInfo(
                        codec_name=stream.get("codec_name", "unknown"),
                        sample_rate=int(stream.get("sample_rate", 0)),
                        channels=int(stream.get("channels", 0)),
                        duration_s=s_duration,
                        bit_rate=s_bitrate,
                    )
                )

        if not audio_streams:
            raise UnsupportedMediaError(
                f"File '{path.name}' contains no readable audio streams."
            )

        return MediaMetadata(
            file_path=str(path),
            format_name=format_name,
            duration_s=duration_s,
            size_bytes=size_bytes,
            bit_rate=bit_rate,
            has_video=has_video,
            audio_streams=audio_streams,
        )

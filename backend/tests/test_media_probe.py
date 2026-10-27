"""Integration tests for media probing using synthetic audio files."""

import math
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from backend.app.audio.exceptions import (
    MediaProbeError,
    UnsupportedMediaError,
)
from backend.app.audio.media_probe import MediaProbe


def create_synthetic_wav(
    file_path: Path,
    duration_s: float = 1.0,
    sample_rate: int = 44100,
    num_channels: int = 1,
    frequency: float = 440.0,
) -> Path:
    """Generate a clean synthetic sine-wave WAV file using Python's standard wave library."""
    num_samples = int(duration_s * sample_rate)
    with wave.open(str(file_path), "wb") as wf:
        wf.setnchannels(num_channels)
        wf.setsampwidth(2)  # 16-bit PCM
        wf.setframerate(sample_rate)

        raw_frames = bytearray()
        for i in range(num_samples):
            value = int(16384.0 * math.sin(2.0 * math.pi * frequency * (i / sample_rate)))
            packed = struct.pack("<h", value)
            for _ in range(num_channels):
                raw_frames.extend(packed)
        wf.writeframes(raw_frames)
    return file_path


class TestMediaProbe(unittest.TestCase):
    """Test suite for MediaProbe functionality."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.probe = MediaProbe()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_probe_valid_synthetic_audio(self):
        """Probing a valid synthetic WAV file must yield correct audio stream metadata."""
        wav_path = Path(self.temp_dir.name) / "test_tone.wav"
        create_synthetic_wav(wav_path, duration_s=1.5, sample_rate=44100, num_channels=2)

        meta = self.probe.probe(wav_path)
        self.assertIn("wav", meta.format_name.lower())
        self.assertAlmostEqual(meta.duration_s, 1.5, places=1)
        self.assertFalse(meta.has_video)
        self.assertEqual(len(meta.audio_streams), 1)

        primary = meta.primary_audio
        self.assertIsNotNone(primary)
        self.assertEqual(primary.sample_rate, 44100)
        self.assertEqual(primary.channels, 2)
        self.assertIn("pcm", primary.codec_name.lower())

    def test_probe_nonexistent_file(self):
        """Probing a missing file must raise FileNotFoundError."""
        missing = Path(self.temp_dir.name) / "does_not_exist.wav"
        with self.assertRaises(FileNotFoundError):
            self.probe.probe(missing)

    def test_probe_empty_file(self):
        """Probing a 0-byte file must raise MediaProbeError."""
        empty_path = Path(self.temp_dir.name) / "empty.wav"
        empty_path.touch()
        with self.assertRaises(MediaProbeError):
            self.probe.probe(empty_path)


if __name__ == "__main__":
    unittest.main()

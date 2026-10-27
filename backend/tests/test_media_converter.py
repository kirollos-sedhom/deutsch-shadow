"""Integration tests for media conversion and standardization."""

import tempfile
import unittest
from pathlib import Path

from backend.app.audio.media_converter import MediaConverter
from backend.app.audio.media_probe import MediaProbe
from backend.tests.test_media_probe import create_synthetic_wav


class TestMediaConverter(unittest.TestCase):
    """Test suite for MediaConverter using synthetic audio inputs."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.converter = MediaConverter()
        self.probe = MediaProbe()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_prepare_working_audio_converts_to_16khz_mono(self):
        """Conversion must produce a mono 16kHz PCM WAV without modifying the original."""
        source_wav = Path(self.temp_dir.name) / "original_stereo_44k.wav"
        create_synthetic_wav(source_wav, duration_s=1.0, sample_rate=44100, num_channels=2)

        original_size = source_wav.stat().st_size
        original_mtime = source_wav.stat().st_mtime

        out_dir = Path(self.temp_dir.name) / "output"
        meta, working_wav = self.converter.prepare_working_audio(source_wav, out_dir)

        # 1. Output file exists and is named whisper_working.wav
        self.assertTrue(working_wav.is_file())
        self.assertEqual(working_wav.name, "whisper_working.wav")

        # 2. Probe converted file to verify 16000Hz and 1 channel (mono)
        working_meta = self.probe.probe(working_wav)
        working_audio = working_meta.primary_audio
        self.assertIsNotNone(working_audio)
        self.assertEqual(working_audio.sample_rate, 16000)
        self.assertEqual(working_audio.channels, 1)

        # 3. Source file remains completely unmodified
        self.assertEqual(source_wav.stat().st_size, original_size)
        self.assertEqual(source_wav.stat().st_mtime, original_mtime)


if __name__ == "__main__":
    unittest.main()

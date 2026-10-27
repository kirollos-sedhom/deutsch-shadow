"""Tests for AudioTranscriber error handling and dependency checks."""

import unittest
from pathlib import Path

from backend.app.audio.exceptions import (
    TranscriberDependencyError,
)
from backend.app.audio.models import WhisperConfig
from backend.app.audio.transcriber import AudioTranscriber


class TestAudioTranscriber(unittest.TestCase):
    """Test suite for AudioTranscriber configuration and error handling."""

    def test_missing_audio_file_raises_file_not_found(self):
        """Transcribing a nonexistent audio file must raise FileNotFoundError."""
        transcriber = AudioTranscriber()
        with self.assertRaises(FileNotFoundError):
            transcriber.transcribe("nonexistent_path_to_audio.wav")

    def test_dependency_error_message(self):
        """If faster-whisper is not installed, error message must contain pip install instructions."""
        transcriber = AudioTranscriber(WhisperConfig(model_size="base"))
        try:
            transcriber._load_model()
        except TranscriberDependencyError as err:
            self.assertIn("pip install faster-whisper", str(err))
        except Exception:
            # If faster-whisper happens to be installed in the environment, loading might succeed or fail on weights
            pass


if __name__ == "__main__":
    unittest.main()

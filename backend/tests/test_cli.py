"""Unit tests for the Audio Pipeline CLI interface and argument validation."""

import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from backend.app.audio.cli import main


class TestAudioPipelineCLI(unittest.TestCase):
    """Test suite for CLI argument parsing and error handling."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_nonexistent_file_returns_exit_code_1(self):
        """CLI must return exit code 1 and error message for missing media file."""
        missing = Path(self.temp_dir.name) / "does_not_exist.mp3"
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = main([str(missing)])
        self.assertEqual(code, 1)
        self.assertIn("does not exist", stderr.getvalue())

    def test_directory_as_file_returns_exit_code_1(self):
        """CLI must return exit code 1 if a directory path is supplied as media file."""
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = main([self.temp_dir.name])
        self.assertEqual(code, 1)
        self.assertIn("not a file", stderr.getvalue())

    def test_invalid_threads_returns_exit_code_1(self):
        """CLI must reject non-positive thread counts."""
        dummy_file = Path(self.temp_dir.name) / "dummy.wav"
        dummy_file.touch()

        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = main([str(dummy_file), "--threads", "0"])
        self.assertEqual(code, 1)
        self.assertIn("--threads must be a positive integer", stderr.getvalue())

    def test_target_duration_greater_than_max_returns_exit_code_1(self):
        """CLI must reject target-duration > max-duration."""
        dummy_file = Path(self.temp_dir.name) / "dummy.wav"
        dummy_file.touch()

        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = main([str(dummy_file), "--target-duration", "8.0", "--max-duration", "5.0"])
        self.assertEqual(code, 1)
        self.assertIn("cannot be greater than", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()

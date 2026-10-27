"""End-to-end integration tests for AudioPipeline using mock transcription and synthetic audio."""

import json
import tempfile
import unittest
from pathlib import Path

from backend.app.audio.models import (
    Word,
    RawTranscriptionSegment,
    TranscriptionResult,
    WhisperConfig,
    SegmentationConfig,
)
from backend.app.audio.pipeline import AudioPipeline
from backend.app.audio.transcriber import AudioTranscriber
from backend.tests.test_media_probe import create_synthetic_wav


class MockGermanTranscriber(AudioTranscriber):
    """Mock transcriber that simulates faster-whisper without running heavy ML inference."""

    def transcribe(self, audio_file_path: str | Path) -> TranscriptionResult:
        words = [
            Word("Hallo", 0.1, 0.4),
            Word("zusammen.", 0.45, 1.2),
            Word("Heute", 1.6, 2.0),
            Word("üben", 2.05, 2.4),
            Word("wir", 2.45, 2.65),
            Word("Schattensprechen.", 2.7, 3.8),
        ]
        segments = [
            RawTranscriptionSegment(
                id=0,
                start_s=0.1,
                end_s=1.2,
                text="Hallo zusammen.",
                words=words[:2],
            ),
            RawTranscriptionSegment(
                id=1,
                start_s=1.6,
                end_s=3.8,
                text="Heute üben wir Schattensprechen.",
                words=words[2:],
            ),
        ]
        return TranscriptionResult(
            language="de",
            language_probability=0.98,
            duration_s=4.0,
            segments=segments,
            all_words=words,
        )


class TestAudioPipelineE2E(unittest.TestCase):
    """Test suite for full AudioPipeline execution."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.source_wav = Path(self.temp_dir.name) / "german_speech_sample.wav"
        create_synthetic_wav(self.source_wav, duration_s=4.0, sample_rate=44100, num_channels=1)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_pipeline_end_to_end_generates_manifest(self):
        """Pipeline must probe, convert, transcribe, segment, and write valid manifest.json."""
        out_dir = Path(self.temp_dir.name) / "output_proj"

        pipeline = AudioPipeline(
            transcriber=MockGermanTranscriber(),
            segmentation_config=SegmentationConfig(min_duration_s=1.0),
        )

        result = pipeline.process(
            source_media_path=self.source_wav,
            output_dir=out_dir,
            save_manifest=True,
        )

        # Verify pipeline result
        self.assertEqual(result.transcription.language, "de")
        self.assertEqual(result.total_segments, 2)
        self.assertEqual(result.practice_segments[0].text, "Hallo zusammen.")
        self.assertEqual(result.practice_segments[1].text, "Heute üben wir Schattensprechen.")

        # Verify manifest.json on disk
        manifest_path = out_dir / "manifest.json"
        self.assertTrue(manifest_path.is_file())

        with open(manifest_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertIn("source_file", data)
        self.assertIn("working_audio_file", data)
        self.assertIn("media_metadata", data)
        self.assertIn("practice_segments", data)
        self.assertEqual(len(data["practice_segments"]), 2)
        self.assertEqual(data["practice_segments"][0]["sequence_index"], 1)


if __name__ == "__main__":
    unittest.main()

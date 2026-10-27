"""Audio processing pipeline orchestrator for Deutsch Shadow."""

from __future__ import annotations
import json
from pathlib import Path
from typing import Optional

from backend.app.audio.media_converter import MediaConverter
from backend.app.audio.media_probe import MediaProbe
from backend.app.audio.models import (
    PipelineResult,
    SegmentationConfig,
    WhisperConfig,
)
from backend.app.audio.segmenter import GermanSegmenter
from backend.app.audio.transcriber import AudioTranscriber


class AudioPipeline:
    """Orchestrates probing, conversion, local transcription, and German segmentation."""

    def __init__(
        self,
        whisper_config: Optional[WhisperConfig] = None,
        segmentation_config: Optional[SegmentationConfig] = None,
        ffmpeg_path: Optional[str] = None,
        ffprobe_path: Optional[str] = None,
        transcriber: Optional[AudioTranscriber] = None,
    ):
        """Initialize the pipeline with component configurations.

        Args:
            whisper_config: Faster-whisper options (model, device, threads).
            segmentation_config: German boundary and duration constraints.
            ffmpeg_path: Optional explicit path to FFmpeg binary.
            ffprobe_path: Optional explicit path to FFprobe binary.
            transcriber: Optional custom/mock transcriber instance for testing.
        """
        self.whisper_config = whisper_config or WhisperConfig()
        self.segmentation_config = segmentation_config or SegmentationConfig()
        self.converter = MediaConverter(
            ffmpeg_path=ffmpeg_path,
            ffprobe_path=ffprobe_path,
        )
        self.transcriber = transcriber or AudioTranscriber(config=self.whisper_config)
        self.segmenter = GermanSegmenter(config=self.segmentation_config)

    def process(
        self,
        source_media_path: str | Path,
        output_dir: str | Path,
        save_manifest: bool = True,
    ) -> PipelineResult:
        """Run the complete pipeline on an audio or video file.

        Args:
            source_media_path: Path to user's German audio or video file.
            output_dir: Destination folder for working audio and manifest.
            save_manifest: If True, writes `manifest.json` into output_dir.

        Returns:
            PipelineResult containing metadata, transcription, and practice segments.
        """
        source_path = Path(source_media_path).resolve()
        out_dir = Path(output_dir).resolve()
        out_dir.mkdir(parents=True, exist_ok=True)

        # Step 1: Probe and extract 16kHz mono working audio
        metadata, working_wav = self.converter.prepare_working_audio(
            source_file=source_path,
            output_dir=out_dir,
            sample_rate=16000,
        )

        # Step 2: Transcribe working audio with faster-whisper
        transcription = self.transcriber.transcribe(working_wav)

        # Step 3: Segment transcribed speech into natural practice units
        practice_segments = self.segmenter.segment(transcription)

        # Step 4: Assemble pipeline result
        result = PipelineResult(
            source_file=str(source_path),
            working_audio_file=str(working_wav),
            media_metadata=metadata,
            whisper_config=self.whisper_config,
            segmentation_config=self.segmentation_config,
            transcription=transcription,
            practice_segments=practice_segments,
        )

        # Step 5: Save manifest.json
        if save_manifest:
            manifest_path = out_dir / "manifest.json"
            with open(manifest_path, "w", encoding="utf-8") as f:
                json.dump(result.to_dict(), f, indent=2, ensure_ascii=False)

        return result

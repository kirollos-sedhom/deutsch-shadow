"""Command-line workflow to process a German recording and generate practice segments."""

from __future__ import annotations
import argparse
import sys
import time
from pathlib import Path

from backend.app.audio.exceptions import AudioProcessingError
from backend.app.audio.models import SegmentationConfig, WhisperConfig
from backend.app.audio.pipeline import AudioPipeline


def build_parser() -> argparse.ArgumentParser:
    """Construct CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog="python -m backend.app.audio.cli",
        description="Deutsch Shadow — Local German Audio Processing & Shadowing Segmentation Pipeline",
    )
    parser.add_argument(
        "media_file",
        type=str,
        help="Path to source German audio or video recording (.mp3, .wav, .m4a, .mp4, etc.)",
    )
    parser.add_argument(
        "--output-dir", "-o",
        type=str,
        default="data/pipeline_output",
        help="Directory where working audio and manifest.json will be saved (default: data/pipeline_output)",
    )
    parser.add_argument(
        "--model", "-m",
        type=str,
        default="base",
        choices=["tiny", "base", "small", "medium", "large-v3"],
        help="faster-whisper model tier (default: base)",
    )
    parser.add_argument(
        "--device", "-d",
        type=str,
        default="cpu",
        choices=["cpu", "cuda"],
        help="Compute device (default: cpu)",
    )
    parser.add_argument(
        "--compute-type", "-c",
        type=str,
        default="int8",
        choices=["int8", "float16", "float32"],
        help="Quantization compute type (default: int8)",
    )
    parser.add_argument(
        "--threads", "-t",
        type=int,
        default=4,
        help="Number of CPU threads to allocate for CTranslate2 (default: 4)",
    )
    parser.add_argument(
        "--target-duration",
        type=float,
        default=4.0,
        help="Ideal segment duration in seconds (default: 4.0)",
    )
    parser.add_argument(
        "--max-duration",
        type=float,
        default=7.0,
        help="Maximum segment duration in seconds before forcing a split (default: 7.0)",
    )
    return parser


def main(args: list[str] | None = None) -> int:
    """Execute CLI processing command."""
    parser = build_parser()
    parsed = parser.parse_args(args)

    media_path = Path(parsed.media_file)
    if not media_path.exists():
        print(f"[ERROR] Specified media file does not exist: {media_path}", file=sys.stderr)
        return 1
    if not media_path.is_file():
        print(f"[ERROR] Specified media path is not a file: {media_path}", file=sys.stderr)
        return 1

    if parsed.threads <= 0:
        print("[ERROR] --threads must be a positive integer (>= 1).", file=sys.stderr)
        return 1

    if parsed.target_duration <= 0 or parsed.max_duration <= 0:
        print("[ERROR] Duration settings must be positive numbers.", file=sys.stderr)
        return 1

    if parsed.target_duration > parsed.max_duration:
        print("[ERROR] --target-duration cannot be greater than --max-duration.", file=sys.stderr)
        return 1

    whisper_cfg = WhisperConfig(
        model_size=parsed.model,
        device=parsed.device,
        compute_type=parsed.compute_type,
        cpu_threads=parsed.threads,
        language="de",
    )

    segmentation_cfg = SegmentationConfig(
        target_duration_s=parsed.target_duration,
        max_duration_s=parsed.max_duration,
    )

    print("=================================================================")
    print(" Deutsch Shadow — Audio Processing Pipeline")
    print("=================================================================")
    print(f" Source File:       {media_path.resolve()}")
    print(f" Output Directory:  {Path(parsed.output_dir).resolve()}")
    print(f" Whisper Config:    model={whisper_cfg.model_size}, device={whisper_cfg.device}, compute={whisper_cfg.compute_type}, threads={whisper_cfg.cpu_threads}")
    print(f" Segmentation:      target={segmentation_cfg.target_duration_s}s, max={segmentation_cfg.max_duration_s}s")
    print("-----------------------------------------------------------------")

    start_time = time.time()
    try:
        pipeline = AudioPipeline(
            whisper_config=whisper_cfg,
            segmentation_config=segmentation_cfg,
        )
        print("-> Probing media and generating standardized 16kHz working copy...")
        result = pipeline.process(
            source_media_path=media_path,
            output_dir=parsed.output_dir,
            save_manifest=True,
        )
    except AudioProcessingError as err:
        print(f"\n[PIPELINE ERROR] {err}", file=sys.stderr)
        return 2
    except Exception as err:
        print(f"\n[UNEXPECTED ERROR] {err}", file=sys.stderr)
        return 3

    elapsed = time.time() - start_time

    meta = result.media_metadata
    primary_audio = meta.primary_audio
    print("\n[PROBE SUMMARY]")
    print(f" Format:           {meta.format_name}")
    print(f" Duration:         {meta.duration_s:.2f}s")
    print(f" Has Video:        {meta.has_video}")
    if primary_audio:
        print(f" Audio Stream:     {primary_audio.codec_name}, {primary_audio.sample_rate}Hz, {primary_audio.channels} ch")

    print("\n[TRANSCRIPTION SUMMARY]")
    print(f" Language Detected: {result.transcription.language} (p={result.transcription.language_probability:.2f})")
    print(f" Total Words:       {len(result.transcription.all_words)}")
    print(f" Pipeline Runtime:  {elapsed:.2f}s")

    print(f"\n[GENERATED PRACTICE SEGMENTS] ({len(result.practice_segments)} segments)")
    print("-----------------------------------------------------------------")
    for seg in result.practice_segments:
        start_fmt = f"{seg.start_ms / 1000.0:6.2f}s"
        end_fmt = f"{seg.end_ms / 1000.0:6.2f}s"
        dur_fmt = f"({seg.duration_ms}ms)"
        print(f" [{seg.sequence_index:02d}] {start_fmt} -> {end_fmt} {dur_fmt:<8} : {seg.text}")

    manifest_path = Path(parsed.output_dir) / "manifest.json"
    print("-----------------------------------------------------------------")
    print(f"✓ Manifest saved: {manifest_path.resolve()}")
    print("=================================================================")
    return 0


if __name__ == "__main__":
    sys.exit(main())

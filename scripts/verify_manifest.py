"""Manifest validation script for Deutsch Shadow integration tests."""

import json
import sys
from pathlib import Path


def validate_manifest(manifest_path: str | Path) -> dict:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    path = Path(manifest_path)
    if not path.is_file():
        print(f"[FAIL] Manifest file does not exist: {path}", file=sys.stderr)
        sys.exit(1)

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    media_metadata = data.get("media_metadata", {})
    media_dur_s = float(media_metadata.get("duration_s", 0.0))
    media_dur_ms = int(round(media_dur_s * 1000))
    segments = data.get("practice_segments", [])
    total_segments = len(segments)

    print("=" * 65)
    print(" MANIFEST AUDIT & VALIDATION")
    print("=" * 65)
    print(f" Source Media:      {data.get('source_file')}")
    print(f" Working Audio:     {data.get('working_audio_file')}")
    print(f" Media Duration:    {media_dur_s:.3f}s ({media_dur_ms} ms)")
    print(f" Total Segments:    {total_segments}")
    print("-" * 65)

    errors = []
    warnings = []
    prev_end_ms = 0

    max_cfg_dur_s = data.get("segmentation_config", {}).get("max_duration_s", 7.0)
    max_allowed_ms = int(round(max_cfg_dur_s * 1000))

    for s in segments:
        seq = s.get("sequence_index")
        start_ms = s.get("start_ms")
        end_ms = s.get("end_ms")
        dur_ms = s.get("duration_ms")
        text = s.get("text", "")
        words = s.get("words", [])

        # Check start < end
        if start_ms is None or end_ms is None or start_ms >= end_ms:
            errors.append(f"Seg {seq}: Invalid bounds: start_ms={start_ms}, end_ms={end_ms}")

        # Check duration consistency
        calculated_dur = end_ms - start_ms
        if dur_ms != calculated_dur:
            errors.append(f"Seg {seq}: Stored duration_ms ({dur_ms}) != end_ms - start_ms ({calculated_dur})")

        # Check ordering and overlap
        if start_ms < prev_end_ms:
            errors.append(f"Seg {seq}: Overlap detected! start_ms ({start_ms}) < prev_end_ms ({prev_end_ms})")

        # Check media duration boundary
        if end_ms > media_dur_ms:
            errors.append(f"Seg {seq}: end_ms ({end_ms} ms) exceeds media duration ({media_dur_ms} ms) by {end_ms - media_dur_ms} ms")

        # Check max segment duration limit
        if dur_ms > max_allowed_ms:
            warnings.append(f"Seg {seq}: duration ({dur_ms} ms) exceeds max_duration_s ({max_allowed_ms} ms) by {dur_ms - max_allowed_ms} ms")

        # Words check
        if not words:
            errors.append(f"Seg {seq}: No words array present")

        print(f" [{seq:02d}] {start_ms:5d}ms -> {end_ms:5d}ms ({dur_ms:4d}ms) : words={len(words):2d} : {text[:50]}...")
        prev_end_ms = end_ms

    print("-" * 65)
    if errors:
        print(f"[FAIL] {len(errors)} ERROR(S) FOUND:")
        for err in errors:
            print(f"  [ERROR] {err}")
    else:
        print("[OK] Zero boundary/ordering errors found.")

    if warnings:
        print(f"\n[WARN] {len(warnings)} WARNING(S) FOUND:")
        for w in warnings:
            print(f"  [WARN] {w}")

    print("=" * 65)
    return {
        "media_dur_ms": media_dur_ms,
        "total_segments": total_segments,
        "errors": errors,
        "warnings": warnings,
        "success": len(errors) == 0,
    }


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "data/real_audio_test/manifest.json"
    result = validate_manifest(target)
    sys.exit(0 if result["success"] else 1)

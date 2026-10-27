"""Live integration test for the running Debug Player server."""

import json
import sys
import urllib.request
from pathlib import Path


def test_live_player(base_url: str = "http://127.0.0.1:8080") -> bool:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    print(f"Connecting to live debug server at {base_url}...")

    # 1. Test HTML UI
    try:
        html_resp = urllib.request.urlopen(f"{base_url}/")
        assert html_resp.status == 200
        html = html_resp.read().decode("utf-8")
        assert "Deutsch Shadow — Debugging Player" in html
        assert "audioElement" in html
        print("[OK] HTML UI loaded successfully (Status 200, contains audio player & controls)")
    except Exception as exc:
        print(f"[FAIL] HTML UI check failed: {exc}")
        return False

    # 2. Test Manifest API
    try:
        manifest_resp = urllib.request.urlopen(f"{base_url}/api/manifest")
        assert manifest_resp.status == 200
        data = json.loads(manifest_resp.read().decode("utf-8"))
        segments = data["practice_segments"]
        media_dur = data["media_metadata"]["duration_s"]
        print(f"[OK] Manifest API returned 200 OK: {len(segments)} segments, duration: {media_dur:.3f}s")
    except Exception as exc:
        print(f"[FAIL] Manifest API check failed: {exc}")
        return False

    # 3. Test Segment 1 (Normal segment: 0 - 4920ms)
    try:
        seg1 = segments[0]
        # WAV byte offset: 44-byte header + 32,000 bytes/sec (16kHz 16-bit mono)
        start_byte_1 = 44 + int(seg1["start_ms"] / 1000.0 * 32000)
        end_byte_1 = 44 + int(seg1["end_ms"] / 1000.0 * 32000)
        req1 = urllib.request.Request(f"{base_url}/api/audio")
        req1.add_header("Range", f"bytes={start_byte_1}-{end_byte_1}")
        with urllib.request.urlopen(req1) as resp1:
            assert resp1.status == 206
            chunk1 = resp1.read()
            expected_len = end_byte_1 - start_byte_1 + 1
            assert len(chunk1) == expected_len
            print(f"[OK] Segment 01 seeking verified (Normal: {seg1['start_ms']}ms -> {seg1['end_ms']}ms | HTTP 206: {len(chunk1)} bytes)")
    except Exception as exc:
        print(f"[FAIL] Segment 01 range seek failed: {exc}")
        return False

    # 4. Test Segment 4 (Short segment: 16300 - 16600ms, 300ms '1.')
    try:
        seg4 = segments[3]
        start_byte_4 = 44 + int(seg4["start_ms"] / 1000.0 * 32000)
        end_byte_4 = 44 + int(seg4["end_ms"] / 1000.0 * 32000)
        req4 = urllib.request.Request(f"{base_url}/api/audio")
        req4.add_header("Range", f"bytes={start_byte_4}-{end_byte_4}")
        with urllib.request.urlopen(req4) as resp4:
            assert resp4.status == 206
            chunk4 = resp4.read()
            expected_len = end_byte_4 - start_byte_4 + 1
            assert len(chunk4) == expected_len
            print(f"[OK] Segment 04 seeking verified (Short 300ms: {seg4['start_ms']}ms -> {seg4['end_ms']}ms | HTTP 206: {len(chunk4)} bytes)")
    except Exception as exc:
        print(f"[FAIL] Segment 04 range seek failed: {exc}")
        return False

    # 5. Test Segment 13 (Final segment: 53360 - 54288ms)
    try:
        seg13 = segments[12]
        start_byte_13 = 44 + int(seg13["start_ms"] / 1000.0 * 32000)
        end_byte_13 = 44 + int(seg13["end_ms"] / 1000.0 * 32000)
        req13 = urllib.request.Request(f"{base_url}/api/audio")
        req13.add_header("Range", f"bytes={start_byte_13}-{end_byte_13}")
        with urllib.request.urlopen(req13) as resp13:
            assert resp13.status == 206
            chunk13 = resp13.read()
            expected_len = end_byte_13 - start_byte_13 + 1
            assert len(chunk13) == expected_len
            print(f"[OK] Segment 13 seeking verified (Final boundary: {seg13['start_ms']}ms -> {seg13['end_ms']}ms | HTTP 206: {len(chunk13)} bytes)")
    except Exception as exc:
        print(f"[FAIL] Segment 13 range seek failed: {exc}")
        return False

    print("\n[SUCCESS] All live debugging player endpoints and segment range seeks verified!")
    return True


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"
    success = test_live_player(url)
    sys.exit(0 if success else 1)

"""Real-audio end-to-end integration test for Milestone 4 FastAPI backend."""

import sys
from pathlib import Path

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

from backend.app.main import app


def test_real_audio_pipeline():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    with TestClient(app) as client:
        print("1. Testing Healthcheck...")
        res = client.get("/api/health")
        assert res.status_code == 200, res.text
        print(f"   -> Healthcheck OK: {res.json()}")

        print("2. Testing System Capabilities...")
        res = client.get("/api/system/capabilities")
        assert res.status_code == 200, res.text
        caps = res.json()
        print(
            f"   -> System: CPU logical={caps['cpu_logical_cores']}, "
            f"RAM={caps['ram_total_gb']}GB, FFmpeg={caps['ffmpeg_available']}, "
            f"Recommended={caps['recommended_model']}"
        )

        print("3. Testing Project Import with data/sample.mp4...")
        sample_path = Path("data/sample.mp4")
        assert sample_path.is_file(), "sample.mp4 missing"

        with open(sample_path, "rb") as f:
            res = client.post(
                "/api/projects/import",
                files={"file": ("sample.mp4", f, "video/mp4")},
                data={"title": "Sample German News", "auto_process": "false"},
            )
        assert res.status_code == 201, res.text
        import_data = res.json()
        project_id = import_data["project_id"]
        print(f"   -> Project created: id={project_id}, status={import_data['status']}")

        print("4. Running Real Audio Processing Pipeline via POST /api/projects/{id}/process...")
        res = client.post(f"/api/projects/{project_id}/process")
        assert res.status_code == 200, res.text
        proc_data = res.json()
        print(
            f"   -> Processing finished: status={proc_data['status']}, "
            f"duration={proc_data['duration_seconds']}s, segments={proc_data['segments_count']}"
        )
        assert proc_data["status"] == "ready"
        assert proc_data["segments_count"] == 13

        print("5. Querying Segments via GET /api/projects/{id}/segments...")
        res = client.get(f"/api/projects/{project_id}/segments")
        assert res.status_code == 200, res.text
        segs = res.json()
        assert len(segs) == 13
        print(f"   -> Fetched {len(segs)} segments.")
        print(f"   -> Seg 01: {segs[0]['start_time_ms']}ms -> {segs[0]['end_time_ms']}ms : {segs[0]['text'][:45]}...")
        print(f"   -> Seg 13: {segs[12]['start_time_ms']}ms -> {segs[12]['end_time_ms']}ms : {segs[12]['text']}")

        print("6. Testing Master Audio Streaming via GET /api/media/{id}/master with Range...")
        res = client.get(f"/api/media/{project_id}/master", headers={"Range": "bytes=0-2047"})
        assert res.status_code == 206, res.text
        print(f"   -> Stream status: {res.status_code}, Content-Range: {res.headers.get('content-range')}, bytes={len(res.content)}")

        print("7. Testing Segment Patching via PATCH /api/segments/{id}...")
        seg1_id = segs[0]["id"]
        patch_res = client.patch(f"/api/segments/{seg1_id}", json={"text": "Der russische Präsident Vladimir Putin spricht Deutschland ab, ein unabhängiger Staat zu sein. [BEARBEITET]"})
        assert patch_res.status_code == 200, patch_res.text
        patched = patch_res.json()
        assert patched["is_edited"] is True
        print("   -> Segment patched successfully.")

        print("8. Cleaning up: DELETE /api/projects/{id}...")
        res = client.delete(f"/api/projects/{project_id}")
        assert res.status_code == 204, res.text
        res_check = client.get(f"/api/projects/{project_id}")
        assert res_check.status_code == 404
        print("   -> Project deleted cleanly.")
        print("ALL MILESTONE 4 REAL-AUDIO INTEGRATION CHECKS PASSED!")


if __name__ == "__main__":
    test_real_audio_pipeline()

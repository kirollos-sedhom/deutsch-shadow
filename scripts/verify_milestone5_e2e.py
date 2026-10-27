"""Live verification script for Milestone 5 frontend-backend integration."""

import time
import httpx
from pathlib import Path

BASE_URL = "http://127.0.0.1:8000/api"
SAMPLE_PATH = Path("data/sample.mp4")

def main():
    client = httpx.Client(timeout=30.0)

    print("1. Checking system capabilities...")
    caps_res = client.get(f"{BASE_URL}/system/capabilities")
    assert caps_res.status_code == 200, f"Failed capabilities: {caps_res.text}"
    print("   Capabilities:", caps_res.json()["recommended_model"], "cores:", caps_res.json()["cpu_physical_cores"])

    print("\n2. Checking Whisper models...")
    models_res = client.get(f"{BASE_URL}/system/models")
    assert models_res.status_code == 200, f"Failed models: {models_res.text}"
    print(f"   Available models: {[m['name'] for m in models_res.json()]}")

    print("\n3. Testing project import with data/sample.mp4...")
    assert SAMPLE_PATH.is_file(), f"Sample file missing: {SAMPLE_PATH}"

    with open(SAMPLE_PATH, "rb") as f:
        import_res = client.post(
            f"{BASE_URL}/projects/import",
            files={"file": ("sample.mp4", f, "video/mp4")},
            data={"title": "Tagesschau M5 Verification", "whisper_model": "base", "auto_process": "true"}
        )
    assert import_res.status_code == 201, f"Import failed: {import_res.text}"
    import_data = import_res.json()
    project_id = import_data["project_id"]
    print(f"   Project imported with ID: {project_id}, initial status: {import_data['status']}")

    print("\n4. Polling project status until ready (simulating frontend polling)...")
    start_time = time.time()
    ready = False
    while time.time() - start_time < 120:
        time.sleep(2)
        proj_res = client.get(f"{BASE_URL}/projects/{project_id}")
        assert proj_res.status_code == 200, f"Failed to poll project: {proj_res.text}"
        proj_data = proj_res.json()
        status = proj_data["status"]
        print(f"   Status at {time.time() - start_time:.1f}s: {status}")
        if status == "ready":
            ready = True
            break
        elif status == "failed":
            raise RuntimeError(f"Pipeline failed: {proj_data.get('error_message')}")

    assert ready, "Timed out waiting for project to become ready"

    print("\n5. Verifying project details and metadata...")
    print(f"   Duration: {proj_data['duration_seconds']:.2f}s")
    print(f"   Segments Count: {proj_data['segments_count']}")
    assert proj_data["segments_count"] > 0, "No segments created!"

    print("\n6. Fetching practice segments...")
    segs_res = client.get(f"{BASE_URL}/projects/{project_id}/segments")
    assert segs_res.status_code == 200, f"Failed to get segments: {segs_res.text}"
    segments = segs_res.json()
    print(f"   Retrieved {len(segments)} segments. First segment sample:")
    print(f"   [#{segments[0]['sequence_index'] + 1}] {segments[0]['start_time_ms']}ms -> {segments[0]['end_time_ms']}ms: {segments[0]['text']}")

    print("\n7. Testing audio streaming byte-range (HTTP 206)...")
    stream_res = client.get(
        f"{BASE_URL}/media/{project_id}/master",
        headers={"Range": "bytes=0-1023"}
    )
    assert stream_res.status_code == 206, f"Streaming failed: {stream_res.status_code}"
    assert len(stream_res.content) == 1024, f"Unexpected content length: {len(stream_res.content)}"
    print("   Audio stream Range request succeeded (HTTP 206, 1024 bytes delivered).")

    print("\n8. Verifying library list endpoint...")
    list_res = client.get(f"{BASE_URL}/projects")
    assert list_res.status_code == 200
    all_projects = list_res.json()
    assert any(p["id"] == project_id for p in all_projects), "Project missing from list!"
    print(f"   Library list contains {len(all_projects)} project(s).")

    print("\n--- Milestone 5 E2E Verification Passed Successfully! ---")

if __name__ == "__main__":
    main()

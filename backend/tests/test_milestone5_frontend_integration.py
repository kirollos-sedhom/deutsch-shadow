"""Integration test for Milestone 5 frontend REST API contracts."""

import io
from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.core.config import settings
from backend.app.api.routes.projects import (
    is_pipeline_task_active,
    mark_pipeline_task_active,
    unmark_pipeline_task_active,
)


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_system_endpoints(client):
    """Verify system capabilities and model tiers endpoints used by frontend navbar/modal."""
    caps_resp = client.get("/api/system/capabilities")
    assert caps_resp.status_code == 200
    caps = caps_resp.json()
    assert "cpu_physical_cores" in caps
    assert "ram_total_gb" in caps
    assert "recommended_model" in caps

    models_resp = client.get("/api/system/models")
    assert models_resp.status_code == 200
    models = models_resp.json()
    assert isinstance(models, list)
    assert len(models) >= 3
    model_names = [m["name"] for m in models]
    assert "base" in model_names


def test_project_crud_lifecycle_for_frontend(client, tmp_path):
    """Test full CRUD lifecycle matching frontend client calls: import, get, list, delete."""
    # 1. Initial list
    init_resp = client.get("/api/projects")
    assert init_resp.status_code == 200
    initial_projects = init_resp.json()
    initial_count = len(initial_projects)

    # 2. Import project without auto-processing to test instant response contract
    wav_content = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    files = {"file": ("frontend_test.wav", io.BytesIO(wav_content), "audio/wav")}
    data = {
        "title": "Frontend Integration Project",
        "whisper_model": "base",
        "auto_process": "false",
    }
    import_resp = client.post("/api/projects/import", files=files, data=data)
    assert import_resp.status_code == 201
    import_data = import_resp.json()
    assert "project_id" in import_data
    project_id = import_data["project_id"]
    assert import_data["title"] == "Frontend Integration Project"
    assert import_data["status"] == "pending"

    # 3. Retrieve project list and verify new entry exists
    list_resp = client.get("/api/projects")
    assert list_resp.status_code == 200
    projects = list_resp.json()
    assert len(projects) == initial_count + 1
    created_entry = next((p for p in projects if p["id"] == project_id), None)
    assert created_entry is not None
    assert created_entry["title"] == "Frontend Integration Project"
    assert created_entry["status"] == "pending"
    assert "segments_count" in created_entry

    # 4. Retrieve single project detail
    detail_resp = client.get(f"/api/projects/{project_id}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["id"] == project_id
    assert detail["title"] == "Frontend Integration Project"
    assert detail["status"] == "pending"
    assert "settings" in detail

    # 5. Retrieve segments (should be empty for unprocessed project)
    segs_resp = client.get(f"/api/projects/{project_id}/segments")
    assert segs_resp.status_code == 200
    assert segs_resp.json() == []

    # 6. Delete project
    del_resp = client.delete(f"/api/projects/{project_id}")
    assert del_resp.status_code == 204

    # 7. Verify deletion persists
    post_del_list = client.get("/api/projects").json()
    assert len(post_del_list) == initial_count
    assert not any(p["id"] == project_id for p in post_del_list)

    not_found_resp = client.get(f"/api/projects/{project_id}")
    assert not_found_resp.status_code == 404


def test_async_process_and_duplicate_protection(client):
    """Verify asynchronous retry/process endpoint returns promptly and protects against duplicate jobs."""
    # 1. Create a dummy project without auto-processing
    wav_content = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    files = {"file": ("async_test.wav", io.BytesIO(wav_content), "audio/wav")}
    data = {"title": "Async Retry Test", "auto_process": "false"}
    import_resp = client.post("/api/projects/import", files=files, data=data)
    assert import_resp.status_code == 201
    project_id = import_resp.json()["project_id"]

    try:
        # 2. Trigger process endpoint -> should return immediately with status='processing'
        process_resp = client.post(f"/api/projects/{project_id}/process")
        assert process_resp.status_code == 200
        proj_detail = process_resp.json()
        assert proj_detail["status"] == "processing"

        # 3. Duplicate protection: Triggering process again while already processing must return cleanly
        dup_resp = client.post(f"/api/projects/{project_id}/process")
        assert dup_resp.status_code == 200
        assert dup_resp.json()["status"] == "processing"

        # 4. Processing a non-existent project returns 404
        bad_resp = client.post("/api/projects/non-existent-uuid/process")
        assert bad_resp.status_code == 404

    finally:
        # Clean up
        client.delete(f"/api/projects/{project_id}")


def test_stale_processing_project_recovers_after_restart(client):
    """Verify that a project stuck in 'processing' from a prior process death can be retried and enqueued."""
    wav_content = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    files = {"file": ("stale_test.wav", io.BytesIO(wav_content), "audio/wav")}
    data = {"title": "Stale Processing Project", "auto_process": "false"}
    import_resp = client.post("/api/projects/import", files=files, data=data)
    assert import_resp.status_code == 201
    project_id = import_resp.json()["project_id"]

    try:
        # Simulate a prior crash/kill leaving the project in 'processing' status in SQLite
        import sqlite3
        conn = sqlite3.connect(settings.database_path)
        conn.execute("UPDATE projects SET status = ? WHERE id = ?", ("processing", project_id))
        conn.commit()
        conn.close()

        # Simulate backend restart: no background task is active in this process
        assert not is_pipeline_task_active(project_id)

        # Trigger /process retry: it must recognize that no task is running and enqueue a new task
        with patch("backend.app.api.routes.projects.run_pipeline_in_background") as mock_task:
            retry_resp = client.post(f"/api/projects/{project_id}/process")
            assert retry_resp.status_code == 200
            assert retry_resp.json()["status"] == "processing"
            assert mock_task.called, "Expected run_pipeline_in_background to be enqueued for stale project"

    finally:
        unmark_pipeline_task_active(project_id)
        client.delete(f"/api/projects/{project_id}")


def test_genuinely_running_task_blocks_duplicate_enqueue(client):
    """Verify that a genuinely running in-memory task is not duplicated by repeated process requests."""
    wav_content = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    files = {"file": ("dup_check.wav", io.BytesIO(wav_content), "audio/wav")}
    data = {"title": "Active Task Duplicate Test", "auto_process": "false"}
    import_resp = client.post("/api/projects/import", files=files, data=data)
    assert import_resp.status_code == 201
    project_id = import_resp.json()["project_id"]

    try:
        # Mark active in-memory task (simulating currently running Whisper transcription)
        mark_pipeline_task_active(project_id)
        assert is_pipeline_task_active(project_id)

        with patch("backend.app.api.routes.projects.run_pipeline_in_background") as mock_task:
            dup_resp = client.post(f"/api/projects/{project_id}/process")
            assert dup_resp.status_code == 200
            assert dup_resp.json()["status"] == "pending" or dup_resp.json()["status"] == "processing"
            assert not mock_task.called, "Expected duplicate process request to be blocked while task is running"

    finally:
        unmark_pipeline_task_active(project_id)
        client.delete(f"/api/projects/{project_id}")


def test_existing_ready_projects_unaffected_by_process_tracking(client):
    """Verify that existing successful ('ready') projects remain unaffected and retrievable."""
    wav_content = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    files = {"file": ("ready_check.wav", io.BytesIO(wav_content), "audio/wav")}
    data = {"title": "Existing Ready Project", "auto_process": "false"}
    import_resp = client.post("/api/projects/import", files=files, data=data)
    assert import_resp.status_code == 201
    project_id = import_resp.json()["project_id"]

    try:
        # Manually set project status to ready
        import sqlite3
        conn = sqlite3.connect(settings.database_path)
        conn.execute("UPDATE projects SET status = ? WHERE id = ?", ("ready", project_id))
        conn.commit()
        conn.close()

        # Check detail endpoint
        detail_resp = client.get(f"/api/projects/{project_id}")
        assert detail_resp.status_code == 200
        assert detail_resp.json()["status"] == "ready"

        # Check list endpoint
        list_resp = client.get("/api/projects")
        assert list_resp.status_code == 200
        matching = [p for p in list_resp.json() if p["id"] == project_id]
        assert len(matching) == 1
        assert matching[0]["status"] == "ready"

        # Task tracking should be clean
        assert not is_pipeline_task_active(project_id)

    finally:
        client.delete(f"/api/projects/{project_id}")


"""Integration test for Milestone 5 frontend REST API contracts."""

import io
import pytest
from fastapi.testclient import TestClient
from backend.app.main import app


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

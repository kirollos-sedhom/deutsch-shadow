"""Regression tests for Stage 5A: Cloud Model Enforcement.

Verifies:
1. In cloud mode:
   - Omitted model field defaults to 'tiny'.
   - Empty/whitespace model field defaults to 'tiny'.
   - Explicit 'tiny' model is accepted.
   - Explicit 'base', 'small', 'medium', or arbitrary models are rejected with HTTP 400.
   - No rejected request creates an orphaned file on disk or database record.
   - GET /api/system/models exposes strictly 'tiny' with consistent cloud metadata.
2. In local mode:
   - GET /api/system/models exposes all existing model tiers.
   - Imports respect the explicitly selected model (e.g. 'small', 'base', 'tiny').
   - Omitted model defaults to settings.default_whisper_model ('base').
"""

from __future__ import annotations
import io
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import status
from fastapi.testclient import TestClient

from backend.app.core.config import settings
from backend.app.core.security import session_registry
from backend.app.main import app
from backend.tests.test_media_probe import create_synthetic_wav


VALID_PASSWORD = "CorrectHorseBatteryStaple123!"
VALID_ORIGIN = "https://deutsch-shadow.onrender.com"


@pytest.fixture(autouse=True)
def reset_security_and_registry():
    """Clear session registry before and after every test."""
    session_registry.clear()
    yield
    session_registry.clear()


def create_authenticated_cloud_client():
    """Create a TestClient with valid cloud authentication cookie and CSRF origin headers."""
    client = TestClient(app, base_url=VALID_ORIGIN)
    resp = client.post(
        "/api/auth/login",
        json={"password": VALID_PASSWORD},
        headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
    )
    assert resp.status_code == 200, f"Login failed: {resp.text}"
    return client


def make_auth_headers():
    """Return standard CSRF headers for authenticated state-changing requests."""
    return {
        "Origin": VALID_ORIGIN,
        "X-Requested-With": "Fetch",
    }


def make_test_wav_bytes(duration_s: float = 1.0) -> bytes:
    """Create synthetic WAV bytes with valid headers for import testing."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        wav_path = Path(tf.name)
    try:
        create_synthetic_wav(wav_path, duration_s=duration_s)
        return wav_path.read_bytes()
    finally:
        if wav_path.exists():
            wav_path.unlink()


# ==============================================================================
# 1. System Models Endpoint Tests
# ==============================================================================

def test_cloud_model_endpoint_exposes_strictly_tiny():
    """In cloud mode, GET /api/system/models must expose only the 'tiny' model tier."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()
        resp = client.get("/api/system/models", headers=make_auth_headers())
        assert resp.status_code == status.HTTP_200_OK

        models = resp.json()
        assert len(models) == 1, f"Expected strictly 1 model in cloud mode, got {len(models)}"
        tiny = models[0]
        assert tiny["name"] == "tiny"
        assert tiny["size_mb"] == 75.0
        assert tiny["is_downloaded"] is True
        assert tiny["is_recommended"] is True

        # Capabilities endpoint also reflects 'tiny' as recommended
        caps_resp = client.get("/api/system/capabilities", headers=make_auth_headers())
        assert caps_resp.status_code == status.HTTP_200_OK
        assert caps_resp.json()["recommended_model"] == "tiny"


def test_local_model_endpoint_preserves_all_tiers():
    """In local mode, GET /api/system/models must expose all existing model tiers."""
    with patch.object(settings, "auth_mode", "local"):
        client = TestClient(app)
        resp = client.get("/api/system/models")
        assert resp.status_code == status.HTTP_200_OK

        models = resp.json()
        names = [m["name"] for m in models]
        assert "tiny" in names
        assert "base" in names
        assert "small" in names
        assert "medium" in names
        assert len(models) == 4


# ==============================================================================
# 2. Cloud Mode Import Model Enforcement Tests
# ==============================================================================

def test_cloud_import_omitted_model_defaults_to_tiny():
    """In cloud mode, importing with omitted model field defaults to 'tiny'."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()
        wav_bytes = make_test_wav_bytes(duration_s=1.0)

        # Omit 'whisper_model' entirely from form data
        files = {"file": ("omitted_model.wav", io.BytesIO(wav_bytes), "audio/wav")}
        data = {"title": "Omitted Model Project", "auto_process": "false"}

        resp = client.post(
            "/api/projects/import",
            files=files,
            data=data,
            headers=make_auth_headers(),
        )
        assert resp.status_code == status.HTTP_201_CREATED
        assert resp.json()["whisper_model"] == "tiny"
        proj_id = resp.json()["project_id"]

        try:
            detail = client.get(f"/api/projects/{proj_id}", headers=make_auth_headers()).json()
            assert detail["whisper_model"] == "tiny", f"Expected 'tiny', got {detail['whisper_model']}"
        finally:
            client.delete(f"/api/projects/{proj_id}", headers=make_auth_headers())


def test_cloud_import_empty_model_defaults_to_tiny():
    """In cloud mode, importing with empty/whitespace model field defaults to 'tiny'."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()
        wav_bytes = make_test_wav_bytes(duration_s=1.0)

        for empty_val in ["", "   "]:
            files = {"file": ("empty_model.wav", io.BytesIO(wav_bytes), "audio/wav")}
            data = {"title": "Empty Model Project", "whisper_model": empty_val, "auto_process": "false"}

            resp = client.post(
                "/api/projects/import",
                files=files,
                data=data,
                headers=make_auth_headers(),
            )
            assert resp.status_code == status.HTTP_201_CREATED
            assert resp.json()["whisper_model"] == "tiny"
            proj_id = resp.json()["project_id"]

            try:
                detail = client.get(f"/api/projects/{proj_id}", headers=make_auth_headers()).json()
                assert detail["whisper_model"] == "tiny", f"Expected 'tiny' for empty val '{empty_val}'"
            finally:
                client.delete(f"/api/projects/{proj_id}", headers=make_auth_headers())


def test_cloud_import_explicit_tiny_accepted():
    """In cloud mode, explicitly requesting 'tiny' is accepted."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()
        wav_bytes = make_test_wav_bytes(duration_s=1.0)

        files = {"file": ("tiny_model.wav", io.BytesIO(wav_bytes), "audio/wav")}
        data = {"title": "Explicit Tiny", "whisper_model": "tiny", "auto_process": "false"}

        resp = client.post(
            "/api/projects/import",
            files=files,
            data=data,
            headers=make_auth_headers(),
        )
        assert resp.status_code == status.HTTP_201_CREATED
        assert resp.json()["whisper_model"] == "tiny"
        proj_id = resp.json()["project_id"]

        try:
            detail = client.get(f"/api/projects/{proj_id}", headers=make_auth_headers()).json()
            assert detail["whisper_model"] == "tiny"
        finally:
            client.delete(f"/api/projects/{proj_id}", headers=make_auth_headers())


@pytest.mark.parametrize("unsupported_model", ["base", "small", "medium", "large-v3", "custom-model", "random123"])
def test_cloud_import_unsupported_models_rejected_with_400(unsupported_model: str):
    """In cloud mode, explicitly requesting any model other than 'tiny' is rejected with HTTP 400."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()
        wav_bytes = make_test_wav_bytes(duration_s=1.0)

        files = {"file": ("unsupported_model.wav", io.BytesIO(wav_bytes), "audio/wav")}
        data = {"title": "Unsupported Model", "whisper_model": unsupported_model, "auto_process": "false"}

        resp = client.post(
            "/api/projects/import",
            files=files,
            data=data,
            headers=make_auth_headers(),
        )
        assert resp.status_code == status.HTTP_400_BAD_REQUEST
        error_detail = resp.json()["detail"]
        assert f"Unsupported Whisper model '{unsupported_model}' in cloud mode" in error_detail
        assert "tiny" in error_detail


def test_cloud_rejected_import_creates_no_orphaned_files_or_db_records():
    """Verify that a rejected model import creates zero database rows and zero filesystem artifacts."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()
        wav_bytes = make_test_wav_bytes(duration_s=1.0)

        # Baseline count
        initial_projects = client.get("/api/projects", headers=make_auth_headers()).json()
        initial_count = len(initial_projects)

        projects_dir = settings.projects_dir
        initial_dirs = set(p.name for p in projects_dir.iterdir()) if projects_dir.exists() else set()

        files = {"file": ("rejected_cleanup.wav", io.BytesIO(wav_bytes), "audio/wav")}
        data = {"title": "Rejected Should Leave No Trace", "whisper_model": "small", "auto_process": "false"}

        resp = client.post(
            "/api/projects/import",
            files=files,
            data=data,
            headers=make_auth_headers(),
        )
        assert resp.status_code == status.HTTP_400_BAD_REQUEST

        # Confirm zero database records created
        after_projects = client.get("/api/projects", headers=make_auth_headers()).json()
        assert len(after_projects) == initial_count

        # Confirm zero disk directories created
        after_dirs = set(p.name for p in projects_dir.iterdir()) if projects_dir.exists() else set()
        assert after_dirs == initial_dirs, f"New orphaned directories found: {after_dirs - initial_dirs}"


# ==============================================================================
# 3. Local Mode Model Preservation Tests
# ==============================================================================

def test_local_import_preserves_explicit_and_default_model_selection():
    """In local mode, model selection behaves normally and respects 'base', 'small', 'tiny'."""
    with patch.object(settings, "auth_mode", "local"):
        client = TestClient(app)
        wav_bytes = make_test_wav_bytes(duration_s=1.0)

        # 1. Omitted model in local mode uses default ('base')
        files1 = {"file": ("local_omitted.wav", io.BytesIO(wav_bytes), "audio/wav")}
        data1 = {"title": "Local Omitted", "auto_process": "false"}
        resp1 = client.post("/api/projects/import", files=files1, data=data1)
        assert resp1.status_code == status.HTTP_201_CREATED
        assert resp1.json()["whisper_model"] == "base"
        id1 = resp1.json()["project_id"]

        try:
            d1 = client.get(f"/api/projects/{id1}").json()
            assert d1["whisper_model"] == "base"
        finally:
            client.delete(f"/api/projects/{id1}")

        # 2. Explicit 'small' model in local mode is respected
        files2 = {"file": ("local_small.wav", io.BytesIO(wav_bytes), "audio/wav")}
        data2 = {"title": "Local Small", "whisper_model": "small", "auto_process": "false"}
        resp2 = client.post("/api/projects/import", files=files2, data=data2)
        assert resp2.status_code == status.HTTP_201_CREATED
        assert resp2.json()["whisper_model"] == "small"
        id2 = resp2.json()["project_id"]

        try:
            d2 = client.get(f"/api/projects/{id2}").json()
            assert d2["whisper_model"] == "small"
        finally:
            client.delete(f"/api/projects/{id2}")

        # 3. Explicit 'tiny' model in local mode is also respected
        files3 = {"file": ("local_tiny.wav", io.BytesIO(wav_bytes), "audio/wav")}
        data3 = {"title": "Local Tiny", "whisper_model": "tiny", "auto_process": "false"}
        resp3 = client.post("/api/projects/import", files=files3, data=data3)
        assert resp3.status_code == status.HTTP_201_CREATED
        assert resp3.json()["whisper_model"] == "tiny"
        id3 = resp3.json()["project_id"]

        try:
            d3 = client.get(f"/api/projects/{id3}").json()
            assert d3["whisper_model"] == "tiny"
        finally:
            client.delete(f"/api/projects/{id3}")


def test_cloud_model_metadata_consistency_across_all_endpoints():
    """Verify that cloud import response, list view, and detail view all consistently report 'tiny'."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()
        wav_bytes = make_test_wav_bytes(duration_s=1.0)

        # Import without model parameter
        files = {"file": ("consistency_test.wav", io.BytesIO(wav_bytes), "audio/wav")}
        data = {"title": "Consistency Project", "auto_process": "false"}

        import_resp = client.post(
            "/api/projects/import",
            files=files,
            data=data,
            headers=make_auth_headers(),
        )
        assert import_resp.status_code == status.HTTP_201_CREATED
        import_data = import_resp.json()
        assert import_data["whisper_model"] == "tiny"
        proj_id = import_data["project_id"]

        try:
            # Check detail view
            detail_resp = client.get(f"/api/projects/{proj_id}", headers=make_auth_headers())
            assert detail_resp.status_code == status.HTTP_200_OK
            detail_data = detail_resp.json()
            assert detail_data["whisper_model"] == "tiny"

            # Check list view
            list_resp = client.get("/api/projects", headers=make_auth_headers())
            assert list_resp.status_code == status.HTTP_200_OK
            list_items = list_resp.json()
            matching = [p for p in list_items if p["id"] == proj_id]
            assert len(matching) == 1
            assert matching[0]["whisper_model"] == "tiny"
        finally:
            client.delete(f"/api/projects/{proj_id}", headers=make_auth_headers())

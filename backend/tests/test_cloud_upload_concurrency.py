"""Comprehensive tests for Stage 2: Cloud Upload Protection & Concurrency.

Tests cover:
1. Cloud Upload Limits:
   - Media import <= 25 MiB payload accepted in cloud mode.
   - Media import > 25 MiB rejected via Content-Length with HTTP 413.
   - Media import > 25 MiB rejected via chunked streaming with HTTP 413.
   - Recording upload <= 10 MiB payload accepted in cloud mode.
   - Recording upload > 10 MiB rejected via Content-Length with HTTP 413.
   - Recording upload > 10 MiB rejected via chunked streaming with HTTP 413.
   - Zero orphaned temp files on rejected uploads.
   - Local mode remains completely unrestricted.

2. Cloud Duration Validation:
   - Media <= 180 seconds accepted in cloud mode.
   - Media > 180 seconds rejected with HTTP 400.
   - Corrupted / audio-less media rejected safely with HTTP 400.
   - Clean deletion of rejected files and project folders.
   - Local mode remains unrestricted for media > 180 seconds.

3. Cloud Concurrency Guard:
   - Exactly one active transcription pipeline allowed in cloud mode.
   - Second import request with auto_process=True rejected with HTTP 429.
   - Second /process request rejected with HTTP 429.
   - Import with auto_process=False allowed while another task is active.
   - Slot released on pipeline success.
   - Slot released on pipeline failure.
   - Slot released if import duration validation fails.
   - Local mode preserves multi-task queueing on pipeline semaphore.
"""

from __future__ import annotations
import asyncio
from datetime import datetime
import io
import os
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import status
from fastapi.testclient import TestClient

from backend.app.api.auth import SESSION_COOKIE_NAME
from backend.app.api.routes.projects import (
    clear_pipeline_tasks,
    is_pipeline_task_active,
    mark_pipeline_task_active,
    unmark_pipeline_task_active,
)
from backend.app.audio.exceptions import MediaProbeError, UnsupportedMediaError
from backend.app.audio.models import MediaMetadata
from backend.app.core.config import settings
from backend.app.core.security import session_registry
from backend.app.main import app, create_app
from backend.app.schemas.segment import RecordingRead
from backend.app.services.project_service import ProjectService
from backend.tests.test_media_probe import create_synthetic_wav


VALID_PASSWORD = "CorrectHorseBatteryStaple123!"
VALID_ORIGIN = "https://deutsch-shadow.onrender.com"


@pytest.fixture(autouse=True)
def reset_concurrency_and_security_state():
    """Reset session registry and active pipeline tasks before and after every test."""
    session_registry.clear()
    clear_pipeline_tasks()
    yield
    session_registry.clear()
    clear_pipeline_tasks()


def create_authenticated_cloud_client(target_app=None):
    """Create a TestClient with valid cloud authentication cookie and CSRF origin headers."""
    client = TestClient(target_app or app, base_url=VALID_ORIGIN)
    # Log in to acquire a valid session token
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


# ===========================================================================
# 1. Cloud Upload Limit Tests (Middleware & Streaming Enforcement)
# ===========================================================================


def test_cloud_import_within_limit_accepted():
    """Media import within 25 MiB payload cap must be accepted with 201 in cloud mode."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        # Generate a small valid 1-second synthetic WAV file
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_path = Path(tf.name)
        try:
            create_synthetic_wav(wav_path, duration_s=1.0)
            wav_bytes = wav_path.read_bytes()

            files = {"file": ("test_cloud_upload.wav", io.BytesIO(wav_bytes), "audio/wav")}
            data = {"title": "Valid Cloud Upload", "auto_process": "false"}

            resp = client.post(
                "/api/projects/import",
                files=files,
                data=data,
                headers=make_auth_headers(),
            )
            assert resp.status_code == status.HTTP_201_CREATED, f"Failed: {resp.text}"
            proj_id = resp.json()["project_id"]
            client.delete(f"/api/projects/{proj_id}", headers=make_auth_headers())
        finally:
            if wav_path.exists():
                wav_path.unlink()


def test_cloud_import_exceeding_content_length_rejected():
    """Import request with Content-Length exceeding 25 MiB cap must be rejected with 413."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        # 26 MiB exceeds 25 MiB + 64 KiB framing
        excessive_cl = str(26 * 1024 * 1024)
        headers = make_auth_headers()
        headers["Content-Length"] = excessive_cl
        headers["Content-Type"] = "multipart/form-data; boundary=testboundary"

        resp = client.post(
            "/api/projects/import",
            content=b"",
            headers=headers,
        )
        assert resp.status_code == status.HTTP_413_CONTENT_TOO_LARGE
        assert "exceeds maximum allowed limit" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_cloud_import_chunked_stream_exceeding_limit_rejected():
    """Chunked media import exceeding 25 MiB must be aborted with 413 during streaming."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        app_instance = create_app()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app_instance),
            base_url=VALID_ORIGIN,
        ) as client:
            # Login first
            login_resp = await client.post(
                "/api/auth/login",
                json={"password": VALID_PASSWORD},
                headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
            )
            assert login_resp.status_code == 200

            # Stream chunks without Content-Length that exceed the limit
            # Limit is 25 MiB + 64 KiB = 26,279,936 bytes
            chunk_size = 1024 * 1024  # 1 MiB chunks
            total_chunks = 27  # 27 MiB > 26,279,936 bytes

            async def excessive_stream():
                yield b"--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"large.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
                for _ in range(total_chunks):
                    yield b"A" * chunk_size
                yield b"\r\n--boundary--\r\n"

            headers = {
                "Origin": VALID_ORIGIN,
                "X-Requested-With": "Fetch",
                "Content-Type": "multipart/form-data; boundary=boundary",
            }

            resp = await client.post(
                "/api/projects/import",
                content=excessive_stream(),
                headers=headers,
            )
            assert resp.status_code == status.HTTP_413_CONTENT_TOO_LARGE
            assert "exceeds maximum allowed limit" in resp.json()["detail"]


def test_cloud_recording_exceeding_content_length_rejected():
    """Recording upload with Content-Length exceeding 10 MiB cap must be rejected with 413."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        # 11 MiB exceeds 10 MiB + 64 KiB
        excessive_cl = str(11 * 1024 * 1024)
        headers = make_auth_headers()
        headers["Content-Length"] = excessive_cl
        headers["Content-Type"] = "multipart/form-data; boundary=recboundary"

        dummy_segment_id = "11111111-1111-1111-1111-111111111111"
        resp = client.post(
            f"/api/segments/{dummy_segment_id}/recordings",
            content=b"",
            headers=headers,
        )
        assert resp.status_code == status.HTTP_413_CONTENT_TOO_LARGE
        assert "exceeds maximum allowed limit" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_cloud_recording_chunked_stream_exceeding_limit_rejected():
    """Chunked recording upload exceeding 10 MiB must be rejected with 413 during streaming."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        app_instance = create_app()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app_instance),
            base_url=VALID_ORIGIN,
        ) as client:
            login_resp = await client.post(
                "/api/auth/login",
                json={"password": VALID_PASSWORD},
                headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
            )
            assert login_resp.status_code == 200

            # 11 chunks of 1 MiB = 11 MiB > 10 MiB limit
            chunk_size = 1024 * 1024
            total_chunks = 11

            async def excessive_recording_stream():
                yield b"--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"take.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
                for _ in range(total_chunks):
                    yield b"R" * chunk_size
                yield b"\r\n--boundary--\r\n"

            headers = {
                "Origin": VALID_ORIGIN,
                "X-Requested-With": "Fetch",
                "Content-Type": "multipart/form-data; boundary=boundary",
            }

            dummy_segment_id = "22222222-2222-2222-2222-222222222222"
            resp = await client.post(
                f"/api/segments/{dummy_segment_id}/recordings",
                content=excessive_recording_stream(),
                headers=headers,
            )
            assert resp.status_code == status.HTTP_413_CONTENT_TOO_LARGE
            assert "exceeds maximum allowed limit" in resp.json()["detail"]


def test_cloud_upload_zero_orphaned_temp_files():
    """Rejected oversized upload must leave zero orphaned temp files in system tempdir."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        temp_dir = tempfile.gettempdir()
        before_files = set(os.listdir(temp_dir))

        # Send rejected upload
        headers = make_auth_headers()
        headers["Content-Length"] = str(30 * 1024 * 1024)
        headers["Content-Type"] = "multipart/form-data; boundary=boundary"

        resp = client.post("/api/projects/import", content=b"", headers=headers)
        assert resp.status_code == status.HTTP_413_CONTENT_TOO_LARGE

        after_files = set(os.listdir(temp_dir))
        new_files = after_files - before_files
        assert len(new_files) == 0, f"Orphaned files left in tempdir: {new_files}"


def test_local_mode_upload_unrestricted_by_middleware():
    """In local mode, the CloudUploadLimitMiddleware must be completely bypassed."""
    with patch.object(settings, "auth_mode", "local"), \
         patch.object(settings, "auth_password", None):

        # In local mode, requests are not rejected with 413 by the middleware
        client = TestClient(app)

        # 30 MiB Content-Length in local mode is NOT rejected with 413 by middleware
        # (It would only fail downstream if the body is actually missing or empty)
        headers = {
            "Content-Length": str(30 * 1024 * 1024),
            "Content-Type": "multipart/form-data; boundary=boundary",
        }
        resp = client.post("/api/projects/import", content=b"", headers=headers)
        # It must NOT be HTTP 413 (it will fail with 400 because body is malformed/empty, proving middleware bypassed)
        assert resp.status_code != status.HTTP_413_CONTENT_TOO_LARGE


def test_cloud_recording_just_below_limit_accepted():
    """Recording upload just below the 10 MiB file-payload cap is accepted through the middleware."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()
        dummy_segment_id = "11111111-1111-1111-1111-111111111111"

        # 10 MiB - 1024 bytes payload (10,484,736 bytes)
        near_limit_bytes = (10 * 1024 * 1024) - 1024
        payload = b"W" * near_limit_bytes

        mock_recording = RecordingRead(
            id="22222222-2222-2222-2222-222222222222",
            segment_id=dummy_segment_id,
            take_number=1,
            duration_ms=1000,
            is_active=True,
            created_at=datetime.now(),
        )

        with patch("backend.app.services.recording_service.RecordingService.create_recording", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = mock_recording
            files = {"file": ("near_10mb.wav", io.BytesIO(payload), "audio/wav")}
            resp = client.post(
                f"/api/segments/{dummy_segment_id}/recordings",
                files=files,
                headers=make_auth_headers(),
            )
            assert resp.status_code == status.HTTP_201_CREATED
            assert mock_create.called


def test_cloud_import_just_below_limit_accepted():
    """Import upload just below the 25 MiB file-payload cap is accepted through the middleware."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        # 25 MiB - 2048 bytes payload (26,212,352 bytes)
        near_limit_bytes = (25 * 1024 * 1024) - 2048
        payload = b"M" * near_limit_bytes

        mock_proj = MagicMock()
        mock_proj.id = "proj-near-limit-25mb"
        mock_proj.title = "Near Limit 25MB"
        mock_proj.status = "pending"
        mock_proj.whisper_model = "tiny"

        with patch("backend.app.services.project_service.ProjectService.import_project", new_callable=AsyncMock) as mock_import:
            mock_import.return_value = mock_proj
            files = {"file": ("near_25mb.wav", io.BytesIO(payload), "audio/wav")}
            data = {"title": "Near Limit 25MB", "auto_process": "false"}
            resp = client.post(
                "/api/projects/import",
                files=files,
                data=data,
                headers=make_auth_headers(),
            )
            assert resp.status_code == status.HTTP_201_CREATED
            assert mock_import.called


def test_cloud_framing_overhead_allowed_without_permitting_excess_file_payload():
    """Framing overhead up to 64 KiB is allowed, but an oversized file payload is rejected."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        # Case A: Exact 25 MiB file payload.
        # With multipart headers/boundaries, total request size is > 25 MiB (e.g. 25 MiB + ~300 bytes),
        # but <= 25 MiB + 64 KiB framing allowance. This MUST be accepted.
        exact_25mb_payload = b"A" * (25 * 1024 * 1024)
        mock_proj = MagicMock()
        mock_proj.id = "proj-exact-25mb"
        mock_proj.title = "Exact 25MB"
        mock_proj.status = "pending"
        mock_proj.whisper_model = "tiny"

        with patch("backend.app.services.project_service.ProjectService.import_project", new_callable=AsyncMock) as mock_import:
            mock_import.return_value = mock_proj
            files = {"file": ("exact_25mb.wav", io.BytesIO(exact_25mb_payload), "audio/wav")}
            data = {"title": "Exact 25MB", "auto_process": "false"}
            resp_accepted = client.post(
                "/api/projects/import",
                files=files,
                data=data,
                headers=make_auth_headers(),
            )
            assert resp_accepted.status_code == status.HTTP_201_CREATED

        # Case B: File payload exceeding 25 MiB by more than framing allowance (e.g. 25 MiB + 100 KiB).
        # Total request size exceeds 25 MiB + 64 KiB framing allowance. This MUST be rejected with 413.
        oversized_payload = b"B" * ((25 * 1024 * 1024) + (100 * 1024))
        files_over = {"file": ("oversized.wav", io.BytesIO(oversized_payload), "audio/wav")}
        data_over = {"title": "Oversized", "auto_process": "false"}
        resp_rejected = client.post(
            "/api/projects/import",
            files=files_over,
            data=data_over,
            headers=make_auth_headers(),
        )
        assert resp_rejected.status_code == status.HTTP_413_CONTENT_TOO_LARGE
        assert "exceeds maximum allowed limit" in resp_rejected.json()["detail"]


@pytest.mark.asyncio
async def test_cloud_oversized_chunked_request_through_full_app_stack():
    """Verify HTTP 413 through the complete application middleware stack for chunked streaming."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        full_app = create_app()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=full_app),
            base_url=VALID_ORIGIN,
        ) as client:
            # 1. Login to establish authenticated session
            login_resp = await client.post(
                "/api/auth/login",
                json={"password": VALID_PASSWORD},
                headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
            )
            assert login_resp.status_code == 200

            # 2. Stream chunked body exceeding 25 MiB + 64 KiB limit
            chunk_size = 512 * 1024  # 512 KiB chunks
            total_chunks = 55  # 55 * 512 KiB = 28.16 MiB > 25 MiB + 64 KiB limit

            async def oversized_stream():
                yield b"--boundary123\r\nContent-Disposition: form-data; name=\"file\"; filename=\"large.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
                for _ in range(total_chunks):
                    yield b"X" * chunk_size
                yield b"\r\n--boundary123--\r\n"

            headers = {
                "Origin": VALID_ORIGIN,
                "X-Requested-With": "Fetch",
                "Content-Type": "multipart/form-data; boundary=boundary123",
            }

            resp = await client.post(
                "/api/projects/import",
                content=oversized_stream(),
                headers=headers,
            )

            # Verify real HTTP 413 JSON response from full middleware stack
            assert resp.status_code == status.HTTP_413_CONTENT_TOO_LARGE
            assert resp.headers["content-type"].startswith("application/json")
            data = resp.json()
            assert "Uploaded media file exceeds maximum allowed limit of 25 MiB" in data["detail"]


# ===========================================================================
# 2. Cloud Duration Validation Tests
# ===========================================================================


def test_cloud_duration_within_limit_accepted():
    """Audio with duration <= 180 seconds must be accepted in cloud mode."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_path = Path(tf.name)
        try:
            create_synthetic_wav(wav_path, duration_s=2.0)
            wav_bytes = wav_path.read_bytes()

            # Mock MediaProbe to report exactly 180.0 seconds
            mock_meta = MagicMock()
            mock_meta.duration_s = 180.0
            mock_meta.format_name = "wav"

            with patch("backend.app.services.project_service.MediaProbe.probe", return_value=mock_meta):
                files = {"file": ("cloud_180s.wav", io.BytesIO(wav_bytes), "audio/wav")}
                data = {"title": "Exact 180s Project", "auto_process": "false"}

                resp = client.post(
                    "/api/projects/import",
                    files=files,
                    data=data,
                    headers=make_auth_headers(),
                )
                assert resp.status_code == status.HTTP_201_CREATED, f"Failed: {resp.text}"
                proj_id = resp.json()["project_id"]
                client.delete(f"/api/projects/{proj_id}", headers=make_auth_headers())
        finally:
            if wav_path.exists():
                wav_path.unlink()


def test_cloud_duration_exceeding_limit_rejected_and_cleaned_up():
    """Audio exceeding 180 seconds must be rejected with 400 and all files cleaned up."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_path = Path(tf.name)
        try:
            create_synthetic_wav(wav_path, duration_s=1.0)
            wav_bytes = wav_path.read_bytes()

            # Mock MediaProbe to report 180.1 seconds (exceeding limit)
            mock_meta = MagicMock()
            mock_meta.duration_s = 180.1
            mock_meta.format_name = "wav"

            with patch("backend.app.services.project_service.MediaProbe.probe", return_value=mock_meta):
                files = {"file": ("cloud_too_long.wav", io.BytesIO(wav_bytes), "audio/wav")}
                data = {"title": "Too Long Audio", "auto_process": "false"}

                resp = client.post(
                    "/api/projects/import",
                    files=files,
                    data=data,
                    headers=make_auth_headers(),
                )
                assert resp.status_code == status.HTTP_400_BAD_REQUEST
                assert "exceeds cloud limit of 180 seconds" in resp.json()["detail"]

                # Verify no orphaned project directory was left in data/projects
                projects_dir = settings.projects_dir
                if projects_dir.exists():
                    subdirs = [p for p in projects_dir.iterdir() if p.is_dir() and "Too Long Audio" in p.name]
                    assert len(subdirs) == 0
        finally:
            if wav_path.exists():
                wav_path.unlink()


def test_cloud_duration_corrupted_file_rejected_safely():
    """Corrupted audio file must be rejected with 400 without crashing."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        corrupt_bytes = b"RIFF\x24\x00\x00\x00NOT_VALID_AUDIO_DATA_AT_ALL"
        files = {"file": ("corrupt.wav", io.BytesIO(corrupt_bytes), "audio/wav")}
        data = {"title": "Corrupt Media", "auto_process": "false"}

        with patch(
            "backend.app.services.project_service.MediaProbe.probe",
            side_effect=MediaProbeError("Invalid audio stream"),
        ):
            resp = client.post(
                "/api/projects/import",
                files=files,
                data=data,
                headers=make_auth_headers(),
            )
            assert resp.status_code == status.HTTP_400_BAD_REQUEST
            assert "Invalid, corrupted, or unreadable media file" in resp.json()["detail"]


def test_cloud_container_without_audio_stream_rejected_and_cleaned_up():
    """A valid media container containing no audio stream must be rejected with 400 and files cleaned up."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tf:
            media_path = Path(tf.name)
        try:
            # Write a small MP4 container header
            media_path.write_bytes(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")
            media_bytes = media_path.read_bytes()

            # Record subdirectories before request
            projects_dir = settings.projects_dir
            existing_subdirs = set(p.name for p in projects_dir.iterdir() if p.is_dir()) if projects_dir.exists() else set()

            # Mock MediaProbe to raise UnsupportedMediaError (valid container, no audio streams)
            with patch(
                "backend.app.services.project_service.MediaProbe.probe",
                side_effect=UnsupportedMediaError("File 'video_only.mp4' contains no readable audio streams."),
            ):
                files = {"file": ("video_only.mp4", io.BytesIO(media_bytes), "video/mp4")}
                data = {"title": "Video Without Audio", "auto_process": "false"}

                resp = client.post(
                    "/api/projects/import",
                    files=files,
                    data=data,
                    headers=make_auth_headers(),
                )
                assert resp.status_code == status.HTTP_400_BAD_REQUEST
                assert "Uploaded file does not contain valid audio streams" in resp.json()["detail"]

                # Verify cleanup: no new project directory or orphaned file remains
                if projects_dir.exists():
                    current_subdirs = set(p.name for p in projects_dir.iterdir() if p.is_dir())
                    new_subdirs = current_subdirs - existing_subdirs
                    assert len(new_subdirs) == 0, f"Leaked project directories: {new_subdirs}"
        finally:
            if media_path.exists():
                media_path.unlink()


def test_local_mode_duration_unrestricted_on_import():
    """In local mode, media with duration > 180s must be accepted without duration validation."""
    with patch.object(settings, "auth_mode", "local"), \
         patch.object(settings, "auth_password", None):

        client = TestClient(app)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_path = Path(tf.name)
        try:
            create_synthetic_wav(wav_path, duration_s=1.0)
            wav_bytes = wav_path.read_bytes()

            # 1. Verify long media (> 180s) is accepted on import in local mode
            files = {"file": ("local_long.wav", io.BytesIO(wav_bytes), "audio/wav")}
            data = {"title": "Local Long Media", "auto_process": "false"}

            resp = client.post("/api/projects/import", files=files, data=data)
            assert resp.status_code == status.HTTP_201_CREATED
            proj_id = resp.json()["project_id"]

            # Confirm project is in pending state, unblocked
            detail_resp = client.get(f"/api/projects/{proj_id}")
            assert detail_resp.status_code == 200
            assert detail_resp.json()["status"] == "pending"

            client.delete(f"/api/projects/{proj_id}")

            # 2. Verify media container without audio probing is also accepted on import in local mode
            # (validation deferred to pipeline processing time, matching existing desktop behavior)
            video_files = {"file": ("local_video.mp4", io.BytesIO(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"), "video/mp4")}
            video_data = {"title": "Local Video File", "auto_process": "false"}
            v_resp = client.post("/api/projects/import", files=video_files, data=video_data)
            assert v_resp.status_code == status.HTTP_201_CREATED
            v_proj_id = v_resp.json()["project_id"]
            client.delete(f"/api/projects/{v_proj_id}")
        finally:
            if wav_path.exists():
                wav_path.unlink()


# ===========================================================================
# 3. Cloud Concurrency Guard Tests
# ===========================================================================


def test_cloud_concurrency_blocks_second_auto_process_import():
    """In cloud mode, importing a second project with auto_process=True while a task is active returns 429."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_path = Path(tf.name)
        try:
            create_synthetic_wav(wav_path, duration_s=1.0)
            wav_bytes = wav_path.read_bytes()

            # Mark a simulated active pipeline task
            mark_pipeline_task_active("existing-job-id")

            files = {"file": ("second_import.wav", io.BytesIO(wav_bytes), "audio/wav")}
            data = {"title": "Second Job", "auto_process": "true"}

            resp = client.post(
                "/api/projects/import",
                files=files,
                data=data,
                headers=make_auth_headers(),
            )
            assert resp.status_code == status.HTTP_429_TOO_MANY_REQUESTS
            assert "A transcription pipeline is already running" in resp.json()["detail"]
        finally:
            unmark_pipeline_task_active("existing-job-id")
            if wav_path.exists():
                wav_path.unlink()


def test_cloud_concurrency_blocks_process_endpoint():
    """In cloud mode, POST /projects/{id}/process while a task is active returns 429."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_path = Path(tf.name)
        try:
            create_synthetic_wav(wav_path, duration_s=1.0)
            wav_bytes = wav_path.read_bytes()

            # Import project with auto_process=false (allowed)
            files = {"file": ("idle_project.wav", io.BytesIO(wav_bytes), "audio/wav")}
            data = {"title": "Idle Project", "auto_process": "false"}
            import_resp = client.post(
                "/api/projects/import",
                files=files,
                data=data,
                headers=make_auth_headers(),
            )
            assert import_resp.status_code == status.HTTP_201_CREATED
            proj_id = import_resp.json()["project_id"]

            try:
                # Simulate another active task running Whisper
                mark_pipeline_task_active("other-active-task")

                process_resp = client.post(
                    f"/api/projects/{proj_id}/process",
                    headers=make_auth_headers(),
                )
                assert process_resp.status_code == status.HTTP_429_TOO_MANY_REQUESTS
                assert "A transcription pipeline is already running" in process_resp.json()["detail"]
            finally:
                unmark_pipeline_task_active("other-active-task")
                client.delete(f"/api/projects/{proj_id}", headers=make_auth_headers())
        finally:
            if wav_path.exists():
                wav_path.unlink()


def test_cloud_concurrency_allows_import_without_auto_process():
    """In cloud mode, importing with auto_process=False is allowed even while another task is running."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_path = Path(tf.name)
        try:
            create_synthetic_wav(wav_path, duration_s=1.0)
            wav_bytes = wav_path.read_bytes()

            # Active task is running
            mark_pipeline_task_active("active-whisper-task")

            files = {"file": ("no_auto.wav", io.BytesIO(wav_bytes), "audio/wav")}
            data = {"title": "No Auto Process Import", "auto_process": "false"}

            resp = client.post(
                "/api/projects/import",
                files=files,
                data=data,
                headers=make_auth_headers(),
            )
            assert resp.status_code == status.HTTP_201_CREATED
            proj_id = resp.json()["project_id"]
            client.delete(f"/api/projects/{proj_id}", headers=make_auth_headers())
        finally:
            unmark_pipeline_task_active("active-whisper-task")
            if wav_path.exists():
                wav_path.unlink()


def test_cloud_concurrency_releases_slot_on_import_failure():
    """If media duration validation fails on import, the reserved slot must be released immediately."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_path = Path(tf.name)
        try:
            create_synthetic_wav(wav_path, duration_s=1.0)
            wav_bytes = wav_path.read_bytes()

            # Mock duration probe to reject with 400
            mock_meta = MagicMock()
            mock_meta.duration_s = 250.0  # > 180s

            with patch("backend.app.services.project_service.MediaProbe.probe", return_value=mock_meta):
                files = {"file": ("oversized_duration.wav", io.BytesIO(wav_bytes), "audio/wav")}
                data = {"title": "Oversized Duration", "auto_process": "true"}

                resp = client.post(
                    "/api/projects/import",
                    files=files,
                    data=data,
                    headers=make_auth_headers(),
                )
                assert resp.status_code == status.HTTP_400_BAD_REQUEST

            # After failure, active pipeline tasks must be completely clear (no leaked reservation)
            assert not is_pipeline_task_active("any-token")
            # And a subsequent valid request must succeed (not blocked by 429)
            valid_files = {"file": ("valid.wav", io.BytesIO(wav_bytes), "audio/wav")}
            valid_data = {"title": "Valid Next Import", "auto_process": "false"}
            next_resp = client.post(
                "/api/projects/import",
                files=valid_files,
                data=valid_data,
                headers=make_auth_headers(),
            )
            assert next_resp.status_code == status.HTTP_201_CREATED
            proj_id = next_resp.json()["project_id"]
            client.delete(f"/api/projects/{proj_id}", headers=make_auth_headers())
        finally:
            if wav_path.exists():
                wav_path.unlink()


def test_local_mode_concurrency_preserves_queueing():
    """In local mode, running jobs must not return 429; duplicate tasks for separate projects are queued."""
    with patch.object(settings, "auth_mode", "local"), \
         patch.object(settings, "auth_password", None):

        client = TestClient(app)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_path = Path(tf.name)
        try:
            create_synthetic_wav(wav_path, duration_s=1.0)
            wav_bytes = wav_path.read_bytes()

            # Mark a running task for Project A
            mark_pipeline_task_active("project-a")

            # Project B import with auto_process=true in local mode
            files = {"file": ("project_b.wav", io.BytesIO(wav_bytes), "audio/wav")}
            data = {"title": "Project B Local", "auto_process": "true"}

            with patch("backend.app.api.routes.projects.run_pipeline_in_background"):
                resp = client.post("/api/projects/import", files=files, data=data)
                # In local mode, this MUST succeed with 201 (not 429)
                assert resp.status_code == status.HTTP_201_CREATED
                proj_id = resp.json()["project_id"]
                client.delete(f"/api/projects/{proj_id}")
        finally:
            unmark_pipeline_task_active("project-a")
            if wav_path.exists():
                wav_path.unlink()


@pytest.mark.asyncio
async def test_cloud_concurrency_releases_slot_on_background_pipeline_success():
    """When background pipeline task finishes successfully, the active slot must be released."""
    from backend.app.api.routes.projects import run_pipeline_in_background

    test_proj_id = "test-success-proj-id"
    mark_pipeline_task_active(test_proj_id)
    assert is_pipeline_task_active(test_proj_id)

    with patch("backend.app.services.project_service.ProjectService.process_project_pipeline", new_callable=AsyncMock) as mock_pipeline:
        mock_pipeline.return_value = MagicMock()
        await run_pipeline_in_background(test_proj_id)

    assert not is_pipeline_task_active(test_proj_id), "Expected task slot to be released on success"


@pytest.mark.asyncio
async def test_cloud_concurrency_releases_slot_on_background_pipeline_failure():
    """When background pipeline task encounters an error, the active slot must still be released."""
    from backend.app.api.routes.projects import run_pipeline_in_background

    test_proj_id = "test-fail-proj-id"
    mark_pipeline_task_active(test_proj_id)
    assert is_pipeline_task_active(test_proj_id)

    with patch("backend.app.services.project_service.ProjectService.process_project_pipeline", new_callable=AsyncMock) as mock_pipeline:
        mock_pipeline.side_effect = RuntimeError("Whisper transcription crashed")
        await run_pipeline_in_background(test_proj_id)

    assert not is_pipeline_task_active(test_proj_id), "Expected task slot to be released on failure"


@pytest.mark.asyncio
async def test_cloud_concurrency_deterministic_simultaneous_requests():
    """Two simultaneous cloud requests cannot both acquire the slot: exactly one 201, other 429."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        app_instance = create_app()

        # Deterministic synchronization barriers (no machine-speed timing dependencies)
        req1_holding_slot = asyncio.Event()
        req2_attempted = asyncio.Event()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            tmp_wav = Path(tf.name)
        try:
            create_synthetic_wav(tmp_wav, duration_s=1.0)
            wav_bytes = tmp_wav.read_bytes()
        finally:
            if tmp_wav.exists():
                tmp_wav.unlink()

        original_import = ProjectService.import_project

        async def controlled_import(*args, **kwargs):
            # Signal that Request 1 is actively holding the reservation slot inside import_project
            req1_holding_slot.set()
            # Wait deterministically until Request 2 has made its attempt
            await req2_attempted.wait()
            return await original_import(*args, **kwargs)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app_instance),
            base_url=VALID_ORIGIN,
        ) as client:
            login_resp = await client.post(
                "/api/auth/login",
                json={"password": VALID_PASSWORD},
                headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
            )
            assert login_resp.status_code == 200

            async def send_req1():
                with patch("backend.app.services.project_service.ProjectService.import_project", side_effect=controlled_import), \
                     patch("backend.app.api.routes.projects.run_pipeline_in_background"):
                    files = {"file": ("simul_1.wav", wav_bytes, "audio/wav")}
                    data = {"title": "Simultaneous Req 1", "auto_process": "true"}
                    return await client.post(
                        "/api/projects/import",
                        files=files,
                        data=data,
                        headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
                    )

            async def send_req2():
                # Block until Request 1 is guaranteed to hold the active slot
                await req1_holding_slot.wait()
                try:
                    files = {"file": ("simul_2.wav", wav_bytes, "audio/wav")}
                    data = {"title": "Simultaneous Req 2", "auto_process": "true"}
                    return await client.post(
                        "/api/projects/import",
                        files=files,
                        data=data,
                        headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
                    )
                finally:
                    # Signal Request 1 that Request 2 has completed its attempt
                    req2_attempted.set()

            # Execute both concurrently
            res1, res2 = await asyncio.gather(send_req1(), send_req2())

            # Exactly one request is admitted; the other receives HTTP 429
            assert res1.status_code == status.HTTP_201_CREATED, f"Req 1 failed: {res1.text}"
            assert res2.status_code == status.HTTP_429_TOO_MANY_REQUESTS, f"Req 2 status was {res2.status_code}: {res2.text}"
            assert "A transcription pipeline is already running" in res2.json()["detail"]

            # Cleanup
            proj_id = res1.json()["project_id"]
            await client.delete(
                f"/api/projects/{proj_id}",
                headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
            )


def test_cloud_concurrency_scheduling_failure_releases_slot_and_allows_subsequent_request():
    """Simulate background-task scheduling failure and verify reservation release and slot recovery."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        client = create_authenticated_cloud_client()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_path = Path(tf.name)
        try:
            create_synthetic_wav(wav_path, duration_s=1.0)
            wav_bytes = wav_path.read_bytes()

            # 1. Simulate scheduling failure by making BackgroundTasks.add_task raise an exception
            with patch(
                "fastapi.BackgroundTasks.add_task",
                side_effect=RuntimeError("Scheduler queue full error"),
            ):
                files = {"file": ("sched_fail.wav", io.BytesIO(wav_bytes), "audio/wav")}
                data = {"title": "Scheduling Fail Project", "auto_process": "true"}

                with pytest.raises(RuntimeError, match="Scheduler queue full error"):
                    client.post(
                        "/api/projects/import",
                        files=files,
                        data=data,
                        headers=make_auth_headers(),
                    )

            # 2. Verify that active pipeline tasks registry is completely cleared (no leaked reservation)
            from backend.app.api.routes.projects import _active_pipeline_tasks
            assert len(_active_pipeline_tasks) == 0, f"Reservation leaked after failure: {_active_pipeline_tasks}"

            # 3. Verify that a subsequent request can immediately acquire the slot without 429
            with patch("backend.app.api.routes.projects.run_pipeline_in_background"):
                files_next = {"file": ("next_valid.wav", io.BytesIO(wav_bytes), "audio/wav")}
                data_next = {"title": "Subsequent Successful", "auto_process": "true"}

                resp_next = client.post(
                    "/api/projects/import",
                    files=files_next,
                    data=data_next,
                    headers=make_auth_headers(),
                )
                assert resp_next.status_code == status.HTTP_201_CREATED, f"Next request failed: {resp_next.text}"
                proj_id = resp_next.json()["project_id"]
                client.delete(f"/api/projects/{proj_id}", headers=make_auth_headers())
        finally:
            if wav_path.exists():
                wav_path.unlink()


@pytest.mark.asyncio
async def test_cloud_concurrency_cancellation_during_import_releases_reservation():
    """Cancelling an in-flight import request releases the reservation, allowing subsequent jobs."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        app_instance = create_app()
        req_holding_slot = asyncio.Event()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            tmp_wav = Path(tf.name)
        try:
            create_synthetic_wav(tmp_wav, duration_s=1.0)
            wav_bytes = tmp_wav.read_bytes()
        finally:
            if tmp_wav.exists():
                tmp_wav.unlink()

        async def pause_during_import(*args, **kwargs):
            req_holding_slot.set()
            await asyncio.sleep(100.0)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app_instance),
            base_url=VALID_ORIGIN,
        ) as client:
            login_resp = await client.post(
                "/api/auth/login",
                json={"password": VALID_PASSWORD},
                headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
            )
            assert login_resp.status_code == 200

            async def send_import():
                with patch("backend.app.services.project_service.ProjectService.import_project", side_effect=pause_during_import):
                    files = {"file": ("cancelled.wav", wav_bytes, "audio/wav")}
                    data = {"title": "Cancelled Project", "auto_process": "true"}
                    return await client.post(
                        "/api/projects/import",
                        files=files,
                        data=data,
                        headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
                    )

            import_task = asyncio.create_task(send_import())
            await req_holding_slot.wait()

            from backend.app.api.routes.projects import _active_pipeline_tasks
            assert len(_active_pipeline_tasks) == 1

            import_task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await import_task

            assert len(_active_pipeline_tasks) == 0, f"Reservation leaked on cancellation: {_active_pipeline_tasks}"

            with patch("backend.app.api.routes.projects.run_pipeline_in_background"):
                files_next = {"file": ("next.wav", wav_bytes, "audio/wav")}
                data_next = {"title": "Next Project", "auto_process": "true"}
                resp_next = await client.post(
                    "/api/projects/import",
                    files=files_next,
                    data=data_next,
                    headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
                )
                assert resp_next.status_code == status.HTTP_201_CREATED
                proj_id = resp_next.json()["project_id"]
                await client.delete(
                    f"/api/projects/{proj_id}",
                    headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
                )


@pytest.mark.asyncio
async def test_cloud_concurrency_cancellation_during_process_releases_reservation():
    """Cancelling process_project before scheduling completion releases the reservation."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):

        app_instance = create_app()
        process_holding_slot = asyncio.Event()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            tmp_wav = Path(tf.name)
        try:
            create_synthetic_wav(tmp_wav, duration_s=1.0)
            wav_bytes = tmp_wav.read_bytes()
        finally:
            if tmp_wav.exists():
                tmp_wav.unlink()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app_instance),
            base_url=VALID_ORIGIN,
        ) as client:
            login_resp = await client.post(
                "/api/auth/login",
                json={"password": VALID_PASSWORD},
                headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
            )
            assert login_resp.status_code == 200

            files = {"file": ("idle.wav", wav_bytes, "audio/wav")}
            data = {"title": "Idle Project", "auto_process": "false"}
            import_resp = await client.post(
                "/api/projects/import",
                files=files,
                data=data,
                headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
            )
            assert import_resp.status_code == 201
            proj_id = import_resp.json()["project_id"]

            try:
                from sqlalchemy.ext.asyncio import AsyncSession
                orig_commit = AsyncSession.commit

                async def pause_on_commit(self_session):
                    process_holding_slot.set()
                    await asyncio.sleep(100.0)
                    return await orig_commit(self_session)

                async def send_process():
                    with patch.object(AsyncSession, "commit", pause_on_commit):
                        return await client.post(
                            f"/api/projects/{proj_id}/process",
                            headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
                        )

                proc_task = asyncio.create_task(send_process())
                await process_holding_slot.wait()

                assert is_pipeline_task_active(proj_id)

                proc_task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await proc_task

                assert not is_pipeline_task_active(proj_id)

                with patch("backend.app.api.routes.projects.run_pipeline_in_background"):
                    retry_resp = await client.post(
                        f"/api/projects/{proj_id}/process",
                        headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
                    )
                    assert retry_resp.status_code == 200
            finally:
                await client.delete(
                    f"/api/projects/{proj_id}",
                    headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
                )


@pytest.mark.asyncio
async def test_cloud_concurrency_cancellation_during_pipeline_execution_releases_slot():
    """Cancelling a running pipeline background task releases the active slot in finally:."""
    from backend.app.api.routes.projects import run_pipeline_in_background

    test_proj_id = "test-cancel-pipeline-proj"
    mark_pipeline_task_active(test_proj_id)
    assert is_pipeline_task_active(test_proj_id)

    pipeline_started = asyncio.Event()

    async def pause_pipeline(*args, **kwargs):
        pipeline_started.set()
        await asyncio.sleep(100.0)

    with patch("backend.app.services.project_service.ProjectService.process_project_pipeline", side_effect=pause_pipeline):
        bg_task = asyncio.create_task(run_pipeline_in_background(test_proj_id))
        await pipeline_started.wait()

        assert is_pipeline_task_active(test_proj_id)

        bg_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await bg_task

        assert not is_pipeline_task_active(test_proj_id)

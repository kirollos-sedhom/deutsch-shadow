"""Tests for cloud deployment configuration, single-pipeline concurrency, and static SPA serving."""

from __future__ import annotations
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from httpx import ASGITransport, AsyncClient

from backend.app.core.config import Settings
from backend.app.main import create_app
import backend.app.api.routes.projects as projects_module


class TestCloudPackagingConfig(unittest.TestCase):
    """Verify that cloud environment overrides work while preserving Windows defaults."""

    def test_default_settings_without_env_vars(self):
        """Default settings must remain identical for Windows local runs."""
        with patch.dict(os.environ, {}, clear=True):
            s = Settings()
            self.assertEqual(s.default_whisper_model, "base")
            self.assertEqual(s.default_cpu_threads, 4)
            self.assertEqual(s.default_compute_type, "int8")
            self.assertEqual(s.port, 8000)
            self.assertEqual(s.data_dir_name, "data")
            self.assertEqual(s.data_dir, (s.base_dir / "data").resolve())

    def test_cloud_environment_overrides(self):
        """Settings must cleanly pick up cloud/Render environment variables."""
        env = {
            "PORT": "10000",
            "DEUTSCH_SHADOW_DEFAULT_MODEL": "tiny",
            "DEUTSCH_SHADOW_CPU_THREADS": "1",
            "DEUTSCH_SHADOW_COMPUTE_TYPE": "int8",
            "DEUTSCH_SHADOW_DATA_DIR": "/custom/cloud/data",
        }
        with patch.dict(os.environ, env, clear=True):
            s = Settings()
            self.assertEqual(s.port, 10000)
            self.assertEqual(s.default_whisper_model, "tiny")
            self.assertEqual(s.default_cpu_threads, 1)
            self.assertEqual(s.default_compute_type, "int8")
            self.assertEqual(s.data_dir, Path("/custom/cloud/data").resolve())


class TestSinglePipelineSemaphore(unittest.IsolatedAsyncioTestCase):
    """Verify that background transcription jobs are serialized to respect memory limits."""

    def test_pipeline_semaphore_initial_value(self):
        """_pipeline_semaphore must exist with capacity 1."""
        self.assertTrue(hasattr(projects_module, "_pipeline_semaphore"))
        # A semaphore initialized to 1 allows exactly 1 acquisition before blocking
        self.assertEqual(projects_module._pipeline_semaphore._value, 1)


class TestStaticSpaServing(unittest.IsolatedAsyncioTestCase):
    """Verify that FastAPI serves static frontend distribution while protecting /api routes."""

    async def test_serves_spa_index_and_protects_api(self):
        """GET / must return index.html, /api/health must return JSON, and /api/404 must not return index.html."""
        app = create_app()
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. API route returns JSON
            health_res = await client.get("/api/health")
            self.assertEqual(health_res.status_code, 200)
            self.assertEqual(health_res.json()["status"], "healthy")

            # 2. Unmatched API route returns 404 JSON, NOT index.html
            missing_api_res = await client.get("/api/nonexistent_endpoint")
            self.assertEqual(missing_api_res.status_code, 404)
            self.assertIn("detail", missing_api_res.json())

            # 3. If frontend/dist exists, root / returns index.html (SPA entry)
            dist_index = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist" / "index.html"
            if dist_index.is_file():
                root_res = await client.get("/")
                self.assertEqual(root_res.status_code, 200)
                self.assertIn("<!DOCTYPE html>", root_res.text)

                # Client-side SPA route also returns index.html
                spa_route_res = await client.get("/projects/some-id")
                self.assertEqual(spa_route_res.status_code, 200)
                self.assertIn("<!DOCTYPE html>", spa_route_res.text)

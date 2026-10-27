"""Integration test suite for Milestone 4: Database models and REST API endpoints."""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.audio.pipeline import AudioPipeline
from backend.app.core.config import settings
from backend.app.db.base import Base
from backend.app.db.models import Project, Segment
from backend.app.db.session import get_db
from backend.app.main import app
from backend.app.services.project_service import ProjectService
from backend.tests.test_media_probe import create_synthetic_wav
from backend.tests.test_pipeline_e2e import MockGermanTranscriber


class TestMilestone4API(unittest.TestCase):
    """End-to-end integration tests for Project, Segment, Media streaming, and System APIs."""

    @classmethod
    def setUpClass(cls):
        # Create an isolated temporary test directory
        cls.temp_dir = Path(tempfile.mkdtemp(prefix="ds_test_m4_"))
        cls.orig_base_dir = settings.base_dir
        settings.base_dir = cls.temp_dir

        # Setup isolated SQLite test engine
        cls.test_db_path = cls.temp_dir / "test_deutsch_shadow.db"
        cls.test_db_url = f"sqlite+aiosqlite:///{cls.test_db_path.as_posix()}"
        cls.test_engine = create_async_engine(
            cls.test_db_url,
            echo=False,
            connect_args={"check_same_thread": False},
        )
        cls.TestSessionLocal = async_sessionmaker(
            bind=cls.test_engine,
            class_=AsyncSession,
            expire_on_commit=False,
            autocommit=False,
            autoflush=False,
        )

        # Create schema tables synchronously for testing
        import asyncio
        async def create_tables():
            async with cls.test_engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
        asyncio.run(create_tables())

        # Dependency override for FastAPI get_db
        async def override_get_db():
            async with cls.TestSessionLocal() as session:
                try:
                    yield session
                finally:
                    await session.close()

        app.dependency_overrides[get_db] = override_get_db
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        app.dependency_overrides.clear()
        import asyncio
        asyncio.run(cls.test_engine.dispose())
        settings.base_dir = cls.orig_base_dir
        shutil.rmtree(cls.temp_dir, ignore_errors=True)

    def test_01_system_capabilities(self):
        """GET /api/system/capabilities must return hardware specs and environment status."""
        resp = self.client.get("/api/system/capabilities")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreater(data["cpu_logical_cores"], 0)
        self.assertGreater(data["ram_total_gb"], 0.0)
        self.assertIn("cuda_available", data)
        self.assertTrue(data["ffmpeg_available"])
        self.assertIn(data["recommended_model"], ["base", "small"])

    def test_02_system_models(self):
        """GET /api/system/models must list available Whisper model tiers."""
        resp = self.client.get("/api/system/models")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIsInstance(data, list)
        names = [m["name"] for m in data]
        self.assertIn("base", names)
        self.assertIn("small", names)

    def test_03_project_import_validation(self):
        """POST /api/projects/import must reject unsupported extensions."""
        bad_file = ("bad.exe", b"executable bytes", "application/octet-stream")
        resp = self.client.post("/api/projects/import", files={"file": bad_file})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Unsupported media format", resp.json()["detail"])

    def test_04_project_lifecycle_and_segment_crud(self):
        """Full lifecycle: import, process pipeline, stream range audio, update, split, merge, delete."""
        # 1. Create a synthetic valid WAV media file
        wav_file_path = self.temp_dir / "test_sample.wav"
        create_synthetic_wav(wav_file_path, duration_s=4.0)

        # 2. Import project via API with auto_process=False for deterministic manual pipeline test
        with open(wav_file_path, "rb") as f:
            resp = self.client.post(
                "/api/projects/import",
                files={"file": ("test_sample.wav", f, "audio/wav")},
                data={"title": "Test German Episode", "auto_process": "false"},
            )
        self.assertEqual(resp.status_code, 201)
        import_data = resp.json()
        project_id = import_data["project_id"]
        self.assertEqual(import_data["title"], "Test German Episode")
        self.assertEqual(import_data["status"], "pending")

        # 3. Check GET /api/projects list
        list_resp = self.client.get("/api/projects")
        self.assertEqual(list_resp.status_code, 200)
        projects = list_resp.json()
        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0]["id"], project_id)
        self.assertEqual(projects[0]["segments_count"], 0)

        # 4. Check GET /api/projects/{id} detail
        detail_resp = self.client.get(f"/api/projects/{project_id}")
        self.assertEqual(detail_resp.status_code, 200)
        detail = detail_resp.json()
        self.assertEqual(detail["title"], "Test German Episode")
        self.assertIsNotNone(detail["settings"])
        self.assertEqual(detail["settings"]["blind_mode_default"], True)

        # 5. Process project pipeline using MockGermanTranscriber
        import asyncio
        async def run_mock_pipeline():
            async with self.TestSessionLocal() as session:
                mock_pipeline = AudioPipeline(transcriber=MockGermanTranscriber())
                await ProjectService.process_project_pipeline(
                    session=session,
                    project_id=project_id,
                    pipeline=mock_pipeline,
                )
        asyncio.run(run_mock_pipeline())

        # 6. Verify project is now 'ready' with 2 practice segments
        ready_resp = self.client.get(f"/api/projects/{project_id}")
        self.assertEqual(ready_resp.status_code, 200)
        ready_data = ready_resp.json()
        self.assertEqual(ready_data["status"], "ready")
        self.assertEqual(ready_data["segments_count"], 2)
        self.assertIsNotNone(ready_data["master_audio_path"])

        # 7. Verify GET /api/projects/{id}/segments
        segs_resp = self.client.get(f"/api/projects/{project_id}/segments")
        self.assertEqual(segs_resp.status_code, 200)
        segments = segs_resp.json()
        self.assertEqual(len(segments), 2)
        seg1, seg2 = segments[0], segments[1]
        self.assertEqual(seg1["sequence_index"], 1)
        self.assertEqual(seg1["text"], "Hallo zusammen.")
        self.assertEqual(seg2["sequence_index"], 2)
        self.assertEqual(seg2["text"], "Heute üben wir Schattensprechen.")

        # 8. Test HTTP 206 Partial Content Range streaming on master audio
        # 8a: Full stream (HTTP 200)
        stream_200 = self.client.get(f"/api/media/{project_id}/master")
        self.assertEqual(stream_200.status_code, 200)
        self.assertEqual(stream_200.headers.get("accept-ranges"), "bytes")
        total_size = int(stream_200.headers.get("content-length"))
        self.assertGreater(total_size, 0)

        # 8b: Byte range request (HTTP 206)
        stream_206 = self.client.get(
            f"/api/media/{project_id}/master", headers={"Range": "bytes=0-1023"}
        )
        self.assertEqual(stream_206.status_code, 206)
        self.assertEqual(stream_206.headers.get("content-range"), f"bytes 0-1023/{total_size}")
        self.assertEqual(len(stream_206.content), 1024)

        # 8c: Out of bounds byte range (HTTP 416)
        huge_start = total_size + 5000
        stream_416 = self.client.get(
            f"/api/media/{project_id}/master",
            headers={"Range": f"bytes={huge_start}-{huge_start + 100}"},
        )
        self.assertEqual(stream_416.status_code, 416)

        # 9. Segment editing: PATCH /api/segments/{id}
        patch_resp = self.client.patch(
            f"/api/segments/{seg1['id']}",
            json={"text": "Hallo zusammen! (edited)", "start_time_ms": 50},
        )
        self.assertEqual(patch_resp.status_code, 200)
        patched = patch_resp.json()
        self.assertEqual(patched["text"], "Hallo zusammen! (edited)")
        self.assertEqual(patched["start_time_ms"], 50)
        self.assertTrue(patched["is_edited"])

        # Invalid bounds patch (start >= end) must return 400
        bad_patch = self.client.patch(
            f"/api/segments/{seg1['id']}",
            json={"start_time_ms": 3000, "end_time_ms": 1000},
        )
        self.assertEqual(bad_patch.status_code, 400)

        # 10. Segment Split: POST /api/segments/{id}/split
        split_point = (patched["start_time_ms"] + patched["end_time_ms"]) // 2
        split_resp = self.client.post(
            f"/api/segments/{seg1['id']}/split",
            json={
                "split_time_ms": split_point,
                "first_text": "Hallo",
                "second_text": "zusammen!",
            },
        )
        self.assertEqual(split_resp.status_code, 200)
        split_data = split_resp.json()
        self.assertEqual(split_data["first_segment"]["end_time_ms"], split_point)
        self.assertEqual(split_data["second_segment"]["start_time_ms"], split_point)
        self.assertEqual(split_data["second_segment"]["sequence_index"], 2)

        # Verify segments tally is now 3 and sequence indices are contiguous 1, 2, 3
        segs_after_split = self.client.get(f"/api/projects/{project_id}/segments").json()
        self.assertEqual(len(segs_after_split), 3)
        self.assertEqual([s["sequence_index"] for s in segs_after_split], [1, 2, 3])

        # 11. Segment Merge: POST /api/segments/{id}/merge (direction="next")
        first_seg_id = segs_after_split[0]["id"]
        merge_resp = self.client.post(
            f"/api/segments/{first_seg_id}/merge",
            json={"direction": "next"},
        )
        self.assertEqual(merge_resp.status_code, 200)
        merged_data = merge_resp.json()
        self.assertIn("Hallo", merged_data["merged_segment"]["text"])
        self.assertIn("zusammen!", merged_data["merged_segment"]["text"])

        # Segments tally should be back to 2
        segs_after_merge = self.client.get(f"/api/projects/{project_id}/segments").json()
        self.assertEqual(len(segs_after_merge), 2)
        self.assertEqual([s["sequence_index"] for s in segs_after_merge], [1, 2])

        # 12. Cascade Delete: DELETE /api/projects/{id}
        project_dir = settings.get_project_dir(project_id)
        self.assertTrue(project_dir.is_dir())

        del_resp = self.client.delete(f"/api/projects/{project_id}")
        self.assertEqual(del_resp.status_code, 204)

        # Project should return 404
        self.assertEqual(self.client.get(f"/api/projects/{project_id}").status_code, 404)
        # Project directory on disk should be removed
        self.assertFalse(project_dir.exists())
        # Projects list should now be empty
        self.assertEqual(len(self.client.get("/api/projects").json()), 0)


if __name__ == "__main__":
    unittest.main()

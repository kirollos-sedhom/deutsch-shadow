"""Comprehensive tests for Milestone 6 Phase 2: Segment transcript editing and boundary adjustments."""

import asyncio
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.core.config import settings
from backend.app.db.base import Base
from backend.app.db.models import Project, Segment
from backend.app.db.session import get_db
from backend.app.main import app


class TestSegmentEditingAndBoundaries(unittest.TestCase):
    """Test boundary validation, neighbor collisions, touching segments, and text editing."""

    @classmethod
    def setUpClass(cls):
        cls.temp_dir = Path(tempfile.mkdtemp(prefix="ds_test_seg_edit_"))
        cls.orig_base_dir = settings.base_dir
        settings.base_dir = cls.temp_dir

        cls.test_db_path = cls.temp_dir / "test_seg_edit.db"
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

        async def init_tables():
            async with cls.test_engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)

        asyncio.run(init_tables())

        async def override_get_db():
            async with cls.TestSessionLocal() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        app.dependency_overrides.clear()
        asyncio.run(cls.test_engine.dispose())
        import shutil
        settings.base_dir = cls.orig_base_dir
        shutil.rmtree(cls.temp_dir, ignore_errors=True)

    def setUp(self):
        # Create a fresh project with 3 contiguous segments
        async def populate():
            async with self.TestSessionLocal() as session:
                # Clear existing
                async with self.test_engine.begin() as conn:
                    await conn.run_sync(Base.metadata.drop_all)
                    await conn.run_sync(Base.metadata.create_all)

                proj = Project(
                    id="proj-edit-test",
                    title="Edit Test Episode",
                    original_filename="audio.mp3",
                    media_type="audio",
                    duration_seconds=15.0, # 15000 ms
                    status="ready",
                )
                session.add(proj)

                # Segment 1: 1000ms -> 4500ms
                s1 = Segment(
                    id="seg-1",
                    project_id=proj.id,
                    sequence_index=1,
                    start_time_ms=1000,
                    end_time_ms=4500,
                    text="Guten Morgen.",
                    raw_transcript="Guten Morgen.",
                    is_edited=False,
                )
                # Segment 2: 4500ms -> 8000ms (touching Segment 1 at 4500ms)
                s2 = Segment(
                    id="seg-2",
                    project_id=proj.id,
                    sequence_index=2,
                    start_time_ms=4500,
                    end_time_ms=8000,
                    text="Wie geht es Ihnen?",
                    raw_transcript="Wie geht es Ihnen?",
                    is_edited=False,
                )
                # Segment 3: 9000ms -> 12000ms (gap between 2 and 3: 8000 to 9000ms)
                s3 = Segment(
                    id="seg-3",
                    project_id=proj.id,
                    sequence_index=3,
                    start_time_ms=9000,
                    end_time_ms=12000,
                    text="Sehr gut, danke.",
                    raw_transcript="Sehr gut, danke.",
                    is_edited=False,
                )
                session.add_all([s1, s2, s3])
                await session.commit()

        asyncio.run(populate())

    def test_text_only_edit_preserves_timestamps_and_marks_is_edited(self):
        resp = self.client.patch(
            "/api/segments/seg-2",
            json={"text": "Wie geht es Ihnen heute?"},
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["text"], "Wie geht es Ihnen heute?")
        self.assertEqual(data["start_time_ms"], 4500)
        self.assertEqual(data["end_time_ms"], 8000)
        self.assertTrue(data["is_edited"])

    def test_empty_or_whitespace_text_rejected(self):
        resp = self.client.patch("/api/segments/seg-2", json={"text": ""})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("empty", resp.json()["detail"].lower())

        resp2 = self.client.patch("/api/segments/seg-2", json={"text": "   "})
        self.assertEqual(resp2.status_code, 400)

    def test_negative_start_time_rejected(self):
        resp = self.client.patch("/api/segments/seg-1", json={"start_time_ms": -100})
        # Pydantic or service raises 400 or 422
        self.assertIn(resp.status_code, [400, 422])

    def test_duration_under_100ms_rejected(self):
        resp = self.client.patch(
            "/api/segments/seg-1",
            json={"start_time_ms": 2000, "end_time_ms": 2050}, # 50ms duration
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("100ms", resp.json()["detail"])

    def test_overlap_with_previous_segment_rejected(self):
        # seg-1 ends at 4500ms; seg-2 starts at 4500ms.
        # Moving seg-2 start to 4400ms overlaps seg-1 -> rejected!
        resp = self.client.patch("/api/segments/seg-2", json={"start_time_ms": 4400})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("overlaps with previous segment", resp.json()["detail"])

    def test_touching_previous_segment_allowed(self):
        # seg-3 starts at 9000ms; seg-2 ends at 8000ms.
        # Moving seg-3 start to exactly 8000ms touches seg-2 -> allowed!
        resp = self.client.patch("/api/segments/seg-3", json={"start_time_ms": 8000})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["start_time_ms"], 8000)

    def test_overlap_with_next_segment_rejected(self):
        # seg-2 ends at 8000ms; seg-3 starts at 9000ms.
        # Moving seg-2 end to 9100ms overlaps seg-3 -> rejected!
        resp = self.client.patch("/api/segments/seg-2", json={"end_time_ms": 9100})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("overlaps with next segment", resp.json()["detail"])

    def test_touching_next_segment_allowed(self):
        # seg-2 ends at 8000ms; seg-3 starts at 9000ms.
        # Moving seg-2 end to exactly 9000ms touches seg-3 -> allowed!
        resp = self.client.patch("/api/segments/seg-2", json={"end_time_ms": 9000})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["end_time_ms"], 9000)

    def test_exceeding_project_media_duration_rejected(self):
        # Project duration is 15.0s (15000ms).
        # seg-3 is the last segment; setting end to 16000ms -> rejected!
        resp = self.client.patch("/api/segments/seg-3", json={"end_time_ms": 16000})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("media duration", resp.json()["detail"])

    def test_valid_boundary_nudge_within_gap_persists(self):
        # seg-2 ends at 8000ms; seg-3 starts at 9000ms.
        # Nudge seg-2 end to 8250ms (within gap) -> succeeds!
        resp = self.client.patch("/api/segments/seg-2", json={"end_time_ms": 8250})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["end_time_ms"], 8250)
        self.assertEqual(data["duration_ms"], 8250 - 4500)
        self.assertTrue(data["is_edited"])

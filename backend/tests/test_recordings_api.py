"""Comprehensive test suite for Milestone 7 Phase 1: Backend Recording Persistence and API."""

from __future__ import annotations
import asyncio
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import httpx
from httpx import ASGITransport
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.core.config import settings
from backend.app.db.base import Base
from backend.app.db.models import Project, Recording, Segment
from backend.app.db.session import get_db
from backend.app.main import app
from backend.app.services.recording_service import MAX_RECORDING_SIZE_BYTES


class TestRecordingsAPI(unittest.TestCase):
    """Test suite covering recording upload, validation, take sequencing, streaming, and deletion."""

    @classmethod
    def setUpClass(cls):
        cls.temp_dir = Path(tempfile.mkdtemp(prefix="ds_test_recordings_"))
        cls.orig_base_dir = settings.base_dir
        settings.base_dir = cls.temp_dir

        cls.test_db_path = cls.temp_dir / "test_recordings.db"
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

        # Generate synthetic valid WebM and WAV audio test files using ffmpeg
        cls.sample_webm = cls.temp_dir / "sample.webm"
        cls.sample_wav = cls.temp_dir / "sample.wav"

        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:duration=1.2",
                "-c:a",
                "libopus",
                str(cls.sample_webm),
            ],
            check=True,
            capture_output=True,
        )

        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:duration=1.0",
                "-c:a",
                "pcm_s16le",
                str(cls.sample_wav),
            ],
            check=True,
            capture_output=True,
        )

    @classmethod
    def tearDownClass(cls):
        app.dependency_overrides.clear()
        asyncio.run(cls.test_engine.dispose())
        settings.base_dir = cls.orig_base_dir
        shutil.rmtree(cls.temp_dir, ignore_errors=True)

    def setUp(self):
        """Seed a clean project and practice segments before each test."""
        async def seed_data():
            async with self.TestSessionLocal() as session:
                # Clean up existing rows
                await session.execute(Recording.__table__.delete())
                await session.execute(Segment.__table__.delete())
                await session.execute(Project.__table__.delete())
                await session.commit()

                proj = Project(
                    id="proj-rec-test",
                    title="Recording Test Project",
                    original_filename="rec_test.mp3",
                    media_type="audio",
                    duration_seconds=10.0,
                    status="ready",
                )
                session.add(proj)

                seg1 = Segment(
                    id="seg-rec-1",
                    project_id=proj.id,
                    sequence_index=1,
                    start_time_ms=0,
                    end_time_ms=4000,
                    text="Erster Test-Clip.",
                    raw_transcript="Erster Test-Clip.",
                )
                seg2 = Segment(
                    id="seg-rec-2",
                    project_id=proj.id,
                    sequence_index=2,
                    start_time_ms=4000,
                    end_time_ms=8000,
                    text="Zweiter Test-Clip.",
                    raw_transcript="Zweiter Test-Clip.",
                )
                session.add_all([seg1, seg2])
                await session.commit()

        asyncio.run(seed_data())

    def test_upload_recording_webm_success(self):
        """Upload a valid WebM audio take and verify persistence, fields, and file on disk."""
        with open(self.sample_webm, "rb") as f:
            res = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("recording.webm", f, "audio/webm")},
                data={"duration_ms": 1200},
            )

        self.assertEqual(res.status_code, 201)
        data = res.json()
        self.assertEqual(data["segment_id"], "seg-rec-1")
        self.assertEqual(data["take_number"], 1)
        self.assertTrue(data["is_active"])
        self.assertGreater(data["duration_ms"], 1000)
        self.assertTrue(data["audio_url"].startswith("/api/recordings/"))

        # Verify physical file on disk
        rec_id = data["id"]
        expected_file = settings.get_project_dir("proj-rec-test") / "recordings" / f"{rec_id}.webm"
        self.assertTrue(expected_file.is_file())
        self.assertGreater(expected_file.stat().st_size, 0)

    def test_upload_recording_wav_agreement(self):
        """Upload a WAV file and verify the stored container extension agrees with format (.wav, not .webm)."""
        with open(self.sample_wav, "rb") as f:
            res = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("my_take.wav", f, "audio/wav")},
            )

        self.assertEqual(res.status_code, 201)
        data = res.json()
        rec_id = data["id"]

        # Ensure container agreement
        wav_file = settings.get_project_dir("proj-rec-test") / "recordings" / f"{rec_id}.wav"
        webm_file = settings.get_project_dir("proj-rec-test") / "recordings" / f"{rec_id}.webm"

        self.assertTrue(wav_file.is_file())
        self.assertFalse(webm_file.exists())

    def test_sequential_take_numbering_and_single_active_state(self):
        """Verify sequential take numbers (1, 2, 3) and that only the latest take is active by default."""
        with open(self.sample_webm, "rb") as f:
            res1 = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("take1.webm", f, "audio/webm")},
            )
        self.assertEqual(res1.status_code, 201)
        data1 = res1.json()
        self.assertEqual(data1["take_number"], 1)
        self.assertTrue(data1["is_active"])

        with open(self.sample_webm, "rb") as f:
            res2 = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("take2.webm", f, "audio/webm")},
            )
        self.assertEqual(res2.status_code, 201)
        data2 = res2.json()
        self.assertEqual(data2["take_number"], 2)
        self.assertTrue(data2["is_active"])

        with open(self.sample_webm, "rb") as f:
            res3 = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("take3.webm", f, "audio/webm")},
            )
        self.assertEqual(res3.status_code, 201)
        data3 = res3.json()
        self.assertEqual(data3["take_number"], 3)
        self.assertTrue(data3["is_active"])

        # List all takes for segment
        list_res = self.client.get("/api/segments/seg-rec-1/recordings")
        self.assertEqual(list_res.status_code, 200)
        takes = list_res.json()
        self.assertEqual(len(takes), 3)

        self.assertEqual([t["take_number"] for t in takes], [1, 2, 3])
        self.assertEqual([t["is_active"] for t in takes], [False, False, True])

    def test_switch_active_take(self):
        """Test manually designating a previous take as the active take."""
        # Create 2 takes
        with open(self.sample_webm, "rb") as f:
            t1 = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("take1.webm", f, "audio/webm")},
            ).json()

        with open(self.sample_webm, "rb") as f:
            t2 = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("take2.webm", f, "audio/webm")},
            ).json()

        self.assertTrue(t2["is_active"])

        # Activate Take 1
        act_res = self.client.patch(f"/api/recordings/{t1['id']}/active")
        self.assertEqual(act_res.status_code, 200)
        self.assertTrue(act_res.json()["is_active"])

        # Verify takes list reflects active state
        takes = self.client.get("/api/segments/seg-rec-1/recordings").json()
        self.assertTrue(takes[0]["is_active"])
        self.assertFalse(takes[1]["is_active"])

    def test_stream_recording_audio_full_and_range(self):
        """Test streaming recording audio via HTTP 200 and HTTP 206 Partial Content byte ranges."""
        with open(self.sample_webm, "rb") as f:
            rec = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("take1.webm", f, "audio/webm")},
            ).json()

        rec_id = rec["id"]

        # 1. Full content stream (HTTP 200)
        stream_res = self.client.get(f"/api/recordings/{rec_id}/audio")
        self.assertEqual(stream_res.status_code, 200)
        self.assertEqual(stream_res.headers.get("Content-Type"), "audio/webm")
        self.assertEqual(stream_res.headers.get("Accept-Ranges"), "bytes")
        total_size = int(stream_res.headers.get("Content-Length", "0"))
        self.assertGreater(total_size, 0)

        # 2. Byte-range request (HTTP 206)
        range_res = self.client.get(
            f"/api/recordings/{rec_id}/audio",
            headers={"Range": "bytes=0-100"},
        )
        self.assertEqual(range_res.status_code, 206)
        self.assertEqual(range_res.headers.get("Content-Range"), f"bytes 0-100/{total_size}")
        self.assertEqual(len(range_res.content), 101)

    def test_delete_recording_active_fallback(self):
        """Test deleting takes: active take deletion activates most recent remaining take; deleting last leaves none."""
        # Create 3 takes
        t1 = self.client.post(
            "/api/segments/seg-rec-1/recordings",
            files={"file": ("take1.webm", open(self.sample_webm, "rb"), "audio/webm")},
        ).json()
        t2 = self.client.post(
            "/api/segments/seg-rec-1/recordings",
            files={"file": ("take2.webm", open(self.sample_webm, "rb"), "audio/webm")},
        ).json()
        t3 = self.client.post(
            "/api/segments/seg-rec-1/recordings",
            files={"file": ("take3.webm", open(self.sample_webm, "rb"), "audio/webm")},
        ).json()

        t3_file = settings.get_project_dir("proj-rec-test") / "recordings" / f"{t3['id']}.webm"
        self.assertTrue(t3_file.is_file())

        # Delete active take 3
        del3_res = self.client.delete(f"/api/recordings/{t3['id']}")
        self.assertEqual(del3_res.status_code, 204)

        # File is unlinked from disk
        self.assertFalse(t3_file.exists())

        # Take 2 is promoted to active
        takes = self.client.get("/api/segments/seg-rec-1/recordings").json()
        self.assertEqual(len(takes), 2)
        self.assertEqual(takes[1]["id"], t2["id"])
        self.assertTrue(takes[1]["is_active"])

        # Delete inactive Take 1
        del1_res = self.client.delete(f"/api/recordings/{t1['id']}")
        self.assertEqual(del1_res.status_code, 204)

        # Take 2 remains active
        takes = self.client.get("/api/segments/seg-rec-1/recordings").json()
        self.assertEqual(len(takes), 1)
        self.assertTrue(takes[0]["is_active"])

        # Delete final Take 2
        del2_res = self.client.delete(f"/api/recordings/{t2['id']}")
        self.assertEqual(del2_res.status_code, 204)

        # No takes remain
        takes = self.client.get("/api/segments/seg-rec-1/recordings").json()
        self.assertEqual(len(takes), 0)

    def test_upload_empty_file_rejected(self):
        """Reject 0-byte file upload with 400 Bad Request without leaving orphaned files."""
        res = self.client.post(
            "/api/segments/seg-rec-1/recordings",
            files={"file": ("empty.webm", b"", "audio/webm")},
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn("empty", res.json()["detail"].lower())

    def test_upload_oversized_file_rejected(self):
        """Reject upload exceeding size limit with 413 Entity Too Large."""
        # Create a mock or chunk larger than MAX_RECORDING_SIZE_BYTES
        with patch("backend.app.services.recording_service.MAX_RECORDING_SIZE_BYTES", 500):
            with open(self.sample_webm, "rb") as f:
                res = self.client.post(
                    "/api/segments/seg-rec-1/recordings",
                    files={"file": ("large.webm", f, "audio/webm")},
                )
            self.assertEqual(res.status_code, 413)

    def test_upload_corrupted_media_rejected(self):
        """Reject corrupted non-audio bytes with 400 Bad Request."""
        garbage_data = b"NOT_A_VALID_AUDIO_FILE_GARBAGE_BYTES_12345"
        res = self.client.post(
            "/api/segments/seg-rec-1/recordings",
            files={"file": ("bad.webm", garbage_data, "audio/webm")},
        )
        self.assertEqual(res.status_code, 400)

    def test_upload_unsupported_container_rejected(self):
        """Reject unsupported containers with 415 Unsupported Media Type."""
        # Create a tiny MP3 sine wave
        unsupported_mp3 = self.temp_dir / "unsupported.mp3"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:duration=0.5",
                "-c:a",
                "libmp3lame",
                str(unsupported_mp3),
            ],
            check=True,
            capture_output=True,
        )

        with open(unsupported_mp3, "rb") as f:
            res = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("audio.mp3", f, "audio/mpeg")},
            )
        self.assertEqual(res.status_code, 415)
        self.assertIn("unsupported", res.json()["detail"].lower())

    def test_nonexistent_segment_404(self):
        """Ensure 404 for uploading or querying recordings on nonexistent segment."""
        with open(self.sample_webm, "rb") as f:
            res = self.client.post(
                "/api/segments/non-existent-seg/recordings",
                files={"file": ("take.webm", f, "audio/webm")},
            )
        self.assertEqual(res.status_code, 404)

        list_res = self.client.get("/api/segments/non-existent-seg/recordings")
        self.assertEqual(list_res.status_code, 404)

    def test_nonexistent_recording_operations_404(self):
        """Ensure 404 for audio, active, or delete on non-existent recording ID."""
        self.assertEqual(self.client.get("/api/recordings/fake-id/audio").status_code, 404)
        self.assertEqual(self.client.patch("/api/recordings/fake-id/active").status_code, 404)
        self.assertEqual(self.client.delete("/api/recordings/fake-id").status_code, 404)

    def test_missing_audio_file_on_disk_404(self):
        """If physical audio file is deleted from disk, streaming returns 404."""
        with open(self.sample_webm, "rb") as f:
            rec = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("take.webm", f, "audio/webm")},
            ).json()

        rec_file = settings.get_project_dir("proj-rec-test") / "recordings" / f"{rec['id']}.webm"
        self.assertTrue(rec_file.is_file())
        rec_file.unlink()

        res = self.client.get(f"/api/recordings/{rec['id']}/audio")
        self.assertEqual(res.status_code, 404)

    def test_safe_path_handling(self):
        """Reject path traversal attempt when streaming audio."""
        async def tamper_path():
            async with self.TestSessionLocal() as session:
                rec = Recording(
                    id="tampered-rec",
                    segment_id="seg-rec-1",
                    audio_file_path="../../windows/system32/cmd.exe",
                    duration_ms=1000,
                    take_number=99,
                    is_active=False,
                )
                session.add(rec)
                await session.commit()

        asyncio.run(tamper_path())

        res = self.client.get("/api/recordings/tampered-rec/audio")
        self.assertEqual(res.status_code, 400)
        self.assertIn("traversal", res.json()["detail"].lower())

    def test_cleanup_on_transaction_failure(self):
        """Verify that if database commit fails, the target audio file is unlinked."""
        with patch.object(AsyncSession, "commit", side_effect=RuntimeError("Database lock failure")):
            with open(self.sample_webm, "rb") as f:
                with self.assertRaises(RuntimeError):
                    self.client.post(
                        "/api/segments/seg-rec-1/recordings",
                        files={"file": ("take.webm", f, "audio/webm")},
                    )

            # Check no new files were left in recordings dir
            rec_dir = settings.get_project_dir("proj-rec-test") / "recordings"
            if rec_dir.exists():
                self.assertEqual(len(list(rec_dir.glob("*.webm"))), 0)

    def test_project_deletion_cascades_and_removes_recording_files(self):
        """Deleting a project removes its recording directory and files from disk."""
        with open(self.sample_webm, "rb") as f:
            rec = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("take.webm", f, "audio/webm")},
            ).json()

        rec_file = settings.get_project_dir("proj-rec-test") / "recordings" / f"{rec['id']}.webm"
        self.assertTrue(rec_file.is_file())

        del_proj_res = self.client.delete("/api/projects/proj-rec-test")
        self.assertEqual(del_proj_res.status_code, 204)

        # Verify project dir and recordings dir are completely removed
        proj_dir = settings.get_project_dir("proj-rec-test")
        self.assertFalse(proj_dir.exists())

        # Verify database records are cascade deleted
        async def verify_db():
            async with self.TestSessionLocal() as session:
                recs = (await session.execute(select(Recording))).scalars().all()
                self.assertEqual(len(recs), 0)

        asyncio.run(verify_db())

    def test_segment_merge_cleans_up_absorbed_recordings(self):
        """Merging segments unlinks recordings belonging to the absorbed segment while preserving the surviving segment's recordings."""
        # Upload take for Segment 1
        with open(self.sample_webm, "rb") as f:
            rec1 = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("take1.webm", f, "audio/webm")},
            ).json()

        # Upload take for Segment 2
        with open(self.sample_webm, "rb") as f:
            rec2 = self.client.post(
                "/api/segments/seg-rec-2/recordings",
                files={"file": ("take2.webm", f, "audio/webm")},
            ).json()

        rec1_file = settings.get_project_dir("proj-rec-test") / "recordings" / f"{rec1['id']}.webm"
        rec2_file = settings.get_project_dir("proj-rec-test") / "recordings" / f"{rec2['id']}.webm"
        self.assertTrue(rec1_file.is_file())
        self.assertTrue(rec2_file.is_file())

        # Merge Segment 1 with next (Segment 2 is absorbed)
        merge_res = self.client.post(
            "/api/segments/seg-rec-1/merge",
            json={"direction": "next"},
        )
        self.assertEqual(merge_res.status_code, 200)

        # Segment 2's recording file is unlinked
        self.assertFalse(rec2_file.exists())

        # Segment 1's recording file is preserved
        self.assertTrue(rec1_file.is_file())

    def test_split_segment_with_recordings_rejected(self):
        """Splitting a segment that has existing recordings is rejected with HTTP 400 to prevent data loss or audio mismatch."""
        with open(self.sample_webm, "rb") as f:
            upload_resp = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("take1.webm", f, "audio/webm")},
            )
        self.assertEqual(upload_resp.status_code, 201)
        rec_id = upload_resp.json()["id"]

        # Attempt to split seg-rec-1 (original duration: 0 to 3000ms) at 1500ms
        split_resp = self.client.post(
            "/api/segments/seg-rec-1/split",
            json={
                "split_time_ms": 1500,
                "first_text": "Guten",
                "second_text": "Morgen",
            },
        )
        self.assertEqual(split_resp.status_code, 400)
        self.assertIn("Cannot split segment #1: it has 1 existing vocal recording(s)", split_resp.json()["detail"])

        # Verify segment was NOT modified
        async def verify_unmodified():
            async with self.TestSessionLocal() as session:
                seg = await session.get(Segment, "seg-rec-1")
                self.assertIsNotNone(seg)
                self.assertEqual(seg.start_time_ms, 0)
                self.assertEqual(seg.end_time_ms, 4000)
                self.assertEqual(seg.text, "Erster Test-Clip.")

                rec = await session.get(Recording, rec_id)
                self.assertIsNotNone(rec)

        asyncio.run(verify_unmodified())

    def test_split_segment_after_recordings_deleted_succeeds(self):
        """After explicitly deleting all recordings, splitting the segment succeeds normally."""
        with open(self.sample_webm, "rb") as f:
            upload_resp = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("take1.webm", f, "audio/webm")},
            )
        rec_id = upload_resp.json()["id"]

        # Delete recording
        del_resp = self.client.delete(f"/api/recordings/{rec_id}")
        self.assertEqual(del_resp.status_code, 204)

        # Now split segment
        split_resp = self.client.post(
            "/api/segments/seg-rec-1/split",
            json={
                "split_time_ms": 1500,
                "first_text": "Guten",
                "second_text": "Morgen",
            },
        )
        self.assertEqual(split_resp.status_code, 200)
        split_data = split_resp.json()
        self.assertEqual(split_data["first_segment"]["end_time_ms"], 1500)
        self.assertEqual(split_data["second_segment"]["start_time_ms"], 1500)

    def test_failed_file_deletion_preserves_database_row_and_returns_error(self):
        """When physical file deletion fails due to an OS-level error, the endpoint returns HTTP 500 and the DB row remains intact."""
        with open(self.sample_webm, "rb") as f:
            upload_resp = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("take1.webm", f, "audio/webm")},
            )
        self.assertEqual(upload_resp.status_code, 201)
        rec_id = upload_resp.json()["id"]

        with patch("pathlib.Path.unlink", side_effect=OSError("Access denied / file locked")):
            del_resp = self.client.delete(f"/api/recordings/{rec_id}")
            self.assertEqual(del_resp.status_code, 500)
            self.assertIn("Failed to delete recording audio file", del_resp.json()["detail"])

        # Verify DB row is still present
        async def verify_row():
            async with self.TestSessionLocal() as session:
                rec = await session.get(Recording, rec_id)
                self.assertIsNotNone(rec)

        asyncio.run(verify_row())

    def test_concurrent_uploads_serialize_takes_and_single_active(self):
        """Concurrent uploads to the same segment assign sequential take numbers without collision and leave exactly 1 active take."""
        async def run_concurrent():
            async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
                with open(self.sample_webm, "rb") as f:
                    content = f.read()

                async def upload_one(idx: int):
                    files = {"file": (f"take_c{idx}.webm", content, "audio/webm")}
                    return await ac.post("/api/segments/seg-rec-1/recordings", files=files)

                responses = await asyncio.gather(*(upload_one(i) for i in range(4)))
                for r in responses:
                    self.assertEqual(r.status_code, 201)

            async with self.TestSessionLocal() as session:
                stmt = (
                    select(Recording)
                    .where(Recording.segment_id == "seg-rec-1")
                    .order_by(Recording.take_number.asc())
                )
                recs = (await session.execute(stmt)).scalars().all()
                self.assertEqual(len(recs), 4)
                take_numbers = [r.take_number for r in recs]
                self.assertEqual(take_numbers, [1, 2, 3, 4])
                active_takes = [r for r in recs if r.is_active]
                self.assertEqual(len(active_takes), 1)
                self.assertEqual(active_takes[0].take_number, 4)

        asyncio.run(run_concurrent())

    def test_project_deletion_preserves_other_projects_recordings(self):
        """Deleting one project cascade-removes its own recordings but preserves recordings of other projects."""
        async def setup_proj2():
            async with self.TestSessionLocal() as session:
                p2 = Project(
                    id="proj-rec-survivor",
                    title="Survivor Project",
                    original_filename="survivor.mp3",
                    media_type="audio",
                    duration_seconds=5.0,
                    status="ready",
                )
                s2 = Segment(
                    id="seg-rec-survivor",
                    project_id="proj-rec-survivor",
                    sequence_index=1,
                    start_time_ms=0,
                    end_time_ms=5000,
                    text="Überlebender Text",
                    raw_transcript="Überlebender Text",
                )
                session.add_all([p2, s2])
                await session.commit()

        asyncio.run(setup_proj2())

        with open(self.sample_webm, "rb") as f:
            rec1 = self.client.post(
                "/api/segments/seg-rec-1/recordings",
                files={"file": ("take1.webm", f, "audio/webm")},
            ).json()

        with open(self.sample_webm, "rb") as f:
            rec2 = self.client.post(
                "/api/segments/seg-rec-survivor/recordings",
                files={"file": ("take_survivor.webm", f, "audio/webm")},
            ).json()

        file1 = settings.get_project_dir("proj-rec-test") / "recordings" / f"{rec1['id']}.webm"
        file2 = settings.get_project_dir("proj-rec-survivor") / "recordings" / f"{rec2['id']}.webm"
        self.assertTrue(file1.is_file())
        self.assertTrue(file2.is_file())

        del_res = self.client.delete("/api/projects/proj-rec-test")
        self.assertEqual(del_res.status_code, 204)

        # File 1 was removed with its project directory
        self.assertFalse(file1.exists())
        # File 2 remains intact in survivor project directory
        self.assertTrue(file2.is_file())

        # Database record for survivor is still present
        async def verify_survivor():
            async with self.TestSessionLocal() as session:
                rec_surv = await session.get(Recording, rec2["id"])
                self.assertIsNotNone(rec_surv)

        asyncio.run(verify_survivor())


if __name__ == "__main__":
    unittest.main()

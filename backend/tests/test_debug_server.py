"""Integration tests for the Debugging Player local HTTP server."""

import json
import threading
import time
import unittest
import urllib.request
import urllib.error
from pathlib import Path

from backend.app.debug_server import create_debug_server, DebugPlayerHandler
from backend.app.audio.pipeline import AudioPipeline
from backend.tests.test_pipeline_e2e import MockGermanTranscriber
from backend.tests.test_media_probe import create_synthetic_wav


class TestDebugPlayerServer(unittest.TestCase):
    """Test suite for DebugPlayerHandler and HTTP range streaming."""

    @classmethod
    def setUpClass(cls):
        cls.manifest = Path("data/real_audio_test/manifest.json")
        cls.audio = Path("data/real_audio_test/whisper_working.wav")
        cls.html = Path("frontend/debug_player.html")

        # Create server on dynamic free port
        cls.server = create_debug_server(
            host="127.0.0.1",
            port=8180,
            manifest_path=cls.manifest,
            audio_path=cls.audio,
            html_path=cls.html,
        )
        cls.port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"

        # Start server in daemon thread
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_serve_html_index(self):
        """Root GET / must return 200 with HTML player interface."""
        req = urllib.request.Request(f"{self.base_url}/")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertIn("text/html", resp.headers.get("Content-Type", ""))
            body = resp.read().decode("utf-8")
            self.assertIn("Deutsch Shadow — Debugging Player", body)
            self.assertIn("Milestone 3", body)

    def test_serve_manifest_json(self):
        """GET /api/manifest must return valid JSON manifest with practice segments."""
        req = urllib.request.Request(f"{self.base_url}/api/manifest")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertIn("application/json", resp.headers.get("Content-Type", ""))
            data = json.loads(resp.read().decode("utf-8"))
            self.assertIn("practice_segments", data)
            self.assertEqual(len(data["practice_segments"]), 13)
            self.assertIn("media_metadata", data)

    def test_serve_audio_full_stream(self):
        """GET /api/audio without Range header must return 200 with Accept-Ranges."""
        req = urllib.request.Request(f"{self.base_url}/api/audio")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get("Accept-Ranges"), "bytes")
            content_length = int(resp.headers.get("Content-Length", 0))
            expected_size = self.audio.stat().st_size
            self.assertEqual(content_length, expected_size)

    def test_serve_audio_byte_range_206(self):
        """GET /api/audio with Range: bytes=0-1023 must return 206 Partial Content."""
        req = urllib.request.Request(f"{self.base_url}/api/audio")
        req.add_header("Range", "bytes=0-1023")

        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 206)
            self.assertEqual(resp.headers.get("Content-Length"), "1024")
            expected_size = self.audio.stat().st_size
            self.assertEqual(resp.headers.get("Content-Range"), f"bytes 0-1023/{expected_size}")
            chunk = resp.read()
            self.assertEqual(len(chunk), 1024)

    def test_serve_audio_byte_range_middle(self):
        """GET /api/audio with middle range must return exact requested slice."""
        req = urllib.request.Request(f"{self.base_url}/api/audio")
        req.add_header("Range", "bytes=2048-4095")

        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 206)
            self.assertEqual(resp.headers.get("Content-Length"), "2048")
            chunk = resp.read()
            self.assertEqual(len(chunk), 2048)

    def test_serve_audio_out_of_bounds_range(self):
        """Out of bounds Range header must return 416 Range Not Satisfiable."""
        req = urllib.request.Request(f"{self.base_url}/api/audio")
        huge_start = self.audio.stat().st_size + 1000
        req.add_header("Range", f"bytes={huge_start}-{huge_start + 500}")

        try:
            with urllib.request.urlopen(req) as resp:
                self.assertEqual(resp.status, 416)
        except urllib.error.HTTPError as err:
            self.assertEqual(err.code, 416)

    def test_unknown_path_returns_404(self):
        """Requesting unmapped routes must return 404."""
        req = urllib.request.Request(f"{self.base_url}/nonexistent_route")
        try:
            with urllib.request.urlopen(req) as resp:
                self.assertEqual(resp.status, 404)
        except urllib.error.HTTPError as err:
            self.assertEqual(err.code, 404)

    def test_options_cors_preflight(self):
        """OPTIONS preflight must return 204 with CORS headers."""
        req = urllib.request.Request(f"{self.base_url}/api/upload", method="OPTIONS")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 204)
            self.assertEqual(resp.headers.get("Access-Control-Allow-Origin"), "*")
            self.assertIn("POST", resp.headers.get("Access-Control-Allow-Methods", ""))

    def test_upload_empty_returns_400(self):
        """POST /api/upload with empty body must return 400."""
        req = urllib.request.Request(
            f"{self.base_url}/api/upload?filename=test.mp3",
            data=b"",
            method="POST",
            headers={"Content-Length": "0"},
        )
        try:
            with urllib.request.urlopen(req) as resp:
                self.assertEqual(resp.status, 400)
        except urllib.error.HTTPError as err:
            self.assertEqual(err.code, 400)
            data = json.loads(err.read().decode("utf-8"))
            self.assertIn("error", data)

    def test_upload_invalid_extension_returns_400(self):
        """POST /api/upload with unsupported file extension must return 400."""
        fake_binary = b"not an audio file"
        req = urllib.request.Request(
            f"{self.base_url}/api/upload?filename=malicious.exe",
            data=fake_binary,
            method="POST",
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Length": str(len(fake_binary)),
            },
        )
        try:
            with urllib.request.urlopen(req) as resp:
                self.assertEqual(resp.status, 400)
        except urllib.error.HTTPError as err:
            self.assertEqual(err.code, 400)
            data = json.loads(err.read().decode("utf-8"))
            self.assertIn("Unsupported file format", data["error"])

    def test_upload_valid_media_end_to_end(self):
        """POST /api/upload with valid media must process, write manifest, and switch active media."""
        # Use MockGermanTranscriber for fast deterministic end-to-end execution
        mock_pipeline = AudioPipeline(transcriber=MockGermanTranscriber())
        DebugPlayerHandler.custom_pipeline = mock_pipeline

        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            create_synthetic_wav(tmp_path, duration_s=2.0)
            wav_bytes = tmp_path.read_bytes()

            req = urllib.request.Request(
                f"{self.base_url}/api/upload?filename=test_clip.wav",
                data=wav_bytes,
                method="POST",
                headers={
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(len(wav_bytes)),
                },
            )
            with urllib.request.urlopen(req) as resp:
                self.assertEqual(resp.status, 200)
                data = json.loads(resp.read().decode("utf-8"))
                self.assertTrue(data["success"])
                self.assertEqual(data["source_file"], "test_clip.wav")
                self.assertEqual(data["segments_count"], 2)
                self.assertIn("manifest_path", data)
                self.assertIn("audio_path", data)

            # Check GET /api/manifest returns the newly uploaded segments
            manifest_req = urllib.request.Request(f"{self.base_url}/api/manifest")
            with urllib.request.urlopen(manifest_req) as resp:
                self.assertEqual(resp.status, 200)
                mdata = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(len(mdata["practice_segments"]), 2)
                self.assertEqual(mdata["practice_segments"][0]["text"], "Hallo zusammen.")

            # Check GET /api/audio streams the newly generated audio
            audio_req = urllib.request.Request(f"{self.base_url}/api/audio")
            with urllib.request.urlopen(audio_req) as resp:
                self.assertEqual(resp.status, 200)
                self.assertGreater(int(resp.headers.get("Content-Length", 0)), 0)

            # Finally, verify reset restores original sample
            reset_req = urllib.request.Request(
                f"{self.base_url}/api/reset",
                data=b"{}",
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(reset_req) as resp:
                self.assertEqual(resp.status, 200)

            with urllib.request.urlopen(manifest_req) as resp:
                mdata = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(len(mdata["practice_segments"]), 13)
        finally:
            DebugPlayerHandler.custom_pipeline = None
            if tmp_path.exists():
                tmp_path.unlink()

    def test_upload_pipeline_failure_preserves_state(self):
        """Pipeline failure must return 500 and keep current active media intact."""
        initial_manifest = DebugPlayerHandler.manifest_path
        initial_audio = DebugPlayerHandler.audio_path

        class FaultyPipeline:
            def process(self, *args, **kwargs):
                raise RuntimeError("Simulated Whisper Failure for Testing")

        DebugPlayerHandler.custom_pipeline = FaultyPipeline()
        try:
            fake_wav = b"RIFF....WAVEfmt ...."
            req = urllib.request.Request(
                f"{self.base_url}/api/upload?filename=faulty.wav",
                data=fake_wav,
                method="POST",
                headers={
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(len(fake_wav)),
                },
            )
            try:
                with urllib.request.urlopen(req) as resp:
                    self.assertEqual(resp.status, 500)
            except urllib.error.HTTPError as err:
                self.assertEqual(err.code, 500)
                err_data = json.loads(err.read().decode("utf-8"))
                self.assertFalse(err_data["success"])
                self.assertIn("Simulated Whisper Failure", err_data["error"])

            # Verify active server paths were NOT mutated
            self.assertEqual(DebugPlayerHandler.manifest_path, initial_manifest)
            self.assertEqual(DebugPlayerHandler.audio_path, initial_audio)

            # Verify manifest is still valid and reachable
            with urllib.request.urlopen(f"{self.base_url}/api/manifest") as resp:
                self.assertEqual(resp.status, 200)
        finally:
            DebugPlayerHandler.custom_pipeline = None


if __name__ == "__main__":
    unittest.main()

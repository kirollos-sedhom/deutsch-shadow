"""Integration tests for the Debugging Player local HTTP server."""

import json
import threading
import time
import unittest
import urllib.request
import urllib.error
from pathlib import Path

from backend.app.debug_server import create_debug_server


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


if __name__ == "__main__":
    unittest.main()

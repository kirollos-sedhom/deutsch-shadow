"""Lightweight local development server for the Deutsch Shadow debugging player."""

from __future__ import annotations
import json
import mimetypes
import os
import re
import socket
import sys
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional


class DebugPlayerHandler(BaseHTTPRequestHandler):
    """HTTP Request Handler supporting byte-range audio streaming and manifest delivery."""

    # Configured by the server factory
    manifest_path: Path = Path("data/real_audio_test/manifest.json")
    audio_path: Path = Path("data/real_audio_test/whisper_working.wav")
    html_path: Path = Path("frontend/debug_player.html")
    custom_pipeline: Optional[Any] = None

    server_version = "DeutschShadowDebug/1.0"

    ALLOWED_EXTENSIONS = {
        ".mp3", ".wav", ".m4a", ".mp4", ".aac", ".ogg", ".flac", ".webm", ".mkv"
    }

    def do_OPTIONS(self) -> None:
        """Handle CORS preflight requests."""
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename, Range")
        self.end_headers()

    def do_GET(self) -> None:
        """Route GET requests to player UI, manifest API, or audio stream."""
        url_path = self.path.split("?")[0]

        if url_path in ("/", "/index.html"):
            self._serve_file(self.html_path, "text/html; charset=utf-8")
        elif url_path == "/api/manifest":
            self._serve_manifest()
        elif url_path == "/api/audio":
            self._serve_audio_with_ranges()
        else:
            self.send_error(HTTPStatus.NOT_FOUND, f"Path not found: {url_path}")

    def do_POST(self) -> None:
        """Route POST requests for media upload and reset."""
        url_path = self.path.split("?")[0]
        if url_path == "/api/upload":
            self._handle_upload()
        elif url_path == "/api/reset":
            self._handle_reset()
        else:
            self.send_error(HTTPStatus.NOT_FOUND, f"Path not found: {url_path}")

    def _handle_reset(self) -> None:
        """Reset the server to the default sample recording manifest and audio."""
        default_manifest = Path("data/real_audio_test/manifest.json").resolve()
        default_audio = Path("data/real_audio_test/whisper_working.wav").resolve()

        if not default_manifest.is_file() or not default_audio.is_file():
            self._send_json_error(
                HTTPStatus.NOT_FOUND,
                "Default sample data not found in data/real_audio_test/",
            )
            return

        DebugPlayerHandler.manifest_path = default_manifest
        DebugPlayerHandler.audio_path = default_audio

        self._send_json_response(
            HTTPStatus.OK,
            {
                "success": True,
                "message": "Reset to default sample recording successfully.",
                "manifest_path": str(default_manifest),
                "audio_path": str(default_audio),
            },
        )

    def _handle_upload(self) -> None:
        """Receive and process a newly uploaded German audio or video file."""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except (ValueError, TypeError):
            self._send_json_error(HTTPStatus.BAD_REQUEST, "Invalid Content-Length header")
            return

        if content_length <= 0:
            self._send_json_error(HTTPStatus.BAD_REQUEST, "Empty upload payload")
            return

        content_type = self.headers.get("Content-Type", "")
        filename = ""
        file_bytes = b""

        # Check query string for filename
        if "?" in self.path:
            import urllib.parse
            query_params = urllib.parse.parse_qs(self.path.split("?", 1)[1])
            if "filename" in query_params and query_params["filename"]:
                filename = query_params["filename"][0]

        # Check X-Filename header
        if not filename and self.headers.get("X-Filename"):
            filename = self.headers.get("X-Filename", "")

        # Check multipart/form-data
        if content_type.startswith("multipart/form-data"):
            boundary = None
            for param in content_type.split(";"):
                param = param.strip()
                if param.startswith("boundary="):
                    boundary = param.split("=", 1)[1].strip('"').encode("ascii")
                    break

            if not boundary:
                self._send_json_error(HTTPStatus.BAD_REQUEST, "Missing boundary in multipart upload")
                return

            raw_body = self.rfile.read(content_length)
            parts = raw_body.split(b"--" + boundary)
            found = False
            for part in parts:
                if b"Content-Disposition:" in part and b"filename=" in part:
                    header_part, _, body_part = part.partition(b"\r\n\r\n")
                    body_part = body_part.rstrip(b"\r\n--")
                    # Extract filename from header
                    header_str = header_part.decode("utf-8", errors="replace")
                    match = re.search(r'filename="([^"]+)"', header_str)
                    if match:
                        filename = match.group(1)
                    file_bytes = body_part
                    found = True
                    break

            if not found:
                self._send_json_error(HTTPStatus.BAD_REQUEST, "No file attachment found in multipart upload")
                return
        else:
            # Direct binary upload
            file_bytes = self.rfile.read(content_length)

        if not filename:
            filename = "uploaded_media.mp4"

        # Sanitize and validate filename
        safe_name = re.sub(r"[^\w\-.]", "_", Path(filename).name)
        ext = Path(safe_name).suffix.lower()
        if ext not in self.ALLOWED_EXTENSIONS:
            self._send_json_error(
                HTTPStatus.BAD_REQUEST,
                f"Unsupported file format '{ext}'. Supported: {', '.join(sorted(self.ALLOWED_EXTENSIONS))}",
            )
            return

        # Prepare isolated output directory
        import datetime
        timestamp_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        stem_slug = re.sub(r"[^\w\-]", "_", Path(safe_name).stem)[:24] or "upload"
        upload_dir = Path("data/uploads") / f"{stem_slug}_{timestamp_str}"
        upload_dir.mkdir(parents=True, exist_ok=True)

        target_file = upload_dir / safe_name
        try:
            target_file.write_bytes(file_bytes)
        except OSError as exc:
            self._send_json_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Failed saving file: {exc}")
            return

        # Process with AudioPipeline
        try:
            if self.custom_pipeline is not None:
                pipeline = self.custom_pipeline
            else:
                from backend.app.audio.pipeline import AudioPipeline
                from backend.app.audio.models import WhisperConfig, SegmentationConfig

                whisper_cfg = WhisperConfig(
                    model_size="base",
                    device="cpu",
                    compute_type="int8",
                    cpu_threads=4,
                    language="de",
                )
                segmentation_cfg = SegmentationConfig()
                pipeline = AudioPipeline(
                    whisper_config=whisper_cfg,
                    segmentation_config=segmentation_cfg,
                )

            result = pipeline.process(
                source_media_path=target_file,
                output_dir=upload_dir,
                save_manifest=True,
            )

            manifest_file = upload_dir / "manifest.json"
            working_audio_file = Path(result.working_audio_file).resolve()

            # Switch server's active manifest and audio paths only after successful processing
            DebugPlayerHandler.manifest_path = manifest_file.resolve()
            DebugPlayerHandler.audio_path = working_audio_file

            self._send_json_response(
                HTTPStatus.OK,
                {
                    "success": True,
                    "message": "File processed and loaded successfully.",
                    "source_file": safe_name,
                    "segments_count": result.total_segments,
                    "duration_s": result.media_metadata.duration_s,
                    "manifest_path": str(manifest_file.resolve()),
                    "audio_path": str(working_audio_file),
                },
            )
        except Exception as exc:
            self._send_json_error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                f"Audio pipeline processing failed: {exc}",
            )

    def _send_json_response(self, status: HTTPStatus, data: dict) -> None:
        """Helper to send structured JSON responses."""
        payload = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(payload)

    def _send_json_error(self, status: HTTPStatus, message: str) -> None:
        """Helper to send JSON error responses."""
        self._send_json_response(status, {"error": message, "success": False})

    def _serve_file(self, file_path: Path, content_type: str) -> None:
        """Serve a static text/html file."""
        if not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, f"File not found: {file_path.name}")
            return

        try:
            content = file_path.read_bytes()
        except OSError as exc:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Error reading file: {exc}")
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def _serve_manifest(self) -> None:
        """Serve the manifest.json with CORS and JSON headers."""
        if not self.manifest_path.is_file():
            self.send_error(
                HTTPStatus.NOT_FOUND,
                f"Manifest file not found at {self.manifest_path}. Please run Milestone 2 first.",
            )
            return

        try:
            content = self.manifest_path.read_bytes()
        except OSError as exc:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Error reading manifest: {exc}")
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def _serve_audio_with_ranges(self) -> None:
        """Serve audio file supporting HTTP 206 Partial Content byte ranges for smooth browser seeking."""
        if not self.audio_path.is_file():
            self.send_error(
                HTTPStatus.NOT_FOUND,
                f"Audio file not found at {self.audio_path}. Please run Milestone 2 first.",
            )
            return

        try:
            file_size = self.audio_path.stat().st_size
        except OSError as exc:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Error statting audio: {exc}")
            return

        mime_type = mimetypes.guess_type(str(self.audio_path))[0] or "audio/wav"
        range_header = self.headers.get("Range")

        if not range_header:
            # Full file request (HTTP 200)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", mime_type)
            self.send_header("Content-Length", str(file_size))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            with open(self.audio_path, "rb") as f:
                self._copy_chunked(f, self.wfile, file_size)
            return

        # Parse Range header: bytes=start-end
        match = re.match(r"^bytes=(\d+)-(\d*)$", range_header.strip())
        if not match:
            self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "Invalid byte range format")
            return

        start_str, end_str = match.groups()
        start = int(start_str)
        end = int(end_str) if end_str else file_size - 1

        if start >= file_size or end >= file_size or start > end:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{file_size}")
            self.end_headers()
            return

        length = end - start + 1

        # Partial content response (HTTP 206)
        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        with open(self.audio_path, "rb") as f:
            f.seek(start)
            self._copy_chunked(f, self.wfile, length)

    def _copy_chunked(self, source, dest, total_bytes: int, chunk_size: int = 65536) -> None:
        """Stream bytes in chunks safely."""
        remaining = total_bytes
        while remaining > 0:
            to_read = min(remaining, chunk_size)
            data = source.read(to_read)
            if not data:
                break
            try:
                dest.write(data)
                remaining -= len(data)
            except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                break

    def log_message(self, format: str, *args) -> None:
        """Suppress standard HTTP request noise in console during test runs."""
        pass


def find_available_port(start_port: int = 8080, max_attempts: int = 20) -> int:
    """Find a free TCP port starting from start_port."""
    for port in range(start_port, start_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return start_port


def create_debug_server(
    host: str = "127.0.0.1",
    port: int = 8080,
    manifest_path: str | Path = "data/real_audio_test/manifest.json",
    audio_path: str | Path = "data/real_audio_test/whisper_working.wav",
    html_path: str | Path = "frontend/debug_player.html",
    pipeline: Optional[Any] = None,
) -> ThreadingHTTPServer:
    """Factory function to configure and instantiate the debug server."""
    handler_cls = DebugPlayerHandler
    handler_cls.manifest_path = Path(manifest_path).resolve()
    handler_cls.audio_path = Path(audio_path).resolve()
    handler_cls.html_path = Path(html_path).resolve()
    handler_cls.custom_pipeline = pipeline

    resolved_port = find_available_port(port)
    server = ThreadingHTTPServer((host, resolved_port), handler_cls)
    return server


def run_server_cli():
    """CLI launcher for the debugging player server."""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    host = "127.0.0.1"
    port = 8080
    manifest = Path("data/real_audio_test/manifest.json")
    audio = Path("data/real_audio_test/whisper_working.wav")
    html = Path("frontend/debug_player.html")

    server = create_debug_server(
        host=host,
        port=port,
        manifest_path=manifest,
        audio_path=audio,
        html_path=html,
    )
    actual_port = server.server_address[1]
    url = f"http://{host}:{actual_port}"

    print("=" * 65, flush=True)
    print(" Deutsch Shadow — Debugging Player Server (Milestone 3)", flush=True)
    print("=" * 65, flush=True)
    print(f" URL:            {url}", flush=True)
    print(f" Manifest:       {manifest.resolve()}", flush=True)
    print(f" Audio File:     {audio.resolve()}", flush=True)
    print(f" Player HTML:    {html.resolve()}", flush=True)
    print("-----------------------------------------------------------------", flush=True)
    print(f" Open your browser and navigate to: {url}", flush=True)
    print(" Press Ctrl+C in this terminal to stop the server.", flush=True)
    print("=" * 65, flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping debug server...")
    finally:
        server.server_close()
        print("Server stopped cleanly.")


if __name__ == "__main__":
    run_server_cli()

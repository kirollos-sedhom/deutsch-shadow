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

    server_version = "DeutschShadowDebug/1.0"

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
) -> ThreadingHTTPServer:
    """Factory function to configure and instantiate the debug server."""
    handler_cls = DebugPlayerHandler
    handler_cls.manifest_path = Path(manifest_path).resolve()
    handler_cls.audio_path = Path(audio_path).resolve()
    handler_cls.html_path = Path(html_path).resolve()

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

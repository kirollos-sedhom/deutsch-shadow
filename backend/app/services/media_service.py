"""Audio streaming service implementing HTTP 206 Partial Content byte ranges."""

from __future__ import annotations
import mimetypes
import os
import re
from pathlib import Path
from typing import Generator, Optional, Tuple

from fastapi import HTTPException, Request, status
from fastapi.responses import StreamingResponse


def parse_byte_range(range_header: str, file_size: int) -> Tuple[int, int]:
    """Parse HTTP Range header: bytes=start-end."""
    match = re.match(r"^bytes=(\d+)-(\d*)$", range_header.strip())
    if not match:
        raise HTTPException(
            status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
            detail="Invalid Range header format",
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    start_str, end_str = match.groups()
    start = int(start_str)
    end = int(end_str) if end_str else file_size - 1

    if start >= file_size or end >= file_size or start > end:
        raise HTTPException(
            status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
            detail="Requested range out of bounds",
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    return start, end


def file_chunk_generator(
    file_path: Path, start: int, length: int, chunk_size: int = 65536
) -> Generator[bytes, None, None]:
    """Yield file slices in chunks without loading entire file into memory."""
    with open(file_path, "rb") as f:
        f.seek(start)
        remaining = length
        while remaining > 0:
            to_read = min(remaining, chunk_size)
            chunk = f.read(to_read)
            if not chunk:
                break
            yield chunk
            remaining -= len(chunk)


def create_range_streaming_response(
    file_path: Path, request: Request, default_mime: str = "audio/wav"
) -> StreamingResponse:
    """Generate a FastAPI StreamingResponse supporting HTTP 206 byte-ranges."""
    if not file_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Media file not found at {file_path.name}",
        )

    file_size = file_path.stat().st_size
    mime_type = mimetypes.guess_type(str(file_path))[0] or default_mime
    if mime_type == "video/webm" and file_path.suffix.lower() == ".webm":
        mime_type = "audio/webm"
    range_header = request.headers.get("Range")

    if not range_header:
        # Full content request (HTTP 200)
        return StreamingResponse(
            file_chunk_generator(file_path, 0, file_size),
            status_code=status.HTTP_200_OK,
            headers={
                "Content-Type": mime_type,
                "Content-Length": str(file_size),
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-cache",
            },
        )

    # Partial content request (HTTP 206)
    start, end = parse_byte_range(range_header, file_size)
    content_length = end - start + 1

    return StreamingResponse(
        file_chunk_generator(file_path, start, content_length),
        status_code=status.HTTP_206_PARTIAL_CONTENT,
        headers={
            "Content-Type": mime_type,
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(content_length),
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
        },
    )

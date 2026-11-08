"""Core security, session management, CSRF validation, and rate limiting."""

from __future__ import annotations
import hashlib
import ipaddress
import json
import re
import secrets
import time
import urllib.parse
import uuid
from dataclasses import dataclass
from typing import Dict, List, Optional

from fastapi import HTTPException, Request, status
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from backend.app.core.config import settings


def is_valid_uuid(val: str | None) -> bool:
    """Validate whether an identifier is a valid canonical UUID using Python's uuid.UUID parser."""
    if not val:
        return False
    try:
        uuid.UUID(str(val))
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def is_safe_identifier(val: str | None) -> bool:
    """Check if identifier is non-empty and safe from path traversal and injection."""
    if not val or not isinstance(val, str):
        return False
    s = val.strip()
    if not s or s in (".", ".."):
        return False
    if any(c in s for c in ("/", "\\", "\x00", "\r", "\n", "..")):
        return False
    return True


def validate_identifier(val: str | None, name: str = "identifier") -> str:
    """Validate that an identifier is non-empty, safe from traversal, and valid."""
    if not is_safe_identifier(val):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Security violation: malformed or unsafe {name} detected: {val}",
        )
    return str(val).strip()


def get_client_ip(request: Request) -> str:
    """Extract and validate client IP address, preferring Render's CF-Connecting-IP."""
    if settings.is_cloud_mode:
        cf_ip = request.headers.get("CF-Connecting-IP")
        if cf_ip:
            raw_ip = cf_ip.strip()
            try:
                ipaddress.ip_address(raw_ip)
                return raw_ip
            except ValueError:
                pass  # Malformed header, do not trust

    if request.client and request.client.host:
        try:
            ipaddress.ip_address(request.client.host)
            return request.client.host
        except ValueError:
            pass

    return "127.0.0.1"


class LoginRateLimiter:
    """Sliding-window login rate limiter with bounded per-IP limits."""

    MAX_TRACKED_IPS = 500
    PER_IP_MAX_FAILURES = 5
    WINDOW_SECONDS = 60.0

    def __init__(self) -> None:
        self._ip_failures: Dict[str, List[float]] = {}

    def check_rate_limit(self, client_ip: str) -> None:
        """Check if client IP has exceeded failed login attempts. Raises HTTP 429 if rate limited."""
        now = time.time()
        self._prune_ip_timestamps(client_ip, now)
        ip_attempts = self._ip_failures.get(client_ip, [])

        if len(ip_attempts) >= self.PER_IP_MAX_FAILURES:
            oldest = ip_attempts[0]
            retry_after = max(1, int(self.WINDOW_SECONDS - (now - oldest)))
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Too many failed login attempts from this IP address. Please wait {retry_after} seconds.",
                headers={"Retry-After": str(retry_after)},
            )

    def record_failure(self, client_ip: str) -> None:
        """Record an unauthenticated login failure for the client IP with memory bounds."""
        now = time.time()
        self._prune_all(now)

        if client_ip not in self._ip_failures:
            if len(self._ip_failures) >= self.MAX_TRACKED_IPS:
                # Evict oldest tracked IP to bound memory
                oldest_ip = min(
                    self._ip_failures.keys(),
                    key=lambda ip: self._ip_failures[ip][0] if self._ip_failures[ip] else 0,
                )
                del self._ip_failures[oldest_ip]
            self._ip_failures[client_ip] = []

        self._ip_failures[client_ip].append(now)

    def record_success(self, client_ip: str) -> None:
        """Clear failed attempts for this client IP after a successful login."""
        self._ip_failures.pop(client_ip, None)

    def _prune_ip_timestamps(self, client_ip: str, now: float) -> None:
        if client_ip in self._ip_failures:
            cutoff = now - self.WINDOW_SECONDS
            self._ip_failures[client_ip] = [t for t in self._ip_failures[client_ip] if t > cutoff]
            if not self._ip_failures[client_ip]:
                del self._ip_failures[client_ip]

    def _prune_all(self, now: float) -> None:
        cutoff = now - self.WINDOW_SECONDS
        for ip in list(self._ip_failures.keys()):
            self._ip_failures[ip] = [t for t in self._ip_failures[ip] if t > cutoff]
            if not self._ip_failures[ip]:
                del self._ip_failures[ip]

    def reset(self) -> None:
        """Clear all rate limiting state (used for testing)."""
        self._ip_failures.clear()


@dataclass
class SessionEntry:
    created_at: float
    last_accessed_at: float
    client_ip: str


class InMemorySessionRegistry:
    """In-memory server-side session registry storing SHA-256 hashed opaque tokens."""

    MAX_SESSIONS = 50
    IDLE_TIMEOUT_SECONDS = 48.0 * 3600.0  # 48 hours inactivity expiration
    MAX_LIFETIME_SECONDS = 14.0 * 86400.0  # 14 days maximum lifetime

    def __init__(self) -> None:
        self._sessions: Dict[str, SessionEntry] = {}

    def _hash_token(self, token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def create_session(self, client_ip: str) -> str:
        """Generate a cryptographically secure 256-bit token and store its hash."""
        now = time.time()
        self.prune_expired()

        if len(self._sessions) >= self.MAX_SESSIONS:
            # Evict oldest session by creation time
            oldest_hash = min(self._sessions.keys(), key=lambda h: self._sessions[h].created_at)
            del self._sessions[oldest_hash]

        raw_token = secrets.token_urlsafe(32)
        token_hash = self._hash_token(raw_token)
        self._sessions[token_hash] = SessionEntry(
            created_at=now,
            last_accessed_at=now,
            client_ip=client_ip,
        )
        return raw_token

    def validate_session(self, raw_token: str | None) -> bool:
        """Validate raw token against hashed sessions with sliding expiration."""
        if not raw_token or not isinstance(raw_token, str):
            return False

        token_hash = self._hash_token(raw_token)
        entry = self._sessions.get(token_hash)
        if not entry:
            return False

        now = time.time()
        # Inactivity expiration
        if now - entry.last_accessed_at > self.IDLE_TIMEOUT_SECONDS:
            del self._sessions[token_hash]
            return False

        # Max lifetime expiration
        if now - entry.created_at > self.MAX_LIFETIME_SECONDS:
            del self._sessions[token_hash]
            return False

        # Sliding expiration: update access time
        entry.last_accessed_at = now
        return True

    def invalidate_session(self, raw_token: str | None) -> None:
        """Remove a session from registry upon logout."""
        if raw_token:
            token_hash = self._hash_token(raw_token)
            self._sessions.pop(token_hash, None)

    def prune_expired(self) -> None:
        """Clean expired sessions from memory."""
        now = time.time()
        expired = [
            h for h, e in self._sessions.items()
            if (now - e.last_accessed_at > self.IDLE_TIMEOUT_SECONDS)
            or (now - e.created_at > self.MAX_LIFETIME_SECONDS)
        ]
        for h in expired:
            del self._sessions[h]

    def clear(self) -> None:
        """Clear all sessions (used for testing)."""
        self._sessions.clear()


def verify_csrf_origin(request: Request) -> None:
    """Validate Origin/Referer and custom header on state-changing requests in cloud mode."""
    if not settings.is_cloud_mode:
        return

    # Only state-changing methods require CSRF validation
    if request.method not in ("POST", "PATCH", "DELETE", "PUT"):
        return

    allowed = settings.allowed_origins
    if not allowed:
        # If no explicit origins configured, allow none
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="CSRF validation failed: no trusted origins configured on server",
        )

    # 1. Inspect Origin header
    origin = request.headers.get("origin")
    if origin:
        normalized_origin = origin.strip().rstrip("/")
        if normalized_origin not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"CSRF validation failed: untrusted Origin '{origin}'",
            )
    else:
        # 2. Fallback to Referer header if Origin is omitted
        referer = request.headers.get("referer")
        if not referer:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="CSRF validation failed: missing both Origin and Referer headers on state-changing request",
            )
        parsed = urllib.parse.urlparse(referer)
        referer_origin = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
        if referer_origin not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"CSRF validation failed: untrusted Referer origin '{referer_origin}'",
            )

    # 3. Custom Header Requirement (defense in depth against cross-origin scripts)
    x_requested_with = request.headers.get("x-requested-with", "").strip().lower()
    if x_requested_with != "fetch":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="CSRF validation failed: missing or invalid X-Requested-With header (expected 'Fetch')",
        )


# Global singletons
session_registry = InMemorySessionRegistry()
login_rate_limiter = LoginRateLimiter()

PROJECT_IMPORT_PATTERN = re.compile(r"^/api/projects/import/?$")
RECORDING_UPLOAD_PATTERN = re.compile(r"^/api/segments/[^/]+/recordings/?$")


class CloudUploadLimitMiddleware:
    """ASGI middleware enforcing pre-multipart request body limits in cloud mode.

    Protects against memory pressure and disk exhaustion by enforcing strict byte-count
    limits before or during body streaming, rejecting oversized requests with HTTP 413.
    Completely unrestricted when not in cloud mode (local mode).
    """

    def __init__(self, app: ASGIApp):
        self.app = app

    async def _send_413_response(self, send: Send, detail: str) -> None:
        content = json.dumps({"detail": detail}).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status.HTTP_413_CONTENT_TOO_LARGE,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(content)).encode("ascii")),
                    (b"connection", b"close"),
                ],
            }
        )
        await send(
            {
                "type": "http.response.body",
                "body": content,
                "more_body": False,
            }
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not settings.is_cloud_mode:
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "GET").upper()
        if method not in ("POST", "PUT", "PATCH"):
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        max_bytes: Optional[int] = None
        max_mb: Optional[int] = None
        resource_name: str = "Request payload"

        if PROJECT_IMPORT_PATTERN.match(path):
            max_bytes = settings.cloud_import_total_limit
            max_mb = settings.cloud_max_import_bytes // (1024 * 1024)
            resource_name = "Uploaded media file"
        elif RECORDING_UPLOAD_PATTERN.match(path):
            max_bytes = settings.cloud_recording_total_limit
            max_mb = settings.cloud_max_recording_bytes // (1024 * 1024)
            resource_name = "Uploaded audio recording"

        if max_bytes is None:
            # Non-upload endpoint; no upload payload restriction
            await self.app(scope, receive, send)
            return

        # 1. Early rejection based on Content-Length header before reading body
        headers = scope.get("headers", [])
        for name, value in headers:
            if name.lower() == b"content-length":
                try:
                    content_length = int(value.decode("latin1"))
                    if content_length > max_bytes:
                        await self._send_413_response(
                            send,
                            f"{resource_name} exceeds maximum allowed limit of {max_mb} MiB",
                        )
                        return
                except ValueError:
                    pass
                break

        # 2. Stream chunk counting for chunked transfers or missing/lying Content-Length
        total_bytes = 0

        async def counting_receive() -> Message:
            nonlocal total_bytes
            message = await receive()
            if message["type"] == "http.request":
                body = message.get("body", b"")
                total_bytes += len(body)
                if total_bytes > max_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                        detail=f"{resource_name} exceeds maximum allowed limit of {max_mb} MiB",
                    )
            return message

        response_started = False

        async def wrapped_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, counting_receive, wrapped_send)
        except HTTPException as exc:
            if not response_started and exc.status_code == status.HTTP_413_CONTENT_TOO_LARGE:
                await self._send_413_response(send, str(exc.detail))
            else:
                raise

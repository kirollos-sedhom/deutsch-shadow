"""Comprehensive tests for Stage 1 Backend Authentication Core & Filesystem Security."""

from __future__ import annotations
import os
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from backend.app.core.config import settings
from backend.app.core.security import (
    InMemorySessionRegistry,
    LoginRateLimiter,
    get_client_ip,
    is_safe_identifier,
    is_valid_uuid,
    login_rate_limiter,
    session_registry,
    validate_identifier,
)
from backend.app.main import create_app, lifespan


VALID_TEST_PASSWORD = "CorrectHorseBatteryStaple123!"
VALID_ORIGIN = "https://deutsch-shadow.onrender.com"


@pytest.fixture(autouse=True)
def reset_security_state():
    """Reset session registry and rate limiter before each test."""
    session_registry.clear()
    login_rate_limiter.reset()
    yield
    session_registry.clear()
    login_rate_limiter.reset()


# ---------------------------------------------------------------------------
# 1. Local Mode Invariant Tests
# ---------------------------------------------------------------------------

def test_local_mode_open_access_without_credentials():
    """Local mode must allow open access to endpoints without any authentication."""
    with patch.object(settings, "auth_mode", "local"), \
         patch.object(settings, "auth_password", None):
        app = create_app()
        with TestClient(app) as client:
            # Health
            resp_health = client.get("/api/health")
            assert resp_health.status_code == 200
            assert resp_health.json()["status"] == "healthy"

            # Auth Status
            resp_status = client.get("/api/auth/status")
            assert resp_status.status_code == 200
            assert resp_status.json() == {"auth_required": False, "authenticated": True}

            # Projects list (protected in cloud, open in local)
            resp_projects = client.get("/api/projects")
            assert resp_projects.status_code == 200
            assert isinstance(resp_projects.json(), list)


# ---------------------------------------------------------------------------
# 2. Startup Validation & Authentication Mode Enforcement
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_auth_mode_defaults_to_local_when_unset_or_empty():
    """Unset or empty DEUTSCH_SHADOW_AUTH_MODE must resolve to local mode."""
    with patch.dict(os.environ, {"DEUTSCH_SHADOW_AUTH_MODE": ""}):
        from backend.app.core.config import Settings
        s = Settings()
        assert s.auth_mode == "local"
        assert s.is_cloud_mode is False

    with patch.dict(os.environ, {}, clear=True):
        s2 = Settings()
        assert s2.auth_mode == "local"
        assert s2.is_cloud_mode is False


@pytest.mark.asyncio
async def test_auth_mode_rejects_invalid_values_at_startup():
    """Startup must fail closed if DEUTSCH_SHADOW_AUTH_MODE is set to unknown values."""
    dummy_app = FastAPI()
    for bad_mode in ("production", "cloudd", "auth", "disabled"):
        with patch.object(settings, "auth_mode", bad_mode):
            with pytest.raises(RuntimeError, match="Invalid DEUTSCH_SHADOW_AUTH_MODE"):
                async with lifespan(dummy_app):
                    pass


@pytest.mark.asyncio
async def test_cloud_mode_fails_closed_when_password_missing():
    """Cloud mode must refuse to start if DEUTSCH_SHADOW_AUTH_PASSWORD is missing."""
    dummy_app = FastAPI()
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", None):
        with pytest.raises(RuntimeError, match="Cloud mode startup aborted: DEUTSCH_SHADOW_AUTH_PASSWORD required"):
            async with lifespan(dummy_app):
                pass


@pytest.mark.asyncio
async def test_cloud_mode_fails_closed_when_password_too_short():
    """Cloud mode must refuse to start if DEUTSCH_SHADOW_AUTH_PASSWORD is shorter than 16 characters."""
    dummy_app = FastAPI()
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", "ShortPassword1"):
        with pytest.raises(RuntimeError, match="at least 16 characters"):
            async with lifespan(dummy_app):
                pass


# ---------------------------------------------------------------------------
# 3. Cloud Mode Authentication & Default-Deny Route Protection
# ---------------------------------------------------------------------------

def test_cloud_mode_unauthenticated_request_returns_401():
    """Protected API endpoints must reject unauthenticated requests with HTTP 401 in cloud mode."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_TEST_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):
        app = create_app()
        with TestClient(app) as client:
            # Protected endpoint without cookie
            resp = client.get("/api/projects")
            assert resp.status_code == 401
            assert resp.json()["detail"] == "Authentication required"


def test_cloud_mode_public_endpoints_accessible():
    """Public allowlist endpoints must remain accessible without cookies in cloud mode."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_TEST_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):
        app = create_app()
        with TestClient(app) as client:
            # /api/health is public
            h_resp = client.get("/api/health")
            assert h_resp.status_code == 200

            # /api/auth/status is public
            s_resp = client.get("/api/auth/status")
            assert s_resp.status_code == 200
            assert s_resp.json() == {"auth_required": True, "authenticated": False}


def test_public_endpoint_trailing_slash_behavior():
    """Posting to /api/auth/login/ with a trailing slash must not be blocked as unauthorized."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_TEST_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):
        app = create_app()
        with TestClient(app, base_url=VALID_ORIGIN) as client:
            resp = client.post(
                "/api/auth/login/",
                json={"password": VALID_TEST_PASSWORD},
                headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
                follow_redirects=True,
            )
            assert resp.status_code == 200
            assert resp.json()["success"] is True


def test_cloud_mode_login_sets_secure_httponly_cookie_and_unlocks_api():
    """Valid login issues a session cookie with correct flags and allows access to protected API."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_TEST_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):
        app = create_app()
        with TestClient(app, base_url=VALID_ORIGIN) as client:
            # Login attempt with correct password and CSRF header
            login_resp = client.post(
                "/api/auth/login",
                json={"password": VALID_TEST_PASSWORD},
                headers={
                    "Origin": VALID_ORIGIN,
                    "X-Requested-With": "Fetch",
                },
            )
            assert login_resp.status_code == 200
            assert login_resp.json()["success"] is True

            # Check cookie attributes
            cookie_header = login_resp.headers.get("set-cookie")
            assert cookie_header is not None
            assert "ds_session=" in cookie_header
            assert "httponly" in cookie_header.lower()
            assert "samesite=lax" in cookie_header.lower()
            assert "secure" in cookie_header.lower()
            assert "path=/" in cookie_header.lower()

            # Subsequent protected API request should succeed
            proj_resp = client.get("/api/projects")
            assert proj_resp.status_code == 200
            assert isinstance(proj_resp.json(), list)

            # Auth status should report authenticated=True
            status_resp = client.get("/api/auth/status")
            assert status_resp.status_code == 200
            assert status_resp.json() == {"auth_required": True, "authenticated": True}


def test_cloud_mode_invalid_session_rejected():
    """Forged or non-existent session cookie must be rejected with 401."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_TEST_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):
        app = create_app()
        with TestClient(app) as client:
            client.cookies.set("ds_session", "fake_nonexistent_token_12345")
            resp = client.get("/api/projects")
            assert resp.status_code == 401


def test_cloud_mode_logout_invalidates_session_and_clears_cookie():
    """Logout endpoint must revoke session on server and clear cookie on client."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_TEST_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):
        app = create_app()
        with TestClient(app, base_url=VALID_ORIGIN) as client:
            # Login
            client.post(
                "/api/auth/login",
                json={"password": VALID_TEST_PASSWORD},
                headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
            )
            assert client.get("/api/projects").status_code == 200

            # Logout
            logout_resp = client.post(
                "/api/auth/logout",
                headers={"Origin": VALID_ORIGIN, "X-Requested-With": "Fetch"},
            )
            assert logout_resp.status_code == 200

            # Next request must be rejected
            assert client.get("/api/projects").status_code == 401


# ---------------------------------------------------------------------------
# 4. Session Registry Bounds and Expiration
# ---------------------------------------------------------------------------

def test_session_registry_inactivity_and_lifetime_expiration():
    """Sessions must expire after idle timeout or maximum lifetime."""
    reg = InMemorySessionRegistry()
    token = reg.create_session("192.168.1.1")
    assert reg.validate_session(token) is True

    # Simulate inactivity expiration (48 hours + 1 second)
    token_hash = reg._hash_token(token)
    reg._sessions[token_hash].last_accessed_at = time.time() - (48 * 3600 + 1)
    assert reg.validate_session(token) is False
    assert token_hash not in reg._sessions

    # Simulate max lifetime expiration (14 days + 1 second)
    token2 = reg.create_session("192.168.1.2")
    token2_hash = reg._hash_token(token2)
    reg._sessions[token2_hash].created_at = time.time() - (14 * 86400 + 1)
    assert reg.validate_session(token2) is False


def test_session_registry_capacity_cap_evicts_oldest():
    """Session registry capped at 50 sessions must evict oldest when capacity exceeded."""
    reg = InMemorySessionRegistry()
    reg.MAX_SESSIONS = 3  # small bound for testing

    t1 = reg.create_session("ip1")
    time.sleep(0.01)
    t2 = reg.create_session("ip2")
    time.sleep(0.01)
    t3 = reg.create_session("ip3")
    assert len(reg._sessions) == 3

    # Add 4th session -> t1 must be evicted
    time.sleep(0.01)
    t4 = reg.create_session("ip4")
    assert len(reg._sessions) == 3
    assert reg.validate_session(t1) is False
    assert reg.validate_session(t2) is True
    assert reg.validate_session(t3) is True
    assert reg.validate_session(t4) is True


# ---------------------------------------------------------------------------
# 5. Trusted Origin CSRF Protection
# ---------------------------------------------------------------------------

def test_csrf_rejects_foreign_or_missing_origin_on_mutations():
    """Mutations in cloud mode must reject untrusted or missing Origin."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_TEST_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):
        app = create_app()
        with TestClient(app) as client:
            # 1. Missing Origin and missing Referer
            r1 = client.post("/api/auth/login", json={"password": VALID_TEST_PASSWORD})
            assert r1.status_code == 403
            assert "CSRF validation failed" in r1.json()["detail"]

            # 2. Foreign Origin
            r2 = client.post(
                "/api/auth/login",
                json={"password": VALID_TEST_PASSWORD},
                headers={"Origin": "https://attacker-domain.evil", "X-Requested-With": "Fetch"},
            )
            assert r2.status_code == 403
            assert "untrusted Origin" in r2.json()["detail"]

            # 3. Missing X-Requested-With header
            r3 = client.post(
                "/api/auth/login",
                json={"password": VALID_TEST_PASSWORD},
                headers={"Origin": VALID_ORIGIN},
            )
            assert r3.status_code == 403
            assert "X-Requested-With" in r3.json()["detail"]


def test_csrf_accepts_valid_referer_fallback():
    """Referer header fallback must be accepted if Origin is omitted by browser."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_TEST_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):
        app = create_app()
        with TestClient(app) as client:
            resp = client.post(
                "/api/auth/login",
                json={"password": VALID_TEST_PASSWORD},
                headers={
                    "Referer": f"{VALID_ORIGIN}/app/shadow",
                    "X-Requested-With": "Fetch",
                },
            )
            assert resp.status_code == 200


# ---------------------------------------------------------------------------
# 6. Cloud CORS Isolation & Local Mode Regression
# ---------------------------------------------------------------------------

def test_cloud_cors_allowed_origin():
    """In cloud mode, allowed origin must receive CORS headers with credentials enabled."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_TEST_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):
        app = create_app()
        with TestClient(app, base_url=VALID_ORIGIN) as client:
            # Preflight
            pre_resp = client.options(
                "/api/projects",
                headers={
                    "Origin": VALID_ORIGIN,
                    "Access-Control-Request-Method": "GET",
                },
            )
            assert pre_resp.status_code == 200
            assert pre_resp.headers.get("access-control-allow-origin") == VALID_ORIGIN
            assert pre_resp.headers.get("access-control-allow-credentials") == "true"


def test_cloud_cors_untrusted_foreign_origin_blocked():
    """In cloud mode, foreign origin must not receive Access-Control-Allow-Origin headers."""
    with patch.object(settings, "auth_mode", "cloud"), \
         patch.object(settings, "auth_password", VALID_TEST_PASSWORD), \
         patch.object(settings, "allowed_origins_raw", VALID_ORIGIN):
        app = create_app()
        with TestClient(app, base_url=VALID_ORIGIN) as client:
            # 1. Foreign preflight rejected
            pre_resp = client.options(
                "/api/projects",
                headers={
                    "Origin": "https://attacker-domain.evil",
                    "Access-Control-Request-Method": "GET",
                },
            )
            assert pre_resp.headers.get("access-control-allow-origin") != "https://attacker-domain.evil"

            # 2. Authenticated GET from foreign origin must not receive allow-origin
            token = session_registry.create_session("127.0.0.1")
            client.cookies.set("ds_session", token)
            get_resp = client.get(
                "/api/projects",
                headers={"Origin": "https://attacker-domain.evil"},
            )
            assert get_resp.status_code == 200
            assert get_resp.headers.get("access-control-allow-origin") is None


def test_local_mode_cors_allows_wildcard():
    """In local mode, CORS allows wildcard origins for developer tools."""
    with patch.object(settings, "auth_mode", "local"):
        app = create_app()
        with TestClient(app) as client:
            resp = client.get("/api/health", headers={"Origin": "http://localhost:5173"})
            assert resp.status_code == 200
            assert resp.headers.get("access-control-allow-origin") in ("*", "http://localhost:5173")


# ---------------------------------------------------------------------------
# 7. Rate Limiting Tests (Per-IP Isolation and Memory Bounds)
# ---------------------------------------------------------------------------

def test_login_rate_limiter_per_ip():
    """Login rate limiter must block IP after 5 consecutive failures."""
    limiter = LoginRateLimiter()
    ip = "203.0.113.195"

    for _ in range(5):
        limiter.check_rate_limit(ip)
        limiter.record_failure(ip)

    # 6th attempt must be rejected with 429
    with pytest.raises(Exception) as excinfo:
        limiter.check_rate_limit(ip)
    assert excinfo.value.status_code == 429
    assert "Too many failed login attempts from this IP" in excinfo.value.detail


def test_login_rate_limiter_per_ip_isolation():
    """Failures from one IP address must never block an unrelated IP address."""
    limiter = LoginRateLimiter()
    attacker_ip = "198.51.100.1"
    legitimate_ip = "203.0.113.50"

    # Attacker exceeds failed limit
    for _ in range(5):
        limiter.record_failure(attacker_ip)

    # Attacker is blocked
    with pytest.raises(Exception) as exc:
        limiter.check_rate_limit(attacker_ip)
    assert exc.value.status_code == 429

    # Legitimate user is completely unaffected
    limiter.check_rate_limit(legitimate_ip)  # does not raise


def test_login_rate_limiter_expired_attempts_pruned():
    """Expired attempts past the window must not count toward the rate limit."""
    limiter = LoginRateLimiter()
    ip = "192.0.2.10"
    now = time.time()

    # Record 5 attempts in the past (beyond 60s)
    limiter._ip_failures[ip] = [now - 70.0, now - 65.0, now - 62.0]
    limiter.check_rate_limit(ip)  # pruned and allowed


def test_login_rate_limiter_registry_bounded():
    """Tracking registry must evict oldest entries when MAX_TRACKED_IPS is reached."""
    limiter = LoginRateLimiter()
    limiter.MAX_TRACKED_IPS = 3

    limiter.record_failure("ip1")
    time.sleep(0.01)
    limiter.record_failure("ip2")
    time.sleep(0.01)
    limiter.record_failure("ip3")
    assert len(limiter._ip_failures) == 3

    time.sleep(0.01)
    limiter.record_failure("ip4")
    assert len(limiter._ip_failures) == 3
    assert "ip1" not in limiter._ip_failures
    assert "ip4" in limiter._ip_failures


# ---------------------------------------------------------------------------
# 8. Reverse Proxy Client IP Extraction
# ---------------------------------------------------------------------------

def test_get_client_ip_prefers_cf_connecting_ip_and_validates():
    """Client IP extraction must prefer valid CF-Connecting-IP in cloud mode."""
    with patch.object(settings, "auth_mode", "cloud"):
        # 1. Valid CF-Connecting-IP
        req1 = Request({"type": "http", "headers": [(b"cf-connecting-ip", b"81.97.145.24")]})
        assert get_client_ip(req1) == "81.97.145.24"

        # 2. Malformed CF-Connecting-IP -> do not trust
        req2 = Request({"type": "http", "headers": [(b"cf-connecting-ip", b"bad-ip; drop table")]})
        assert get_client_ip(req2) == "127.0.0.1"


# ---------------------------------------------------------------------------
# 9. Filesystem Path Confinement & Traversal Protection
# ---------------------------------------------------------------------------

def test_path_confinement_rejects_source_code_in_base_dir():
    """Source code inside base_dir but outside data_dir must be rejected."""
    with pytest.raises(Exception) as exc_source:
        settings.resolve_media_path("backend/app/core/config.py")
    assert exc_source.value.status_code == 400
    assert "path traversal outside data directory" in exc_source.value.detail


def test_path_confinement_rejects_absolute_path_outside_data_dir():
    """Absolute paths outside data_dir must be rejected with HTTP 400."""
    with pytest.raises(Exception) as exc_abs:
        settings.resolve_media_path("C:/Windows/System32/calc.exe")
    assert exc_abs.value.status_code == 400


def test_path_confinement_rejects_directory_traversal():
    """Path traversal sequences must be rejected with HTTP 400."""
    with pytest.raises(Exception) as exc_media:
        settings.resolve_media_path("../../../Windows/System32/calc.exe")
    assert exc_media.value.status_code == 400


def test_path_confinement_rejects_symlink_traversal():
    """Symlink pointing outside data_dir must be resolved and rejected."""
    target_file = (settings.base_dir / "backend/app/core/config.py").resolve()
    symlink_path = settings.data_dir / "test_symlink_config.py"
    try:
        os.symlink(target_file, symlink_path)
    except (OSError, NotImplementedError):
        pytest.skip("Symlink creation requires elevated privilege on this OS environment")

    try:
        with pytest.raises(Exception) as exc:
            settings.resolve_media_path(symlink_path)
        assert exc.value.status_code == 400
    finally:
        if symlink_path.is_symlink() or symlink_path.exists():
            symlink_path.unlink()


def test_path_confinement_preserves_valid_local_paths():
    """Valid data paths within data_dir must resolve cleanly."""
    valid_rel = Path("data") / "projects" / "test_audio.wav"
    resolved = settings.resolve_media_path(valid_rel)
    assert resolved.is_relative_to(settings.data_dir.resolve())


def test_project_dir_root_protection():
    """get_project_dir must reject empty IDs, traversal, and never return projects_root itself."""
    projects_root = settings.projects_dir.resolve()

    # 1. Empty ID rejected
    with pytest.raises(Exception) as e1:
        settings.get_project_dir("")
    assert e1.value.status_code == 400

    # 2. Dot rejected
    with pytest.raises(Exception) as e2:
        settings.get_project_dir(".")
    assert e2.value.status_code == 400

    # 3. Dot-dot rejected
    with pytest.raises(Exception) as e3:
        settings.get_project_dir("..")
    assert e3.value.status_code == 400

    # 4. Traversal slashes rejected
    with pytest.raises(Exception) as e4:
        settings.get_project_dir("sub/folder")
    assert e4.value.status_code == 400

    # 5. Valid ID resolves strictly as child
    proj_dir = settings.get_project_dir("30d10745-c64b-4f40-9ec8-449760712045")
    assert proj_dir != projects_root
    assert proj_dir.is_relative_to(projects_root)


# ---------------------------------------------------------------------------
# 10. Identifier Validation (Helper and API Boundary)
# ---------------------------------------------------------------------------

def test_identifier_validation_helper_and_api():
    """Identifier helpers must validate safe formats and reject traversal at API entry points."""
    # 1. Valid UUID
    assert is_valid_uuid("30d10745-c64b-4f40-9ec8-449760712045") is True
    assert is_valid_uuid("not-a-uuid") is False

    # 2. Safe identifier helper
    assert is_safe_identifier("30d10745-c64b-4f40-9ec8-449760712045") is True
    assert is_safe_identifier("proj-rec-test") is True
    assert is_safe_identifier("../../etc") is False
    assert is_safe_identifier(".") is False
    assert is_safe_identifier("") is False
    assert is_safe_identifier("a/b") is False

    # 3. validate_identifier raises 400 on malformed input
    with pytest.raises(Exception) as exc:
        validate_identifier("../../etc", "project_id")
    assert exc.value.status_code == 400

    # 4. API boundary rejects malformed project_id with 400
    with patch.object(settings, "auth_mode", "local"):
        app = create_app()
        with TestClient(app) as client:
            resp = client.get("/api/projects/invalid..traversal")
            assert resp.status_code == 400
            assert "malformed or unsafe" in resp.json()["detail"]

"""Authentication routes and session control for Deutsch Shadow."""

from __future__ import annotations
import hmac
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from backend.app.core.config import settings
from backend.app.core.security import (
    get_client_ip,
    login_rate_limiter,
    session_registry,
)


router = APIRouter(prefix="/auth", tags=["Authentication"])

SESSION_COOKIE_NAME = "ds_session"
SESSION_COOKIE_MAX_AGE = 14 * 86400  # 14 days in seconds


class LoginRequest(BaseModel):
    password: str = Field(..., min_length=1, description="Application passphrase")


class AuthStatusResponse(BaseModel):
    auth_required: bool
    authenticated: bool


class AuthActionResponse(BaseModel):
    success: bool
    message: str


@router.get(
    "/status",
    response_model=AuthStatusResponse,
    status_code=status.HTTP_200_OK,
    summary="Query authentication status and session validity",
)
@router.get(
    "/status/",
    response_model=AuthStatusResponse,
    status_code=status.HTTP_200_OK,
    include_in_schema=False,
)
async def get_auth_status(request: Request) -> AuthStatusResponse:
    """Return whether authentication is required and whether the current caller holds an active session."""
    if not settings.is_cloud_mode:
        return AuthStatusResponse(auth_required=False, authenticated=True)

    raw_token = request.cookies.get(SESSION_COOKIE_NAME)
    is_valid = session_registry.validate_session(raw_token)
    return AuthStatusResponse(auth_required=True, authenticated=is_valid)


@router.post(
    "/login",
    response_model=AuthActionResponse,
    status_code=status.HTTP_200_OK,
    summary="Authenticate with shared passphrase and receive HttpOnly session cookie",
)
@router.post(
    "/login/",
    response_model=AuthActionResponse,
    status_code=status.HTTP_200_OK,
    include_in_schema=False,
)
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
) -> AuthActionResponse:
    """Validate credentials, create a new server-side session, and emit a secure cookie."""
    client_ip = get_client_ip(request)

    # Local mode bypass
    if not settings.is_cloud_mode:
        return AuthActionResponse(success=True, message="Authentication disabled in local mode")

    # Rate limiting guard
    login_rate_limiter.check_rate_limit(client_ip)

    expected_password = settings.auth_password or ""
    # Constant-time comparison
    is_correct = hmac.compare_digest(payload.password.encode("utf-8"), expected_password.encode("utf-8"))

    if not is_correct:
        login_rate_limiter.record_failure(client_ip)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        )

    # Login successful
    login_rate_limiter.record_success(client_ip)
    raw_token = session_registry.create_session(client_ip)

    # Set secure HttpOnly cookie
    # Secure=True unconditionally in cloud mode
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=raw_token,
        max_age=SESSION_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=True,
        path="/",
    )

    return AuthActionResponse(success=True, message="Authenticated successfully")


@router.post(
    "/logout",
    response_model=AuthActionResponse,
    status_code=status.HTTP_200_OK,
    summary="Invalidate active session and clear session cookie",
)
@router.post(
    "/logout/",
    response_model=AuthActionResponse,
    status_code=status.HTTP_200_OK,
    include_in_schema=False,
)
async def logout(
    request: Request,
    response: Response,
) -> AuthActionResponse:
    """Invalidate session in server-side registry and instruct browser to delete cookie."""
    raw_token = request.cookies.get(SESSION_COOKIE_NAME)
    if raw_token:
        session_registry.invalidate_session(raw_token)

    # Clear cookie
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.is_cloud_mode,
    )

    return AuthActionResponse(success=True, message="Logged out successfully")


async def require_auth(request: Request) -> None:
    """Dependency that ensures callers hold a valid session in cloud mode."""
    if not settings.is_cloud_mode:
        return

    raw_token = request.cookies.get(SESSION_COOKIE_NAME)
    if not raw_token or not session_registry.validate_session(raw_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

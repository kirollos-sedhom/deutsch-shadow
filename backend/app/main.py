"""FastAPI application entry point for Deutsch Shadow."""

from __future__ import annotations
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.app.api.auth import router as auth_router, SESSION_COOKIE_NAME
from backend.app.api.routes.media import router as media_router
from backend.app.api.routes.projects import router as projects_router
from backend.app.api.routes.recordings import router as recordings_router
from backend.app.api.routes.segments import router as segments_router
from backend.app.api.routes.system import router as system_router
from backend.app.core.config import settings
from backend.app.core.security import (
    CloudUploadLimitMiddleware,
    session_registry,
    verify_csrf_origin,
)
from backend.app.db.session import engine, init_db

logger = logging.getLogger("deutsch_shadow")

PUBLIC_API_ALLOWLIST = {
    "/api/health",
    "/api/auth/status",
    "/api/auth/login",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifecycle manager: initialize database schema on startup and dispose engine on shutdown."""
    # Validate auth_mode setting
    mode = settings.auth_mode
    if mode not in ("local", "cloud"):
        logger.critical(
            f"FATAL CONFIGURATION ERROR: Invalid DEUTSCH_SHADOW_AUTH_MODE '{settings.auth_mode}'. "
            f"Allowed modes are 'local' or 'cloud'."
        )
        raise RuntimeError(
            f"Startup aborted: Invalid DEUTSCH_SHADOW_AUTH_MODE '{settings.auth_mode}'. "
            f"Must be either 'local' or 'cloud'."
        )

    # Fail-closed startup validation for cloud mode
    if settings.is_cloud_mode:
        if not settings.auth_password or len(settings.auth_password.strip()) < 16:
            logger.critical(
                "FATAL CONFIGURATION ERROR: DEUTSCH_SHADOW_AUTH_MODE is set to 'cloud', "
                "but DEUTSCH_SHADOW_AUTH_PASSWORD is missing or shorter than 16 characters. "
                "Server refusing to start in unauthenticated cloud mode."
            )
            raise RuntimeError(
                "Cloud mode startup aborted: DEUTSCH_SHADOW_AUTH_PASSWORD required with at least 16 characters."
            )

    await init_db()
    yield
    await engine.dispose()


def create_app() -> FastAPI:
    """Application factory for Deutsch Shadow FastAPI backend."""
    app = FastAPI(
        title=settings.app_title,
        version=settings.app_version,
        description="Local-first German listening and shadowing training application API.",
        lifespan=lifespan,
    )

    # Configure CORS: open in local dev mode, strictly constrained to trusted origins in cloud mode
    if not settings.is_cloud_mode:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    else:
        cloud_origins = sorted(list(settings.allowed_origins))
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cloud_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"],
            allow_headers=["*"],
        )

    # Healthcheck
    @app.get("/api/health", tags=["Health"])
    async def healthcheck():
        return {
            "status": "healthy",
            "app": settings.app_title,
            "version": settings.app_version,
        }

    # Register API routers
    app.include_router(auth_router, prefix=settings.api_prefix)
    app.include_router(projects_router, prefix=settings.api_prefix)
    app.include_router(segments_router, prefix=settings.api_prefix)
    app.include_router(recordings_router, prefix=settings.api_prefix)
    app.include_router(media_router, prefix=settings.api_prefix)
    app.include_router(system_router, prefix=settings.api_prefix)

    # Cloud upload limit middleware (enforces payload caps before multipart parsing / spooling)
    app.add_middleware(CloudUploadLimitMiddleware)

    # Cloud Security & Authentication Enforcement Middleware
    @app.middleware("http")
    async def cloud_security_middleware(request: Request, call_next):
        if not settings.is_cloud_mode:
            return await call_next(request)

        # Allow CORS preflight OPTIONS requests to be evaluated by CORSMiddleware
        if request.method == "OPTIONS":
            return await call_next(request)

        path = request.url.path
        normalized_path = path.rstrip("/") if path != "/" else "/"

        # 1. CSRF validation on all state-changing API operations
        if normalized_path.startswith("/api/") or normalized_path == "/api":
            if request.method in ("POST", "PATCH", "DELETE", "PUT"):
                try:
                    verify_csrf_origin(request)
                except HTTPException as exc:
                    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

        # 2. Default-deny authentication guard on protected API endpoints
        if normalized_path.startswith("/api") and normalized_path not in PUBLIC_API_ALLOWLIST:
            raw_token = request.cookies.get(SESSION_COOKIE_NAME)
            if not raw_token or not session_registry.validate_session(raw_token):
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={"detail": "Authentication required"},
                )

        return await call_next(request)

    # Optional static distribution serving for single-container production deployment
    dist_dir = (settings.base_dir / "frontend" / "dist").resolve()
    if dist_dir.is_dir() and (dist_dir / "index.html").is_file():
        from fastapi import HTTPException, status
        from fastapi.responses import FileResponse
        from fastapi.staticfiles import StaticFiles

        assets_dir = dist_dir / "assets"
        if assets_dir.is_dir():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def serve_spa(full_path: str):
            # Guard against masking unhandled /api calls with index.html
            if full_path.startswith("api/") or full_path == "api":
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="API endpoint not found",
                )
            # Serve specific static file if it exists within dist (e.g. favicon, vite.svg)
            file_path = (dist_dir / full_path).resolve()
            if full_path and file_path.is_file() and file_path.is_relative_to(dist_dir):
                return FileResponse(file_path)
            # Return index.html for client-side SPA routing
            return FileResponse(dist_dir / "index.html")

    return app


app = create_app()

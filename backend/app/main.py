"""FastAPI application entry point for Deutsch Shadow."""

from __future__ import annotations
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.api.routes.media import router as media_router
from backend.app.api.routes.projects import router as projects_router
from backend.app.api.routes.recordings import router as recordings_router
from backend.app.api.routes.segments import router as segments_router
from backend.app.api.routes.system import router as system_router
from backend.app.core.config import settings
from backend.app.db.session import engine, init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifecycle manager: initialize database schema on startup and dispose engine on shutdown."""
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

    # Enable CORS for local React/Vite development frontend
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
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
    app.include_router(projects_router, prefix=settings.api_prefix)
    app.include_router(segments_router, prefix=settings.api_prefix)
    app.include_router(recordings_router, prefix=settings.api_prefix)
    app.include_router(media_router, prefix=settings.api_prefix)
    app.include_router(system_router, prefix=settings.api_prefix)

    return app


app = create_app()

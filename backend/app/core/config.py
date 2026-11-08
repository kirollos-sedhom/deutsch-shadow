"""Centralized configuration and path management for Deutsch Shadow."""

from __future__ import annotations
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Set
from fastapi import HTTPException, status


@dataclass
class Settings:
    """Application settings, storage paths, and hardware defaults."""

    # Base workspace directory (e.g. /path/to/Deutsch_shadow)
    base_dir: Path = field(
        default_factory=lambda: Path(
            os.getenv(
                "DEUTSCH_SHADOW_BASE_DIR",
                str(Path(__file__).resolve().parent.parent.parent.parent),
            )
        ).resolve()
    )

    # Local data directories
    data_dir_name: str = "data"
    db_name: str = "deutsch_shadow.db"

    # API configuration
    api_prefix: str = "/api"
    app_title: str = "Deutsch Shadow API"
    app_version: str = "0.1.0"
    port: int = field(default_factory=lambda: int(os.getenv("PORT", "8000")))

    # Authentication & Deployment Configuration
    auth_mode: str = field(
        default_factory=lambda: (
            os.getenv("DEUTSCH_SHADOW_AUTH_MODE", "local").strip().lower()
            if os.getenv("DEUTSCH_SHADOW_AUTH_MODE") and os.getenv("DEUTSCH_SHADOW_AUTH_MODE", "").strip()
            else "local"
        )
    )
    auth_password: Optional[str] = field(
        default_factory=lambda: os.getenv("DEUTSCH_SHADOW_AUTH_PASSWORD")
    )
    allowed_origins_raw: str = field(
        default_factory=lambda: os.getenv("DEUTSCH_SHADOW_ALLOWED_ORIGINS", "")
    )
    render_external_url: Optional[str] = field(
        default_factory=lambda: os.getenv("RENDER_EXTERNAL_URL")
    )

    # Whisper defaults
    default_whisper_model: str = field(
        default_factory=lambda: os.getenv("DEUTSCH_SHADOW_DEFAULT_MODEL", "base")
    )
    default_compute_type: str = field(
        default_factory=lambda: os.getenv("DEUTSCH_SHADOW_COMPUTE_TYPE", "int8")
    )
    default_cpu_threads: int = field(
        default_factory=lambda: int(os.getenv("DEUTSCH_SHADOW_CPU_THREADS", "4"))
    )
    default_language: str = "de"

    # Allowed import formats
    allowed_media_extensions: Set[str] = field(
        default_factory=lambda: {
            ".mp3",
            ".wav",
            ".m4a",
            ".mp4",
            ".aac",
            ".ogg",
            ".flac",
            ".webm",
            ".mkv",
        }
    )

    # Cloud mode upload limits & duration validation
    cloud_max_import_bytes: int = 25 * 1024 * 1024  # 25 MiB payload limit for media imports
    cloud_max_recording_bytes: int = 10 * 1024 * 1024  # 10 MiB payload limit for user vocal recordings
    cloud_max_duration_seconds: float = 180.0  # 180 seconds maximum audio duration in cloud mode
    multipart_framing_allowance_bytes: int = 64 * 1024  # 64 KiB framing allowance above payload limit

    @property
    def cloud_import_total_limit(self) -> int:
        """Total allowable request body size for media import in cloud mode including framing."""
        return self.cloud_max_import_bytes + self.multipart_framing_allowance_bytes

    @property
    def cloud_recording_total_limit(self) -> int:
        """Total allowable request body size for recording upload in cloud mode including framing."""
        return self.cloud_max_recording_bytes + self.multipart_framing_allowance_bytes

    @property
    def is_cloud_mode(self) -> bool:
        """True if server is configured for cloud deployment mode with authentication."""
        return self.auth_mode == "cloud"

    @property
    def allowed_origins(self) -> Set[str]:
        """Parsed set of trusted origins for CSRF validation."""
        origins: Set[str] = set()
        if self.allowed_origins_raw:
            for item in self.allowed_origins_raw.split(","):
                cleaned = item.strip().rstrip("/")
                if cleaned:
                    origins.add(cleaned)
        if self.render_external_url:
            cleaned_render = self.render_external_url.strip().rstrip("/")
            if cleaned_render:
                origins.add(cleaned_render)
        return origins

    @property
    def data_dir(self) -> Path:
        custom_data_dir = os.getenv("DEUTSCH_SHADOW_DATA_DIR")
        if custom_data_dir:
            return Path(custom_data_dir).resolve()
        return (self.base_dir / self.data_dir_name).resolve()

    @property
    def projects_dir(self) -> Path:
        return (self.data_dir / "projects").resolve()

    @property
    def database_path(self) -> Path:
        return (self.data_dir / self.db_name).resolve()

    @property
    def database_url(self) -> str:
        # SQLite with aiosqlite async driver
        # Use forward slashes for cross-platform SQLite URI
        db_file = self.database_path.as_posix()
        return f"sqlite+aiosqlite:///{db_file}"

    def assert_safe_data_path(self, target: str | Path) -> Path:
        """Ensure target path resolves strictly within data_dir."""
        p = Path(target)
        data_root = self.data_dir.resolve()

        if p.is_absolute():
            resolved = p.resolve()
        else:
            # Stored relative media paths are relative to base_dir (e.g. 'data/projects/...')
            from_base = (self.base_dir / p).resolve()
            if from_base == data_root or from_base.is_relative_to(data_root):
                resolved = from_base
            else:
                # Fall back to resolving relative directly to data_dir (e.g. 'projects/...')
                # but only if that candidate file actually exists inside data_dir
                from_data = (self.data_dir / p).resolve()
                if (from_data == data_root or from_data.is_relative_to(data_root)) and from_data.exists():
                    resolved = from_data
                else:
                    resolved = from_base

        if not (resolved == data_root or resolved.is_relative_to(data_root)):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Security violation: path traversal outside data directory detected: {target}",
            )
        return resolved

    def get_project_dir(self, project_id: str) -> Path:
        """Returns the isolated folder on disk for a given project ID after validating confinement."""
        if not project_id or not str(project_id).strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Security violation: project ID cannot be empty",
            )
        clean_id = str(project_id).strip()
        if clean_id in (".", "..", "/", "\\") or "/" in clean_id or "\\" in clean_id or ".." in clean_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Security violation: invalid project identifier: {project_id}",
            )

        target = (self.projects_dir / clean_id).resolve()
        projects_root = self.projects_dir.resolve()
        if target == projects_root or not target.is_relative_to(projects_root):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Security violation: project path traversal detected: {project_id}",
            )
        return target

    def resolve_media_path(self, relative_or_absolute: str | Path) -> Path:
        """Resolve a stored relative media path to an absolute path on disk and enforce confinement."""
        return self.assert_safe_data_path(relative_or_absolute)

    def to_relative_path(self, absolute_path: Path) -> str:
        """Store paths relative to base_dir to maintain portable database records."""
        try:
            return str(absolute_path.resolve().relative_to(self.base_dir))
        except ValueError:
            return str(absolute_path)


settings = Settings()

"""Centralized configuration and path management for Deutsch Shadow."""

from __future__ import annotations
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Set


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

    # Whisper defaults
    default_whisper_model: str = "base"
    default_compute_type: str = "int8"
    default_cpu_threads: int = 4
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

    @property
    def data_dir(self) -> Path:
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

    def get_project_dir(self, project_id: str) -> Path:
        """Returns the isolated folder on disk for a given project ID."""
        return (self.projects_dir / project_id).resolve()

    def resolve_media_path(self, relative_or_absolute: str | Path) -> Path:
        """Resolve a stored relative media path to an absolute path on disk."""
        p = Path(relative_or_absolute)
        if p.is_absolute():
            return p
        return (self.base_dir / p).resolve()

    def to_relative_path(self, absolute_path: Path) -> str:
        """Store paths relative to base_dir to maintain portable database records."""
        try:
            return str(absolute_path.resolve().relative_to(self.base_dir))
        except ValueError:
            return str(absolute_path)


settings = Settings()

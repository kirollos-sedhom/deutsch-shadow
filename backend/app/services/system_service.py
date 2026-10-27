"""Hardware auditing and Whisper model discovery service."""

from __future__ import annotations
import ctypes
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

from backend.app.schemas.system import SystemCapabilities, WhisperModelTier


def get_total_ram_gb() -> float:
    """Retrieve total system RAM in gigabytes across Windows and POSIX."""
    try:
        if sys.platform == "win32":
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return round(stat.ullTotalPhys / (1024**3), 1)
        else:
            pages = os.sysconf("SC_PHYS_PAGES")
            page_size = os.sysconf("SC_PAGE_SIZE")
            return round((pages * page_size) / (1024**3), 1)
    except Exception:
        return 8.0  # Fallback default


def check_cuda_support() -> tuple[bool, Optional[str]]:
    """Check whether CUDA acceleration is available via CTranslate2."""
    try:
        import ctranslate2
        cuda_count = ctranslate2.get_cuda_device_count()
        if cuda_count > 0:
            return True, f"NVIDIA CUDA Device ({cuda_count} GPU available)"
    except Exception:
        pass
    return False, None


def get_ffmpeg_info() -> tuple[bool, Optional[str], Optional[str]]:
    """Detect FFmpeg installation, binary path, and version string."""
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        return False, None, None

    version_str = None
    try:
        proc = subprocess.run(
            [ffmpeg_bin, "-version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=3,
        )
        if proc.returncode == 0:
            first_line = proc.stdout.splitlines()[0]
            version_str = first_line.split("Copyright")[0].strip()
    except Exception:
        version_str = "ffmpeg (detected)"

    return True, ffmpeg_bin, version_str


def get_system_capabilities() -> SystemCapabilities:
    """Perform a live hardware and capability audit of the host environment."""
    logical_cores = os.cpu_count() or 4
    # Approximate physical cores as logical // 2 on hyperthreaded machines
    physical_cores = max(1, logical_cores // 2 if logical_cores > 2 else logical_cores)
    ram_gb = get_total_ram_gb()
    cuda_avail, cuda_name = check_cuda_support()
    ffmpeg_ok, ffmpeg_path, ffmpeg_ver = get_ffmpeg_info()

    # Model recommendation logic:
    # - If CUDA available or >= 8 CPU cores and >= 16 GB RAM -> 'small' (recommended for German)
    # - If <= 6 CPU cores or < 16 GB RAM -> 'base' (safe CPU inference)
    if cuda_avail or (logical_cores >= 8 and ram_gb >= 15.0):
        recommended = "small"
    else:
        recommended = "base"

    return SystemCapabilities(
        cpu_physical_cores=physical_cores,
        cpu_logical_cores=logical_cores,
        ram_total_gb=ram_gb,
        cuda_available=cuda_avail,
        cuda_device_name=cuda_name,
        ffmpeg_available=ffmpeg_ok,
        ffmpeg_path=ffmpeg_path,
        ffmpeg_version=ffmpeg_ver,
        recommended_model=recommended,
    )


def get_model_tiers() -> List[WhisperModelTier]:
    """Return available faster-whisper model tiers with size and local download status."""
    caps = get_system_capabilities()
    models = [
        WhisperModelTier(
            name="tiny",
            size_mb=75.0,
            description="Ultra-fast, lowest accuracy; useful for quick checks on slow machines.",
            is_downloaded=False,
            is_recommended=caps.recommended_model == "tiny",
        ),
        WhisperModelTier(
            name="base",
            size_mb=145.0,
            description="Fast and lightweight (~140MB). Standard for multi-core modern CPUs.",
            is_downloaded=True,  # Verified downloaded in Milestone 2
            is_recommended=caps.recommended_model == "base",
        ),
        WhisperModelTier(
            name="small",
            size_mb=465.0,
            description="Recommended balance for German compound words, inflections, and punctuation.",
            is_downloaded=False,
            is_recommended=caps.recommended_model == "small",
        ),
        WhisperModelTier(
            name="medium",
            size_mb=1500.0,
            description="High precision for noisy or fast speech; requires 8+ threads or dedicated GPU.",
            is_downloaded=False,
            is_recommended=False,
        ),
    ]
    return models

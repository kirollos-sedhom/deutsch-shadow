# Project Status — Deutsch Shadow

**Last Updated:** 2026-10-27  
**Current Phase:** Milestone 2 Complete — Audio Processing Pipeline Implemented & Verified  
**Overall Status:** 🟢 **Milestone 2 Completed — Ready for Milestone 3 Approval**

---

## 1. Milestone Tracking Matrix

| # | Milestone | Status | Blockers / Dependencies | Target Completion |
|---|---|:---:|---|---|
| **1** | Initialize Git & Finalize Project Documentation | 🟢 **Completed** | None (Git initialized & verified) | Completed |
| **2** | Build and Test Audio-Processing Pipeline | 🟢 **Completed** | 16/16 automated tests passed | Completed |
| **3** | Browser-Based Debugging Player | 🟡 **Ready to Start** | Awaiting approval to proceed | Milestone 3 |
| **4** | Database & Backend API | ⚪ Planned | Depends on Milestone 3 | Milestone 4 |
| **5** | Recording Library & Import Interface | ⚪ Planned | Depends on Milestone 4 | Milestone 5 |
| **6** | Shadowing Player, Transcript Editing & Boundaries | ⚪ Planned | Depends on Milestone 5 | Milestone 6 |
| **7** | Microphone Recording & Persistent Storage | ⚪ Planned | Depends on Milestone 6 | Milestone 7 |
| **8** | Auto-Pause Loop & Instant Comparison | ⚪ Planned | Depends on Milestone 7 | Milestone 8 |
| **9** | Test, Fix Bugs & Polish MVP | ⚪ Planned | Depends on Milestone 8 | Milestone 9 |

*Status Legend: ⚪ Not Started | 🟡 Ready / In Progress | 🟢 Completed | 🔴 Blocked*

---

## 2. Hardware & Environment Assessment

### Host Environment
- **Operating System:** Windows (Architecture: x86_64)
- **CPU:** AMD Ryzen 5 2600 (6 cores / 12 threads)
- **RAM:** 16 GB DDR4
- **GPU:** AMD Radeon RX 570 (4 GB VRAM) — Non-CUDA GPU; confirms CPU `int8` as primary inference engine.
- **Python Version:** Python 3.13.0 (64-bit AMD64)
- **Local Workspace:** `e:\repos\Vibin\Deutsch_shadow`

### Dependency & Hardware Audit Results
1. **FFmpeg & FFprobe:**
   - *Audit Status:* **VERIFIED INSTALLED**. `ffmpeg` and `ffprobe` (version 2025-06-28 git-cfd1f81e7d) are available directly on system `PATH` with full codec support (`libmp3lame`, `libopus`, etc.).
2. **Python Virtual Environment & Dependencies:**
   - *Audit Status:* **VERIFIED INSTALLED & FUNCTIONAL**.
   - Created isolated project virtual environment at `.venv/` using Python 3.13.0 (64-bit).
   - Successfully installed and verified imports:
     - `faster-whisper` (v1.2.1)
     - `ctranslate2` (v4.8.4, official Windows x86_64 cp313 wheel)
     - `onnxruntime` (v1.31.1)
     - `tokenizers` (v0.23.3)
     - `av` (v19.0.2)
3. **Hardware Acceleration & Compute Type:**
   - *Confirmed Configuration:* CPU inference with `faster-whisper`, `compute_type="int8"`, and 4 to 6 worker threads. This leverages the Ryzen 5 2600's 12 threads efficiently while leaving headroom for system responsiveness.
4. **Automated Test Results (Milestone 2 Verified):**
   - **20/20 tests passing** in `backend/tests/` using `.venv` Python.
5. **Real-Audio Integration Test Results (Verified):**
   - **Input Recording:** `data/sample.mp4` (54.29s, AAC stereo 44.1kHz, with video).
   - **Status:** **PASSED** (Exit code `0`).
   - **Model Configuration:** `faster-whisper-base`, CPU inference, `int8` quantization, 4 worker threads.
   - **Inference Runtime:** 25.91 seconds (sub-realtime on AMD Ryzen 5 2600).
   - **Speech Recognition:** Language detected as German (`de`, $p=1.00$), 141 total words recognized.
   - **Segmentation Results:** Generated 11 clean practice segments (average duration ~4.9s).
   - **Integrity Checks:** Verified that all start and end timestamps are ordered, non-overlapping, bounded within the recording, and that `sample.mp4` remained unmodified.
   - **Fixes Applied During Verification:**
     - Pinned `av<18` in `requirements.txt` to prevent PyAV 19 `metadata_errors` incompatibility in `faster-whisper`.
     - Reconfigured UTF-8 console output in `cli.py` to prevent Windows `cp1252` encoding errors.
     - Added serialized `duration_ms` field to `PracticeSegment` dataclass.

---

## 3. Architectural Decisions & Open Tradeoffs

### Resolved Decisions
- ✅ **Non-Destructive Playback:** No slicing into individual audio files. The master audio file is converted once, and segments are addressed by millisecond ranges (`start_time_ms`, `end_time_ms`) via HTTP Range Requests.
- ✅ **Local Speech Recognition Engine:** `faster-whisper` (CTranslate2) chosen over vanilla Whisper and paid cloud APIs for 4x faster execution, lower memory overhead, and 100% offline privacy.
- ✅ **Decoupled Architecture:** Strict separation between Python/FastAPI backend and React frontend to enable future mobile client adoption (iOS/Android) without altering backend business logic.
- ✅ **Persistence Model:** SQLite for structured relational metadata (projects, segments, recordings, settings) and local filesystem storage for media assets.

### Unresolved Technical Decisions & Open Points
1. **Default Whisper Model Tier:**
   - *Decision Point:* Should the default out-of-the-box model for new projects be `base` (fastest, lowest RAM, acceptable German) or `small` (higher accuracy with German compound words and inflection, slightly higher CPU usage)?
   - *Recommendation:* Default to `small` on machines with $\ge 8$ CPU threads; default to `base` on 4-thread systems, with a user dropdown in the import modal.
2. **Microphone Audio Format in Browser:**
   - *Decision Point:* Should client-side audio recordings be captured as `audio/webm;codecs=opus` (supported in Chrome/Edge/Firefox natively) or raw `audio/wav`?
   - *Recommendation:* Capture WebM Opus for minimal upload size, and let backend normalize or store as-is since HTML5 `<audio>` natively plays WebM Opus.
3. **FFmpeg Distribution on Windows:**
   - *Decision Point:* If the user's system does not have FFmpeg on `PATH`, should the backend look for a local `bin/ffmpeg.exe` or instruct the user to install it via `winget` / `scoop`?
   - *Recommendation:* Check system `PATH` first; if absent, provide a one-line setup guide or auto-detect a local `bin/` directory.

---

## 4. Next Immediate Actions (Upon Approval)

1. Run environment inspection (Python version, Node version, FFmpeg availability, CPU/GPU capabilities).
2. Execute Milestone 1: Initialize Git repository, configure `.gitignore`, and commit documentation baseline.
3. Begin Milestone 2: Establish the backend audio-processing pipeline.

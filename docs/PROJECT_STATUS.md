# Project Status — Deutsch Shadow

**Last Updated:** 2026-10-28  
**Current Phase:** Milestone 5 Complete — Recording Library & Import Interface Operational & Verified  
**Overall Status:** 🟢 **Milestone 5 Completed — Ready for Milestone 6 (Shadowing Player Core & Editing)**

---

## 1. Milestone Tracking Matrix

| # | Milestone | Status | Blockers / Dependencies | Target Completion |
|---|---|:---:|---|---|
| **1** | Initialize Git & Finalize Project Documentation | 🟢 **Completed** | None (Git initialized & verified) | Completed |
| **2** | Build and Test Audio-Processing Pipeline | 🟢 **Completed** | Real-audio pipeline audited & verified | Completed |
| **3** | Browser-Based Debugging Player & Usability Polish | 🟢 **Completed** | Player UI, blind mode, upload & fixes verified | Completed |
| **4** | Database & Backend API | 🟢 **Completed** | SQLite schema & FastAPI endpoints verified | Completed |
| **5** | Recording Library & Import Interface | 🟢 **Completed** | React/TypeScript SPA + Vite + FastAPI verified | Completed |
| **6** | Shadowing Player, Transcript Editing & Boundaries | 🟡 **Ready to Start** | Awaiting approval to proceed | Milestone 6 |
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
     - `av` (v17.1.0 pinned)
3. **Hardware Acceleration & Compute Type:**
   - *Confirmed Configuration:* CPU inference with `faster-whisper`, `compute_type="int8"`, and 4 worker threads.
4. **Automated Test Results:**
   - **33/33 tests passing** in `backend/tests/` across unit and integration suites.
5. **Real-Audio Integration Test Results (Audited & Verified):**
   - **Input Recording:** `data/sample.mp4` (54.288s, AAC stereo 44.1kHz, with video).
   - **Status:** **PASSED** (Exit code `0`).
   - **Model Configuration:** `faster-whisper-base`, CPU inference, `int8` quantization, 4 worker threads.
   - **Speech Recognition:** Language detected as German (`de`, $p=1.00$), 141 total words recognized, 13 segments generated.
   - **Boundary & Duration Verification:** Validated via `scripts/verify_manifest.py` with 0 errors and 0 warnings (Exit code `0`).
6. **Milestone 3 Usability Fixes & Enhancements (Verified):**
   - **Final Sentence Cut-Off Audit & Root Cause:**
     - *Source File Truncation:* In `data/sample.mp4`, the speaker was saying *"beschädigt"*, but the source video cuts off abruptly at exactly `54.288s` mid-word, leaving Whisper to predict *"beschrieben."* with low confidence ($p=0.45$).
     - *Segmenter Padding Overlap Fix:* Segment 12 had tail padding extending to `53360ms`, which pushed Segment 13's start to `53360ms` and truncated the first syllable of *"Explosionen"*. Fixed `segmenter.py` to partition silence gaps without ever pushing a segment's start past its first word. Segment 13 now starts cleanly at `53280ms`.
     - *Browser Playback Stop Logic:* Prevented HTML5 `<audio>` from cutting off hardware output buffers early on terminal segments by allowing audio to play to `ended` event / media duration.
   - **Pedagogical Blind Mode (Transcript Masking):**
     - All segment transcripts default to blurred/masked mode (`filter: blur(6px)` with placeholder cursor).
     - Per-segment toggle via click or inline button; global toggle button in active controls bar (`👁 Reveal Transcript [T]`).
     - Navigating to another segment automatically resets the transcript to masked for focused listening.
     - Toggling reveal does not pause or interrupt audio playback.
   - **Media Import & Upload Interface (Audited & Verified):**
     - Added client-side file picker (`<input type="file">`) and `↺ Default Sample` reset button.
     - Resolved pipeline import integration in `backend/app/debug_server.py`: aligned with existing `AudioPipeline(whisper_config=..., segmentation_config=...)` API and `PipelineResult` dataclass attributes, eliminating false `PipelineConfig` dependency.
     - Verified upload isolation: uploads save into distinct directories under `data/uploads/<stem>_<timestamp>/` without mutating or overwriting original media files.
     - Verified atomic state transition: active manifest and audio paths only switch upon successful pipeline execution; errors preserve current media and return clean 500 JSON.
     - Tested live with real audio clip and verified seamless playback and reset to default sample.
   - **Narrow-Screen Layout:**
     - Added responsive CSS (`@media (max-width: 768px)`) with stacked cards, wrapped controls, and `overflow-x: hidden` preventing page scrolling.
   - **Automated Test Suite:**
     - Expanded to **34 tests** in `backend/tests/` covering file uploads, CORS preflight, resets, range requests, duration clamping, segmentation, and upload failure isolation. All pass in ~3.8s.
   - **Live Development Server:** Running at `http://127.0.0.1:8080`.
7. **Milestone 4 Database & Backend API Results (Verified):**
   - **Database Architecture:** SQLite storage with async engine (`aiosqlite`) via SQLAlchemy 2.0 ORM (`projects`, `segments`, `recordings`, `project_settings`).
   - **PRAGMA Enforcement:** Enforces `PRAGMA foreign_keys = ON;` on all connections ensuring relational integrity and cascading deletes.
   - **Data Validation & Schemas:** Pydantic v2 schemas across all routes (`ProjectSummary`, `ProjectDetail`, `SegmentRead`, `SegmentUpdate`, `SegmentSplitResponse`, `SegmentMergeResponse`, `SystemCapabilities`, `WhisperModelTier`).
   - **RESTful Endpoints Operational:**
     - `GET /api/health`: Healthcheck.
     - `GET /api/system/capabilities`: Live hardware audit (CPU cores, RAM in GB via ctypes, CUDA probe, FFmpeg binary & version, recommended model tier).
     - `GET /api/system/models`: Model discovery.
     - `GET /api/projects`: List all projects with segment counts.
     - `POST /api/projects/import`: Media upload & validation, background or synchronous pipeline processing.
     - `GET /api/projects/{id}`: Detailed project status and configuration.
     - `DELETE /api/projects/{id}`: Cascade deletion from database and file removal from disk.
     - `GET /api/projects/{id}/segments`: Ordered segment list.
     - `PATCH /api/segments/{id}`: Text editing and timestamp adjustment with boundary validation.
     - `POST /api/segments/{id}/split`: Segment splitting with atomic index shifting.
     - `POST /api/segments/{id}/merge`: Segment merging with neighboring segment.
     - `GET /api/media/{project_id}/master`: HTTP 206 Partial Content byte-range streaming.
   - **Verification & Test Coverage:**
     - **38/38 automated tests passing** across `pytest` and `unittest` suites.
     - Real-audio integration verified on `data/sample.mp4` (`scripts/test_milestone4_real.py`).

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

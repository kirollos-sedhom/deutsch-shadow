# AGENTS.md — Development Guidelines for Deutsch Shadow

This document establishes operating rules, architecture principles, and engineering standards for human and AI agents working on **Deutsch Shadow**.

---

## 1. Project Mission & North Star

**Deutsch Shadow** is a German listening and shadowing training application. The software enables German language learners to:
1. Ingest native German audio and video files.
2. Automatically segment speech using local speech recognition and German punctuation/syntax boundaries.
3. Practice active listening with obscured/revealed transcripts.
4. Play isolated speech segments on-demand from the original master audio file without slicing files into thousands of fragments.
5. Edit transcripts and adjust segment start/end timestamps.
6. Record and persist user vocal repetitions locally.
7. Practice with an Auto-Pause Loop and compare original versus user speech using one-click A/B playback.

**Key Invariant** The desktop version remains fully functional locally on Windows, macOS, and Linux without requiring cloud dependencies, user accounts, telemetry, or paid external APIs. Optional cloud deployment and future native mobile applications may be developed as separate targets without compromising the existing local-first desktop experience.

---

## 2. Core Architecture Principles

1. **Local-First & Zero Paid APIs**
   - Transcriptions run entirely on-device via `faster-whisper` (CTranslate2 engine).
   - Audio and video normalization/extraction is handled locally via `FFmpeg`.
   - Data is stored in local `SQLite` and local filesystem directories.

2. **Non-Destructive Segment Playback**
   - **Never slice the imported media into physical per-segment audio files on disk.**
   - The master audio file is converted once to a standardized web-compatible format (e.g., 16-bit 44.1kHz stereo/mono Opus/WAV/MP3).
   - Segments are defined purely as millisecond metadata (`start_time_ms`, `end_time_ms`) in the database.
   - The player seeks within the master file or streams time ranges.

3. **Decoupled Frontend and Backend**
   - The backend (`Python 3.11+ / FastAPI`) exposes clean RESTful endpoints (and WebSocket/SSE where live progress is required).
   - The frontend (`React 18+ / TypeScript / Vite`) interacts with the backend strictly via HTTP/JSON and standard audio streams.
   - No frontend code or browser-specific primitives may leak into backend processing logic.

4. **Hardware Agnosticism & Graceful Degradation**
   - Do not assume an NVIDIA GPU is available.
   - The default configuration must run smoothly on multi-core modern CPUs (using `int8` quantization).
   - Hardware detection must automatically probe for CUDA support and fallback to CPU without crashing.

5. **Data Integrity & Edit Preservation**
   - User transcript edits and boundary adjustments must never be overwritten by re-segmentation or background tasks without explicit user confirmation.
   - SQLite migrations/schema updates must preserve existing user recordings and custom boundary edits.

---

## 3. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| **Frontend** | React 18+, TypeScript, Vite | Fast build cycles, strong typing, robust Web Audio API ecosystem |
| **Styling** | Tailwind CSS (or clean CSS modules) | Accessible, responsive, rapid UI iteration |
| **Backend** | Python 3.11+, FastAPI, Uvicorn | High-performance asynchronous API, first-class ML/audio ecosystem |
| **Speech Recognition** | `faster-whisper` (CTranslate2) | 4x faster than vanilla Whisper, low memory footprint, excellent German accuracy |
| **Media Engine** | `FFmpeg` / `ffprobe` | Universal container/codec decoding, audio normalization, extraction |
| **Database** | SQLite via SQLAlchemy 2.0 / aiosqlite | Zero-config, single-file storage, reliable ACID guarantees |
| **Audio Playback/Recording** | HTML5 Audio / Web Audio API / MediaRecorder API | Native browser playback with precise millisecond seeking and local microphone capture |

---

## 4. Agent Working Rules & Etiquette

1. **Phase Discipline**
   - Strictly follow the numbered sequence in [MVP_CHECKLIST.md](file:///e:/repos/Vibin/Deutsch_shadow/docs/MVP_CHECKLIST.md).
   - Do not jump ahead to frontend UI construction before backend audio pipelines and verification tests pass.
   - Never write application code when asked only for planning or documentation.

2. **Verification & Testing**
   - Every audio processing step, segment algorithm, and API endpoint must have automated tests.
   - Before wiring the UI to the backend, verify segment alignment using the headless/debugging player milestone.
   - When modifying code, run unit and integration test suites before declaring work complete.

3. **Status Tracking**
   - Update [PROJECT_STATUS.md](file:///e:/repos/Vibin/Deutsch_shadow/docs/PROJECT_STATUS.md) whenever a milestone or significant task is completed or blocked.
   - Record architectural deviations or newly discovered edge cases in [TECHNICAL_DESIGN.md](file:///e:/repos/Vibin/Deutsch_shadow/docs/TECHNICAL_DESIGN.md).

4. **Code Quality & Typing**
   - TypeScript: Strict mode enabled (`"strict": true`). No `any` types unless interfacing with untyped 3rd-party audio events.
   - Python: Type annotations everywhere (`mypy` compliant), docstrings on all public methods, structured Pydantic schemas for request/response payloads.

5. **Cross-Platform File System Handling**
   - Always use `pathlib.Path` in Python to prevent Windows/Linux path separator bugs.
   - Store relative media paths in SQLite; resolve absolute storage paths via a centralized configuration class.

## 5. Stable Version Protection & Backward Compatibility

**Highest Priority:** The existing Windows version of Deutsch Shadow is a working application. Preserving its functionality and existing user data takes priority over introducing new platforms, deployment targets, or architectural improvements.

### 5.1 Git Branch Protection
- Treat `main` as the stable, production-quality branch.
- Never perform experimental development directly on `main`.
- Create a dedicated feature branch for deployment, Android development, or other substantial changes.
- Never merge changes into `main` without explicit user approval.
- Before starting work, inspect `git status`, the current branch, and recent commits.
- Never discard uncommitted user changes or reset Git history without explicit approval.

### 5.2 User Data Protection
- Never delete, overwrite, reset, or destructively migrate existing SQLite databases, project directories, imported media, recordings, or transcript edits without explicit approval.
- Never assume orphaned files or apparently unused data are safe to delete.
- Before modifying storage architecture or database schemas, inspect the existing implementation and document the migration strategy.
- All migrations must preserve existing user data and provide a recovery or rollback strategy.
- Never use production or personal user data as disposable test data.

### 5.3 Backward Compatibility
- Existing Windows functionality must remain operational throughout future development.
- New deployment targets (cloud hosting, Android, or other platforms) must be implemented with isolated configurations, modules, or platform-specific implementations wherever practical.
- Do not replace working Windows components merely because another platform requires different technology.
- Preserve the existing local-first desktop workflow as an independent supported deployment target.
- Cloud deployment must be optional and must not introduce a mandatory cloud dependency into the Windows version.

### 5.4 Change Management
- Before implementation, identify affected components and possible regressions.
- Prefer small, reversible changes over broad architectural rewrites.
- Do not introduce paid services, recurring costs, or external dependencies without explicit approval.
- Do not modify firewall rules, network exposure, authentication settings, or security configurations without explicit approval.
- If a requirement threatens existing functionality or data integrity, stop and explain the risk before proceeding.

### 5.5 Verification Requirements
After every significant implementation:
- Run relevant frontend and backend tests.
- Run regression tests for existing functionality.
- Verify production builds and inspect actual command exit codes.
- Inspect the Git diff for unintended changes.
- Confirm the existing Windows workflow remains functional.
- Report failed tests and unresolved risks honestly.

### 5.6 Explicit Approval Required
The following operations always require explicit user approval:
- Merging into `main`.
- Deleting or overwriting existing user data.
- Destructive database migrations.
- Replacing major architectural components.
- Introducing paid infrastructure or recurring subscriptions.
- Removing or disabling existing Windows functionality.

**Core Principle:** New functionality must never come at the expense of existing working functionality or user data.
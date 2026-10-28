# MVP Implementation Checklist — Deutsch Shadow

This checklist specifies the sequential implementation roadmap for the **Deutsch Shadow** MVP. Milestones must be executed in the exact order listed. Each milestone defines prerequisites, actionable tasks, rigorous testing requirements, and unambiguous completion criteria.

---

## Milestone 1: Initialize Git and Finalize Project Documentation

- **Goal:** Establish version control, repository structure, and align all project specifications and agent guidelines.
- **Prerequisites:** None.
- **Tasks:**
  - [x] Initialize Git repository (`git init`).
  - [x] Create comprehensive `.gitignore` for Python (`venv`, `__pycache__`, `.pytest_cache`), Node (`node_modules`, `dist`), SQLite (`*.db`, `*.sqlite`), and media files (`data/`).
  - [x] Establish initial project directory structure:
    - `backend/` (FastAPI application, audio processing services, tests)
    - `frontend/` (React/TypeScript/Vite application)
    - `data/` (local storage for audio, recordings, and SQLite DB)
    - `docs/` (project specifications and status documents)
  - [x] Review and verify consistency between `AGENTS.md`, `docs/PRODUCT_SPEC.md`, `docs/TECHNICAL_DESIGN.md`, `docs/MVP_CHECKLIST.md`, and `docs/PROJECT_STATUS.md`.
  - [x] Commit initial documentation files to Git.
- **Testing Requirements:**
  - Verify `git status` reports clean working directory and appropriate ignore rules.
  - Verify markdown links between documents resolve correctly.
- **Completion Criteria:**
  - Git repository initialized with initial commit containing all 5 core documentation files.
  - Directory skeleton exists without orphan files.

---

## Milestone 2: Build and Test the Audio-Processing Pipeline

- **Goal:** Implement the backend audio ingestion, FFmpeg normalization, speech-to-text transcription via `faster-whisper`, and German boundary segmentation algorithm.
- **Prerequisites:** Milestone 1 complete.
- **Tasks:**
  - [x] Set up Python dependency specification (`backend/requirements.txt`) and architecture models (`backend/app/audio/models.py`).
  - [x] Verify local system FFmpeg & FFprobe installation and create robust wrapper services (`MediaProbe`, `MediaConverter`):
    - Validate media files, durations, codecs, and channels via FFprobe.
    - Standardize to 16kHz mono 16-bit PCM WAV for Whisper (`whisper_working.wav`) while preserving master audio intact.
    - Gracefully report unsupported or corrupted media files.
  - [x] Implement hardware-configurable transcription module (`AudioTranscriber`) supporting `faster-whisper` with `language="de"`, `word_timestamps=True`, configurable CPU threads, device (`cpu`), and compute type (`int8`).
  - [x] Implement deterministic German segmentation engine (`GermanSegmenter`):
    - Split on German sentence terminals (`.`, `!`, `?`, German closing quotes `„...“`).
    - Guard German abbreviations (`z. B.`, `bzw.`, `ca.`, single-letter initials) against false sentence splits.
    - Split long sentences exceeding target duration (4.0s) at clause punctuation (`,`, `;`, `:`, `—`).
    - Split at acoustic pauses ($\ge 600\text{ms}$).
    - Enforce hard overflow protection ($\le 7.0\text{s}$) while keeping words intact.
    - Apply acoustic lead-in and tail-out padding ($+80\text{ms}$) with non-overlapping bounds.
  - [x] Build automated test suite (`backend/tests/`) covering normal sentences, abbreviations, multi-sentences, clause splitting, pause splitting, overflow, probe, conversion, and end-to-end pipeline execution with mock transcription.
  - [x] Provide a CLI tool (`python -m backend.app.audio.cli`) to run the pipeline on any audio/video recording and export a documented `manifest.json`.
- **Testing Requirements:**
  - [x] Unit tests for segmentation logic testing edge cases: compound words, abbreviations, long sentences, dialogue quotes, pauses, missing timestamps (16 tests passed).
  - [x] Integration tests for media probe and format converter using synthetic PCM audio files.
  - [x] Mock end-to-end pipeline test verifying JSON manifest export and segment structure.
- **Completion Criteria:**
  - [x] Automated test suite passing 100% (16/16 tests passing).
  - [x] Audio conversion and segmentation logic independently verified without UI or database dependencies.

---

## Milestone 3: Create a Browser-Based Debugging Player to Verify Segment Timestamps

- **Goal:** Validate that the calculated segment boundaries correspond accurately to spoken German audio in a real browser environment before building the full database or application UI.
- **Prerequisites:** Milestone 2 complete.
- **Tasks:**
  - [x] Create a minimal, self-contained HTML/JS test runner (`frontend/debug_player.html`).
  - [x] Provide a local HTTP server (`backend/app/debug_server.py`) supporting HTTP 206 Partial Content range requests and manifest delivery.
  - [x] Implement timestamp-bounded playback:
    - Play Segment $N$ (`audio.currentTime = start_ms / 1000.0`).
    - Stop or pause when `audio.currentTime >= end_ms / 1000.0`.
  - [x] Provide visual verification controls:
    - Next / Previous segment buttons and keyboard navigation (`Space`, `Left`, `Right`, `L`, `R`).
    - Loop toggle and Continuous playback mode.
    - Millisecond boundary display with manual nudge controls ($\pm 50\text{ms}$).
- **Testing Requirements:**
  - [x] Automated HTTP tests verifying manifest delivery, full audio streaming, and byte-range seeks on normal, short, and final segments (`test_debug_server.py`, `scripts/test_live_player.py`).
  - [x] Acoustic verification protocol for normal (Seg 1), short (Seg 4), and final boundary (Seg 13) segments.
- **Completion Criteria:**
  - [x] Developer and user can listen to each extracted segment in the browser and confirm that audio alignment matches the transcript text accurately.

---

## Milestone 4: Implement the Database and Backend API

- **Goal:** Implement persistent data storage via SQLite and expose full REST API endpoints for projects, segments, recordings, and media streaming.
- **Prerequisites:** Milestone 3 complete.
- **Tasks:**
  - [x] Implement SQLite schema and ORM models via SQLAlchemy / aiosqlite (`projects`, `segments`, `recordings`, `project_settings`).
  - [x] Implement HTTP Range Request audio streaming endpoint (`GET /api/media/{project_id}/master`) for seamless browser seeking.
  - [x] Implement project CRUD endpoints (`GET /api/projects`, `POST /api/projects/import`, `GET /api/projects/{id}`, `DELETE /api/projects/{id}`).
  - [x] Implement segment CRUD and editing endpoints:
    - `PATCH /api/segments/{id}` (text update, boundary adjustments).
    - `POST /api/segments/{id}/split` (split segment into two).
    - `POST /api/segments/{id}/merge` (merge segment with neighbor).
  - [x] Implement hardware and model query endpoint (`GET /api/system/capabilities`, `GET /api/system/models`).
- **Testing Requirements:**
  - API integration tests (`pytest` with `TestClient` / `httpx`) covering:
    - [x] Media upload and project creation flow.
    - [x] HTTP 206 Partial Content Range header verification.
    - [x] Segment boundary updates, split, and merge consistency.
    - [x] Cascade deletion of files and database records when a project is deleted.
    - [x] Real-audio end-to-end integration test with `data/sample.mp4` (`scripts/test_milestone4_real.py`).
- **Completion Criteria:**
  - [x] All REST endpoints operational, returning typed Pydantic responses with 100% test pass rate (38/38 tests passing).

---

## Milestone 5: Build the Recording Library and Import Interface

- **Goal:** Create the React frontend project, application shell, media import interface, and project management library.
- **Prerequisites:** Milestone 4 complete.
- **Tasks:**
  - [x] Initialize frontend application with Vite, React, TypeScript, and styling framework.
  - [x] Implement API client service with typed contracts corresponding to backend Pydantic models.
  - [x] Build **Project Library View**:
    - Project cards/table showing title, duration, segment count, date created, and progress.
    - Delete project confirmation modal.
  - [x] Build **Import Modal / Drag-and-Drop Zone**:
    - Support drag-and-drop or file browsing for audio/video files.
    - Display upload and transcription progress indicators.
    - Hardware-aware model selection option (e.g. `base` vs. `small`).
  - [x] **Milestone 5 UX & Architecture Stabilization**:
    - Design foundation with dark slate palette and semantic practice state tokens.
    - Mobile-first responsive layout down to 360px without horizontal overflow.
    - Non-blocking background imports with dismissible modal, cancellation, and active task banner.
    - Asynchronous retry API endpoint with duplicate-job protection.
    - Responsive stacked clip cards replacing rigid desktop table.
    - Restored pedagogical blind listening (blurred by default, tap/click reveal, global toggle, shortcut `T`).
- **Testing Requirements:**
  - Frontend component tests (Vitest / React Testing Library):
    - [x] `src/utils/formatters.test.ts` (4 unit tests passing).
    - [x] `src/components/ProjectList.test.tsx` (2 component tests passing).
    - [x] `src/components/ImportModal.test.tsx` (2 component tests passing).
    - [x] `src/components/ProjectDetailView.test.tsx` (5 component tests covering blind mode, tap reveal, global toggle, and shortcut `T`).
  - End-to-end and API integration tests:
    - [x] `backend/tests/test_milestone5_frontend_integration.py` (3 integration tests passing, including async retry & duplicate protection).
    - [x] Live E2E test `scripts/verify_milestone5_e2e.py` on real audio with live background polling and HTTP 206 streaming verification passing.
- **Completion Criteria:**
  - [x] User can launch the web interface, upload a German audio file, view non-blocking transcription progress, and see the processed project in the library.
  - [x] Restored blind listening with blurred German text and tap-to-reveal.
  - [x] Fully responsive across mobile (360px, 375px, 412px) and desktop.

---

## Milestone 6: Build the Shadowing Player, Transcript Editing, and Boundary Adjustment

- **Goal:** Deliver the primary shadowing interface with blind/revealed transcript modes, non-destructive segment navigation, and real-time boundary and text editing.
- **Prerequisites:** Milestone 5 complete.
- **Tasks:**
  - [x] Build **Shadowing Player Core (Phase 1 Verified)**:
    - Dedicated, mobile-first `ShadowingPlayer` component focused on one clip at a time.
    - Clip position indicator (`Clip N / Total`) and progress bar.
    - Play, Pause in-place, Resume from position without unwanted seeking, Replay from clip start boundary.
    - Next Segment and Previous Segment navigation with boundary-disabled states and automatic audio stop.
    - Native playback speed selection (`0.75x`, `0.85x`, `1.0x`, `1.15x`, `1.25x`) with pitch preservation and wall-clock boundary timer adjustment.
    - Pedagogical transcript masking by default, tap-to-reveal, toggle button, and predictable re-masking on clip navigation.
    - Ergonomic keyboard shortcuts (`Space`, `R`, `T`, `Left`, `Right`, `Esc`) with strict input/form element isolation.
    - Overview integration: "Start Shadowing" header action and per-clip "Shadow" button, with scroll and selection preservation on return.
  - [x] Build **Transcript In-Place Editor (Phase 2 Verified)**:
    - In-place German transcript text editor in `ShadowingPlayer`.
    - Save changes back to SQLite via `PATCH /api/segments/{id}` with `is_edited = true`.
    - Whitespace/empty text validation, Cancel draft discarding, and error preservation.
    - Synchronized with project overview clip list on return.
  - [x] Build **Segment Boundary Adjustment UI (Phase 2 Verified)**:
    - Expandable boundary drawer with touch-friendly nudge buttons ($\pm 25\text{ms}$, $\pm 100\text{ms}$).
    - Enforced invariants: non-negative start, $\ge 100\text{ms}$ duration, neighbor collision prevention, and media duration ceiling.
    - Touching adjacent segments allowed ($\text{gap} = 0$) without imposing artificial gaps.
    - Real-time acoustic boundary preview before saving.
    - Atomic database validation and persistence; failure preserves draft.
- **Testing Requirements:**
  - Frontend component tests (Vitest / React Testing Library):
    - [x] `src/components/ShadowingPlayer.test.tsx` (19 unit/integration tests covering playback, boundaries, navigation, speed, blind mode, text editing, draft cancellation, boundary nudges, limits, preview, and failure recovery).
    - [x] `src/components/ProjectDetailView.test.tsx` (11 component tests covering blind listening, segment playback, overview return, and edited segment synchronization).
    - [x] Total frontend suite: **38/38 tests passing**.
    - [x] Production build & TypeScript check (`tsc && vite build`): **0 errors**.
  - Backend integration tests:
    - [x] `backend/tests/test_segment_editing.py` (10 tests covering duration $\ge 100\text{ms}$, non-negative start, overlap rejection, touching segments, text edits, and project duration limits).
    - [x] Total backend test suite: **51/51 tests passing**.
- **Completion Criteria:**
  - [x] Phase 1 Core Player: User can seamlessly practice individual clips in a dedicated mobile-first player with speed adjustment, blind listening, keyboard navigation, and return to project overview.
  - [x] Phase 2: In-player transcript editing and boundary nudging with acoustic preview and atomic validation.

---

## Milestone 7: Add Microphone Recording and Persistent Local Storage

- **Goal:** Enable learners to record their own voice practicing each segment, replay their recording, and store all takes persistently on disk and in SQLite.
- **Prerequisites:** Milestone 6 complete.
- **Tasks:**
  - [ ] Implement browser microphone capture using `MediaRecorder` API or `AudioWorklet`.
  - [ ] Build recording controls in the shadowing player (Record button, hotkey `M`, visual recording indicator/timer).
  - [ ] Implement client-to-server audio upload (`POST /api/segments/{id}/recordings`) saving recordings in `data/projects/{project_id}/recordings/`.
  - [ ] Build Take Selector UI:
    - Display list of recorded takes per segment with timestamps.
    - Replay user's recorded take.
    - Delete unwanted takes.
    - Retain active take across app restarts.
- **Testing Requirements:**
  - Test microphone permission denial handling and clear user notifications.
  - Integration test verifying audio blob upload, server-side storage, database association, and replay.
- **Completion Criteria:**
  - User can record their voice for any segment, listen to their take, record multiple takes, and see their recordings persist after restarting both backend and browser.

---

## Milestone 8: Add Auto-Pause Loop and Original-Versus-Recording Comparison

- **Goal:** Implement hands-free practice workflows via the Auto-Pause Loop and instant A/B original-versus-user voice comparison.
- **Prerequisites:** Milestone 7 complete.
- **Tasks:**
  - [x] Implement **Auto-Pause Loop Engine**:
    - Play original native segment.
    - Automatically pause for a duration calculated as $\text{segment duration} \times \text{multiplier}$ (configurable: 1.0x, 1.2x, 1.5x, 2.0x).
    - Visual countdown / cadence progress bar during pause with monotonic deadline and pause/resume support.
    - Automatically loop current segment indefinitely until user explicitly stops or navigates.
  - [x] Implement **One-Click Comparison Player**:
    - Hotkey `C` and dedicated comparison button.
    - Sequential A/B mode: Plays original native segment at selected speed, inserts 250ms silence gap, then plays user's active take (or highest take_number fallback) at 1.0x.
    - Mutual exclusion, robust cancellation across all navigation/editing/recording actions, and clean suppression of auto-pause countdowns during comparison.
- **Testing Requirements:**
  - Test timing accuracy of the auto-pause loop across various segment lengths.
  - Verify seamless audio switching without audio glitches, pops, or browser audio context deadlock.
- **Completion Criteria:**
  - User can practice a project entirely hands-free using the Auto-Pause Loop and immediately compare their vocal cadence to the native speaker with a single keystroke.

---

## Milestone 9: Test, Fix Bugs, and Polish the MVP

- **Goal:** Harden the application against edge cases, optimize performance, verify offline functionality, and polish the user experience.
- **Prerequisites:** Milestone 8 complete.
- **Tasks:**
  - [ ] Run full automated test suite (backend unit & integration tests, frontend tests).
  - [ ] Comprehensive edge-case audit:
    - Audio with long initial silence or music intro.
    - High-speed conversational speech and overlapping speakers.
    - Media files with non-standard sample rates or multi-channel audio.
    - Extremely short (<1s) or long (>10s) segments.
  - [ ] Hardware stress test:
    - Test on CPU-only environment with `int8` quantization.
    - Monitor memory usage to prevent memory leaks during long audio processing.
  - [ ] Offline verification:
    - Disconnect network and verify all features (import, transcribe with cached model, playback, recording, editing) function without errors.
  - [ ] UI/UX polish:
    - Accessible styling, responsive layout, clear error toasts, empty states, and keyboard shortcut cheat sheet.
- **Testing Requirements:**
  - Complete end-to-end verification checklist on Windows environment.
  - Zero unhandled exceptions in browser console or backend logs during 30 minutes of continuous practice.
- **Completion Criteria:**
  - Fully functional, thoroughly tested, standalone German shadowing MVP ready for daily language practice.

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
  - [ ] Set up Python virtual environment and dependencies (`fastapi`, `uvicorn`, `faster-whisper`, `pydantic`, `pytest`).
  - [ ] Verify local system FFmpeg installation and create a robust wrapper service to probe and convert media:
    - Extract audio from video containers (`.mp4`, `.mkv`, `.webm`).
    - Standardize to master audio (`master.mp3`, 44.1kHz stereo/mono).
    - Generate 16kHz mono WAV for Whisper.
  - [ ] Implement hardware detection utility (`cpu` vs. `cuda`, core count, RAM) and dynamic `faster-whisper` configuration (`compute_type="int8"` for CPU).
  - [ ] Implement transcription worker utilizing `faster-whisper` with `language="de"` and `word_timestamps=True`.
  - [ ] Implement German sentence and clause segmentation algorithm:
    - Split on German sentence terminals (`.`, `!`, `?`).
    - Sub-split long segments on pauses ($\ge 600\text{ms}$) or clause punctuation (`,`, `;`, `:`).
    - Add acoustic padding ($+80\text{ms}$ start/end).
    - Format output as structured segment dicts: `start_ms`, `end_ms`, `text`.
- **Testing Requirements:**
  - Unit tests for audio file conversion using synthetic audio or sample German audio clips.
  - Unit tests for segmentation logic testing edge cases: compound words, long sentences, numbers, questions, dialogue quotes.
  - Benchmark test logging CPU inference speed and memory consumption.
- **Completion Criteria:**
  - Passing automated test suite (`pytest`) verifying that a sample German audio file produces clean, non-overlapping segments with valid millisecond timestamps and German text.

---

## Milestone 3: Create a Browser-Based Debugging Player to Verify Segment Timestamps

- **Goal:** Validate that the calculated segment boundaries correspond accurately to spoken German audio in a real browser environment before building the full database or application UI.
- **Prerequisites:** Milestone 2 complete.
- **Tasks:**
  - [ ] Create a minimal, self-contained HTML/JS test runner or lightweight Vite prototype.
  - [ ] Provide a local file loader or simple static file server for `master.mp3` and the JSON segment manifest produced by Milestone 2.
  - [ ] Implement timestamp-bounded playback:
    - Play Segment $N$ (`audio.currentTime = start_ms / 1000.0`).
    - Stop or pause when `audio.currentTime >= end_ms / 1000.0`.
  - [ ] Provide visual verification controls:
    - Next / Previous segment buttons.
    - Loop toggle.
    - Millisecond boundary display with manual nudge controls ($\pm 50\text{ms}$).
- **Testing Requirements:**
  - Manual acoustic verification with at least 3 distinct native German audio samples (podcast dialogue, news broadcast, conversational interview).
  - Confirm that start and end boundaries do not clip words, plosives, or word-final consonants.
- **Completion Criteria:**
  - Developer can listen to each extracted segment in the browser and confirm that audio alignment matches the transcript text accurately.

---

## Milestone 4: Implement the Database and Backend API

- **Goal:** Implement persistent data storage via SQLite and expose full REST API endpoints for projects, segments, recordings, and media streaming.
- **Prerequisites:** Milestone 3 complete.
- **Tasks:**
  - [ ] Implement SQLite schema and ORM models via SQLAlchemy / aiosqlite (`projects`, `segments`, `recordings`, `project_settings`).
  - [ ] Implement HTTP Range Request audio streaming endpoint (`GET /api/media/{project_id}/master`) for seamless browser seeking.
  - [ ] Implement project CRUD endpoints (`GET /api/projects`, `POST /api/projects/import`, `GET /api/projects/{id}`, `DELETE /api/projects/{id}`).
  - [ ] Implement segment CRUD and editing endpoints:
    - `PATCH /api/segments/{id}` (text update, boundary adjustments).
    - `POST /api/segments/{id}/split` (split segment into two).
    - `POST /api/segments/{id}/merge` (merge segment with neighbor).
  - [ ] Implement hardware and model query endpoint (`GET /api/system/capabilities`).
- **Testing Requirements:**
  - API integration tests (`pytest` with `TestClient` / `httpx`) covering:
    - Media upload and project creation flow.
    - HTTP 206 Partial Content Range header verification.
    - Segment boundary updates, split, and merge consistency.
    - Cascade deletion of files and database records when a project is deleted.
- **Completion Criteria:**
  - All REST endpoints operational, returning typed Pydantic responses with 100% test pass rate.

---

## Milestone 5: Build the Recording Library and Import Interface

- **Goal:** Create the React frontend project, application shell, media import interface, and project management library.
- **Prerequisites:** Milestone 4 complete.
- **Tasks:**
  - [ ] Initialize frontend application with Vite, React, TypeScript, and styling framework.
  - [ ] Implement API client service with typed contracts corresponding to backend Pydantic models.
  - [ ] Build **Project Library View**:
    - Project cards/table showing title, duration, segment count, date created, and progress.
    - Delete project confirmation modal.
  - [ ] Build **Import Modal / Drag-and-Drop Zone**:
    - Support drag-and-drop or file browsing for audio/video files.
    - Display upload and transcription progress indicators.
    - Hardware-aware model selection option (e.g. `base` vs. `small`).
- **Testing Requirements:**
  - Frontend component tests (Vitest / React Testing Library) for import file validation and library rendering.
  - End-to-end integration test: uploading a German audio file through the UI, observing progress, and navigating to the created project.
- **Completion Criteria:**
  - User can launch the web interface, upload a German audio file, view transcription progress, and see the processed project in the library.

---

## Milestone 6: Build the Shadowing Player, Transcript Editing, and Boundary Adjustment

- **Goal:** Deliver the primary shadowing interface with blind/revealed transcript modes, non-destructive segment navigation, and real-time boundary and text editing.
- **Prerequisites:** Milestone 5 complete.
- **Tasks:**
  - [ ] Build **Shadowing Player Core**:
    - Waveform or timeline segment track.
    - Play/Pause, Next Segment, Previous Segment, and Segment Looping controls.
    - Ergonomic keyboard shortcuts (`Space`, `R`, `Left`, `Right`, `L`).
  - [ ] Build **Transcript Display & Blind Mode**:
    - Default "Blind Mode" with blurred or hidden text.
    - "Reveal" toggle button and keyboard hotkey (`R`) to show German text.
  - [ ] Build **Transcript In-Place Editor**:
    - Double-click or edit button to correct transcript text.
    - Save changes back to SQLite via `PATCH /api/segments/{id}`.
  - [ ] Build **Segment Boundary Adjustment UI**:
    - Start and end time nudge buttons ($\pm 25\text{ms}$, $\pm 100\text{ms}$).
    - Split segment action (at playhead position).
    - Merge with next / previous segment action.
- **Testing Requirements:**
  - Unit tests for boundary adjustment logic ensuring start time cannot exceed end time and adjacent segments remain ordered.
  - Manual verification of keyboard navigation and transcript reveal interactions.
- **Completion Criteria:**
  - User can seamlessly navigate segments, hide/reveal transcripts, adjust boundaries with audible feedback, and edit text with automatic persistence.

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
  - [ ] Implement **Auto-Pause Loop Engine**:
    - Play original native segment.
    - Automatically pause for a duration calculated as $\text{segment duration} \times \text{multiplier}$ (configurable, e.g. 1.0x – 1.5x).
    - Visual countdown / cadence progress bar during pause.
    - Optional automatic microphone recording during the pause interval.
    - Automatically loop or advance to next segment.
  - [ ] Implement **One-Click Comparison Player**:
    - Hotkey `C` and dedicated comparison button.
    - Sequential A/B mode: Plays original native segment, inserts 250ms silence, then plays user's latest take.
    - Instant toggle mode: Switch between native speaker and user voice on the fly.
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

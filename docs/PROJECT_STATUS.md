# Project Status — Deutsch Shadow

**Last Updated:** 2026-10-28  
**Current Phase:** Milestone 6 Complete — Shadowing Player, Transcript Editing & Boundary Adjustment Operational & Verified  
**Overall Status:** 🟢 **Milestone 6 Completed — Ready for Milestone 7 (Microphone Recording & Local Storage)**

---

## 1. Milestone Tracking Matrix

| # | Milestone | Status | Blockers / Dependencies | Target Completion |
|---|---|:---:|---|---|
| **1** | Initialize Git & Finalize Project Documentation | 🟢 **Completed** | None (Git initialized & verified) | Completed |
| **2** | Build and Test Audio-Processing Pipeline | 🟢 **Completed** | Real-audio pipeline audited & verified | Completed |
| **3** | Browser-Based Debugging Player & Usability Polish | 🟢 **Completed** | Player UI, blind mode, upload & fixes verified | Completed |
| **4** | Database & Backend API | 🟢 **Completed** | SQLite schema & FastAPI endpoints verified | Completed |
| **5** | Recording Library & Import Interface | 🟢 **Completed** | React/TypeScript SPA + Vite + FastAPI verified | Completed |
| **6** | Shadowing Player, Transcript Editing & Boundaries | 🟢 **Completed** | Core player, transcript editing & boundaries verified | Completed |
| **7** | Microphone Recording & Persistent Storage | 🟡 **Phase 3 Complete** | Phases 1–3 implemented & verified; ready for Phase 4 verification | Milestone 7 |
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
8. **Milestone 5 Recording Library, Import Interface & UX Stabilization (Verified):**
   - **Frontend Stack:** React 18.3, TypeScript 5.7, Vite 6.4, Lucide-React, Vitest 5.0, Happy-DOM.
   - **Design Foundation:** Clean, distraction-free slate palette (#090d16, #0f172a, #1e293b, #334155) with accessible semantic practice state tokens (Not Practiced, Difficult, Practiced, Mastered).
   - **Non-Blocking Background Processing:** Separated file transfer from background transcription; import modal can be cancelled during upload or dismissed immediately upon job creation. Active background task banner keeps users informed while they browse other ready projects.
   - **Asynchronous Retry API:** POST /api/projects/{id}/process executes asynchronously via BackgroundTasks with duplicate-job protection (returns immediately if already processing) and stale segment cleanup.
   - **Restored Blind Listening:** Transcripts masked by default (ilter: blur(8px)), individual tap/click reveal, global Blind Mode toggle button, and keyboard shortcut (T) for distraction-free shadowing.
   - **Mobile-First Responsive Layout:** Stacked clip cards replacing rigid desktop table; responsive navbar and cards down to 360px without horizontal overflow; accessible >=44px touch targets.
   - **Automated Verification:**
     - **13/13 frontend tests passing** via Vitest (100% pass rate).
     - **41/41 backend tests passing** via pytest (100% pass rate).
     - **TypeScript check and production build verified:** zero compilation or type errors.
9. **Milestone 6 Phase 1 Core Shadowing Player (Verified):**
   - **Dedicated Component:** `ShadowingPlayer.tsx` for focused, distraction-free practice on one German speech clip at a time.
   - **Clip Navigation & Progress:** Sequential position tracking (`Clip N / Total`) with visual progress line, clip timestamps, and duration badge.
   - **Precision Audio Controls:** Non-seeking pause, resume within boundaries, replay from start offset, and boundary clamping using synchronized wall-clock timers accounting for `playbackRate`.
   - **Native Playback Speed:** Five speed presets (`0.75x`, `0.85x`, `1.0x`, `1.15x`, `1.25x`) with native pitch preservation (`preservesPitch = true`) and timer rescheduling.
   - **Pedagogical Blind Listening:** German transcript masked by default (`filter: blur(8px)`), tap-to-reveal on text card or action button, and automatic re-masking on clip transitions.
   - **Desktop Keyboard Ergonomics:** `Space` (Play/Pause), `R` (Replay), `T` (Reveal), `Left`/`Right` (Navigation), `Esc` (Exit), with complete isolation from text inputs.
   - **Overview Integration:** "Start Shadowing" header action and per-clip "Shadow" button in `ProjectDetailView.tsx`, returning with scroll and selection preservation.
   - **Automated Verification:**
     - **28/28 frontend tests passing** via Vitest (100% pass rate).
     - **41/41 backend tests passing** via pytest (100% pass rate).
     - **TypeScript check and production build verified:** zero compilation or type errors.
10. **Milestone 6 Phase 2 Transcript Editing & Boundary Adjustment (Verified):**
    - **German Transcript Editing:** Inline editing with autosizing textarea, draft management, cancel/discard, whitespace-only prevention, and is_edited = true flag persistence via PATCH /api/segments/{id}.
    - **Fine Boundary Nudge Drawer:** Dedicated collapsible drawer with touch-friendly ±25 ms and ±100 ms micro-adjustments for segment start and end boundaries.
    - **Boundary Constraints & Safeguards:** Strict validation enforcing start >= 0 ms, minimum clip duration >= 100 ms, boundary ceiling capped at total project duration, and neighbor boundary overlap prevention while permitting contiguous touching segments (gap == 0).
    - **Live Draft Preview:** Auditory preview of proposed draft boundaries before saving, without persisting uncommitted changes.
    - **Overview Synchronization:** Immediate in-memory state propagation from player to overview list upon save, eliminating unnecessary API refetches or media re-processing.
    - **Draft & Error Preservation:** Network or validation errors preserve the user's uncommitted draft text and boundaries with clear contextual error messages.
    - **Keyboard Shortcut Isolation:** Resolved shortcut collision (T key) between ProjectDetailView and ShadowingPlayer during active practice.
    - **Automated Verification:**
      - **38/38 frontend tests passing** via Vitest (100% pass rate).
      - **51/51 backend tests passing** via pytest (100% pass rate).
      - **TypeScript check and production build verified:** zero compilation or type errors.

11. **Milestone 7 Phase 1 Backend Recording Persistence & API (Verified):**
    - **Physical Audio Storage:** Audio takes stored locally under `data/projects/{project_id}/recordings/{recording_id}.{ext}` with atomic temp-file write-then-rename and clean rollback.
    - **SQLite Metadata Model:** `recordings` table with `id`, `segment_id`, `take_number`, `duration_ms`, `is_active`, `created_at`, cascading foreign key on segment deletion, and sequential take numbering per segment.
    - **Format Validation & Inspection:** Safe MIME and container extension validation supporting WebM Opus (`audio/webm`), Ogg Opus (`audio/ogg`), MP4 AAC (`audio/mp4`), and WAV (`audio/wav`), rejecting mismatched extensions or corrupted headers.
    - **Automatic Active Take Designation:** New takes automatically designated active; deleting an active take promotes the latest remaining take; deleting all takes resets segment `recordings_count` to 0.
    - **Split/Merge Safeguards:** Explicitly blocked splitting segments that have user recordings to prevent audio mismatch; merge cleans up and reassigns recordings safely.
    - **Automated Verification:**
      - **73/73 backend tests passing** via pytest (100% pass rate).

12. **Milestone 7 Phase 2 Frontend API Client & Capture Hook (Verified):**
    - **API Client:** Added typed methods in `client.ts` (`getRecordings`, `uploadRecording`, `deleteRecording`, `setActiveTake`, `getRecordingAudioUrl`, `getAudioExtensionFromMime`).
    - **Microphone Capture Hook:** Hardened `useAudioRecorder.ts` with permission lifecycle, supported MIME negotiation, hardware track release, error abort guards, and monotonic timer tracking.
    - **Automated Verification:**
      - **33/33 frontend hook & API tests passing** via Vitest (100% pass rate).

13. **Milestone 7 Phase 3 ShadowingPlayer UI & Take Management (Verified):**
    - **Recording Studio Component:** `RecordingStudio.tsx` implementing idle, active recording, pause/resume, review before save, discard, and re-record workflows.
    - **Saved Takes Management:** Sequential take badges, active take designation (`is_active` star indicator), inline two-step delete confirmation, and take audio playback.
    - **Bidirectional Mutual Audio Exclusion:** Starting recording or playing a user take immediately halts original German master playback; playing master playback pauses review preview or take audio.
    - **Robust Navigation Guarding:** Synchronous ref and reactive guards on Prev, Next, Overview button, and Escape key:
      - Active recording / review pending: confirmation modal with `[Stay on Clip]` and `[Discard & Proceed]`.
      - In-flight upload: Prev, Next, and Overview navigation controls disabled until upload settles.
      - Discarding cleans up media tracks, resets recorder state, and revokes Blob object URLs.
    - **Session Caching:** In-memory caching of takes per segment across clip navigation, updated consistently on save, active toggle, and delete.
    - **Automated Verification:**
      - **91/91 frontend tests passing** via Vitest (100% pass rate).
      - **73/73 backend tests passing** via pytest (100% pass rate).
      - **TypeScript check and production build verified:** zero compilation or type errors.

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

1. Review and plan Milestone 7: Microphone Recording & Persistent Storage.
2. Design MediaRecorder API client workflow for capturing user vocal repetitions.
3. Design backend endpoints and SQLite schema integration for storing user audio takes locally.

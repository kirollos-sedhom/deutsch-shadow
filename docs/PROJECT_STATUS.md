# Project Status — Deutsch Shadow

**Last Updated:** 2026-10-27  
**Current Phase:** Milestone 1 Complete — Project Scaffolding & Git Initialized  
**Overall Status:** 🟢 **Milestone 1 Completed — Ready for Milestone 2 Approval**

---

## 1. Milestone Tracking Matrix

| # | Milestone | Status | Blockers / Dependencies | Target Completion |
|---|---|:---:|---|---|
| **1** | Initialize Git & Finalize Project Documentation | 🟢 **Completed** | None (Git initialized & verified) | Completed |
| **2** | Build and Test Audio-Processing Pipeline | 🟡 **Ready to Start** | Awaiting approval to proceed | Milestone 2 |
| **3** | Browser-Based Debugging Player | ⚪ Planned | Depends on Milestone 2 | Milestone 3 |
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
- **Operating System:** Windows 10/11 (Architecture: x86_64)
- **Local Workspace:** `e:\repos\Vibin\Deutsch_shadow`

### Dependency & Hardware Requirements
1. **FFmpeg & FFprobe:**
   - *Requirement:* FFmpeg executable must be accessible to extract audio from video and normalize files to 44.1kHz MP3 and 16kHz WAV.
   - *Audit Status:* Needs confirmation on the user's Windows environment whether `ffmpeg` is on system `PATH` or should be placed in a local project binary folder.
2. **Python Environment:**
   - *Requirement:* Python 3.10, 3.11, or 3.12 64-bit.
   - *Audit Status:* Needs virtual environment creation (`.venv`) and verification of C-compiler/wheel compatibility for CTranslate2.
3. **Hardware Acceleration & Compute Type:**
   - *GPU Policy:* **Do not assume an NVIDIA GPU is available.**
   - *Baseline Configuration:* CPU inference with `faster-whisper` using `compute_type="int8"`. This requires no CUDA drivers, consumes minimal RAM (~500MB for `small` model), and runs reliably across all x86_64 systems.
   - *Dynamic GPU Detection:* If an NVIDIA GPU with CUDA 11/12 is detected at runtime, the backend can automatically upgrade compute mode to `cuda` with `float16`.
4. **Node.js & Frontend Tooling:**
   - *Requirement:* Node.js 18+ and `npm` / `pnpm` for Vite and React development.

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

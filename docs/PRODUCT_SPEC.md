# Product Specification — Deutsch Shadow

**Version:** 1.0.0-MVP  
**Status:** Planning / In Review  
**Target Platform:** Desktop (Windows, macOS, Linux) via Browser / Local Server; Future Mobile (iOS / Android)

---

## 1. Product Vision & Goals

**Deutsch Shadow** is an interactive German listening and shadowing desktop application. Its mission is to bridge the gap between passive listening and spoken fluency for German language learners.

Language learners frequently encounter two major hurdles when listening to native German media:
1. Fast, connected speech with compound words, elisions, and colloquial rhythm that is hard to isolate by ear alone.
2. The lack of a tight, low-friction feedback loop to immediately practice pronunciation, prosody, and rhythm against the native model.

Deutsch Shadow solves this by:
- Ingesting authentic German media (podcasts, YouTube downloads, audiobooks, interview audio/video).
- Generating sentence- and phrase-level speech segments with word timestamps.
- Allowing learners to practice "blind listening" (transcript hidden) before validating comprehension (transcript revealed).
- Enabling instant shadowing: learners record themselves repeating short segments, then immediately compare their cadence and pronunciation side-by-side with the native speaker.

---

## 2. Target Audience & User Personas

### Primary Persona: The Intermediate-to-Advanced German Learner (A2 – C1)
- **Goal:** Improve listening comprehension of authentic spoken German and overcome speaking hesitation / foreign accent.
- **Pain Points:** 
  - Standard audio players (Spotify, VLC, YouTube) make it difficult to loop a single 3-second phrase without tedious manual scrubbing.
  - Slicing audio files manually in Audacity is time-prohibitive.
  - Cloud services (e.g. Speechling, paid ASR APIs) require monthly subscriptions, privacy compromises, or permanent internet connections.
- **Workflow in Deutsch Shadow:**
  1. Imports a 5-minute episode of a German podcast (e.g., *Easy German*, *Tagesschau*, *Slow German*).
  2. The app segments the audio into natural 2-to-6 second phrases.
  3. The learner loops Segment 1 with the transcript hidden, attempting to decipher every word.
  4. The learner reveals the transcript to verify their listening.
  5. The learner records themselves speaking the phrase in the Auto-Pause Loop.
  6. The learner presses the comparison shortcut to hear the native speaker followed immediately by their own voice.
  7. Moves to Segment 2.

---

## 3. Core Functional Requirements

### 3.1 Media Ingestion & Project Management
- **Format Support:** Audio (`.mp3`, `.wav`, `.m4a`, `.aac`, `.flac`, `.ogg`) and Video (`.mp4`, `.mkv`, `.webm`, `.mov`).
- **Local Import:** Drag-and-drop or file selector via web UI.
- **Media Preprocessing:**
  - Fast extraction of the audio stream from video files via FFmpeg.
  - Conversion to a single standardized, web-deliverable master audio file (16-bit 44.1kHz stereo/mono) stored in the project directory.
  - Production of a downsampled 16kHz mono WAV representation strictly for speech recognition ingestion.
- **Persistent Library:**
  - Projects view displaying title, duration, segment count, date created, and practice completion status.
  - All project metadata, segments, and audio file references stored in SQLite.

### 3.2 Local Speech Recognition & Boundary Segmentation
- **Zero-Cloud Local Transcription:**
  - Powered by `faster-whisper` (CTranslate2).
  - Explicit language pinning to German (`language="de"`).
  - Configurable model tiers (`tiny`, `base`, `small`, `medium`) based on host hardware capabilities.
- **Timestamp Extraction:**
  - Word-level timestamps extracted via Whisper cross-attention weights (`word_timestamps=True`).
- **Segmentation Strategy:**
  - Segments must reflect natural shadowing units (ideally 2 to 7 seconds or 5 to 15 words).
  - Split primarily on terminal German sentence punctuation (`.`, `!`, `?`).
  - Sub-split long compound sentences on clause punctuation (`,`, `;`, `:`, `—`) or acoustic pauses (> 600ms) to prevent cognitive overload during shadowing.
  - Maintain lead-in and tail-out padding (e.g., 60–100ms) to ensure initial plosives and word endings are not clipped.

### 3.3 Non-Destructive Segment Playback
- **Master Audio Addressing:**
  - Segments are represented in the database solely by `start_time_ms` and `end_time_ms` offsets against the master file.
  - The application **must not** generate fragmented `.wav`/`.mp3` files for each segment.
  - Playback engine seeks the master HTML5 audio element or uses Web Audio API buffer offsets to play segments seamlessly.

### 3.4 Shadowing Player Experience
- **Transcript Visibility Modes:**
  - **Blind Mode (Default):** Transcript text is blurred, redacted, or hidden behind a toggle button. Forces the ear to do the work.
  - **Revealed Mode:** Clicking "Reveal" or hitting the `Space`/`R` shortcut displays the transcript.
- **Playback Controls:**
  - Replay current segment (instant seek to `start_time_ms`).
  - Next / Previous segment navigation via arrow keys.
  - Playback speed adjustment (0.75x, 0.85x, 1.0x, 1.15x, 1.25x) with pitch preservation.
  - Segment Looping (loop single segment continuously).

### 3.5 In-App Transcript & Boundary Editing
- **Transcript Correction:**
  - In-place text editor for fixing Whisper transcription errors or dialectal misspellings.
  - Mark edited segments as `is_edited = true` to preserve changes.
- **Boundary Fine-Tuning:**
  - Interactive waveform or nudge buttons (`-100ms`, `+100ms`, `-25ms`, `+25ms`) for both start and end timestamps.
  - Split and merge actions:
    - Split a segment into two at current playhead position or word boundary.
    - Merge current segment with the next or previous segment.

### 3.6 Microphone Recording & Persistence
- **In-Browser Audio Recording:**
  - Capture microphone input via the HTML5 `MediaRecorder` API or `AudioWorklet`.
  - Format: Uncompressed WAV or high-bitrate WebM Opus.
- **Upload & Local File Association:**
  - Send recording blob to the backend upon completion.
  - Saved to disk in a dedicated project directory: `data/projects/{project_id}/recordings/{segment_id}_{timestamp}.webm`.
  - Stored in SQLite linked to `segment_id`.
- **Multiple Takes:**
  - Learners can re-record segments. All takes are persisted or the latest take is designated as active with previous takes archived.

### 3.7 Practice Modes: Auto-Pause Loop & Instant Comparison
- **Auto-Pause Loop Mode:**
  1. Play original segment audio.
  2. Automatically pause for an adjustable duration (e.g., 1.0x to 1.5x of the segment duration) to allow the learner to repeat aloud.
  3. Optionally auto-record the learner's voice during the pause.
  4. Automatically loop or proceed to the next segment.
- **One-Click A/B Comparison:**
  - Hotkey or UI button to alternate instantly between the native speaker's audio and the learner's recorded take.
  - Sequential playback mode: "Play Original -> 300ms silence -> Play User Recording".

---

## 4. Non-Functional Requirements

### 4.1 Performance & Responsiveness
- **Audio Seeking Latency:** Less than 50ms seeking latency between segment jumps.
- **Inference Speed:**
  - On a standard modern 8-core CPU with `int8` quantization, transcription of 1 minute of German audio must complete in under 20 seconds using the `base` or `small` model.
  - On an NVIDIA GPU (CUDA), under 5 seconds per minute of audio.
- **Memory Footprint:**
  - Backend memory usage under 2 GB on CPU for `small` model.

### 4.2 Hardware Agnosticism
- Application must run out of the box on machines without a dedicated GPU.
- Automatic device detection selects `cpu` compute type `int8` when CUDA drivers are absent.

### 4.3 Privacy & Offline Reliability
- **100% Offline Capability:** The app must function completely in airplane mode once dependencies and Whisper model weights are locally cached.
- **Zero External Calls:** No network traffic to analytics, cloud ASR, or telemetry services.

### 4.4 Decoupled Architecture for Future Mobile App
- The Python/FastAPI backend acts as a standalone REST API server.
- The React frontend connects via standardized HTTP endpoints and media streams.
- Future mobile clients (React Native, Flutter, Swift/Kotlin) can connect to the identical backend endpoints without modifying business logic.

---

## 5. German Language Considerations & Edge Cases

1. **Compound Words (Komposita):**
   - German frequently chains nouns (*Rechtsschutzversicherungsgesellschaften*). Whisper word timestamps may treat the whole compound as a single token or split it into subwords. The segmentation algorithm must not split across subword tokens.
2. **Glottal Stops & Plosives:**
   - German words starting with vowels feature distinct glottal stops (*Knacklaut*). Adding 60–100ms lead-in padding prevents cutting off initial vowel sounds.
3. **Punctuation Conventions:**
   - German uses quotation marks (`„...“`) and commas for subordinate clauses (*dass*, *weil*, *obwohl*). The sentence splitter must account for German quote pairs and avoid splitting inside quotations unless the segment length exceeds 8 seconds.
4. **Numbers & Dates:**
   - Spoken German numbers are inverted (*einundzwanzig* = 21). Whisper's German model might output digits or words; transcript editing must allow easy learner correction.

---

## 6. Out of Scope for MVP

The following items are deferred to post-MVP iterations:
- Cloud synchronization and multi-device accounts.
- Automated pronunciation scoring / phonetic alignment (e.g. via CTC forced alignment or Kaldi/MFA).
- Mobile application builds (iOS / Android packages).
- Video playback sync (video is ingested, but only audio is shadowed in MVP).
- Anki / SRS flashcard export integrations.

---

## 7. Cloud Demo Limitations & Deployment Notice

An optional zero-cost cloud demonstration target is provided to allow previewing Deutsch Shadow in the browser without local environment setup. When running on free-tier cloud hosting (e.g., Render free web service), the following operational constraints apply:

1. **Temporary Ephemeral Storage:**
   - The cloud demo runs on an ephemeral container filesystem.
   - Uploaded media files, generated transcripts, customized segment boundaries, and practice vocal recordings are stored temporarily in `/app/data`.
   - Data may be lost whenever the hosting service spins down due to inactivity, restarts, or is redeployed.
   - The demo is not suitable for permanent storage, long-term learning records, or archiving user recordings. Keep original media files and important recordings stored safely elsewhere.

2. **Inactivity Spin-Down & Cold Starts:**
   - Free cloud instances automatically spin down after a period of inactivity (e.g., 15 minutes of idle time on Render).
   - Cold-start requests after a spin-down may require 30–60 seconds while the container initializes and boots Uvicorn.

3. **Constrained Resource Profile:**
   - Speech recognition is strictly constrained to the lightweight `tiny` Whisper model with 1 CPU thread and `int8` quantization to ensure reliable execution within the 512 MB memory boundary.
   - Audio imports are capped at 25 MiB payload size and 180 seconds maximum duration.
   - Transcription concurrency is strictly limited to one active pipeline at a time; concurrent import attempts receive HTTP 429.

4. **Local Desktop Version as Authoritative Platform:**
   - The native desktop version (Windows, macOS, Linux) remains the authoritative and recommended deployment for persistent personal language learning.
   - The local desktop version provides permanent SQLite and filesystem storage, complete offline privacy, full Whisper model tier selection (`tiny`, `base`, `small`, `medium`), and zero upload or duration restrictions.

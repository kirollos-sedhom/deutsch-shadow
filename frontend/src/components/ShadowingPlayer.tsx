import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ArrowLeft,
  Play,
  Pause,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Gauge,
  Pencil,
  SlidersHorizontal,
  Check,
  X,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { SegmentRead, getMasterAudioUrl, updateSegment } from '../api/client';
import { formatMs } from '../utils/formatters';

export interface ShadowingPlayerProps {
  projectId: string;
  projectTitle: string;
  segments: SegmentRead[];
  projectDurationSeconds?: number;
  initialSegmentIndex?: number;
  defaultBlindMode?: boolean;
  onExit: (lastSegmentIndex: number) => void;
  onSegmentUpdate?: (updatedSegment: SegmentRead) => void;
}

const SPEED_PRESETS = [0.75, 0.85, 1.0, 1.15, 1.25];
const MIN_CLIP_DURATION_MS = 100;

export const ShadowingPlayer: React.FC<ShadowingPlayerProps> = ({
  projectId,
  projectTitle,
  segments: initialSegments,
  projectDurationSeconds,
  initialSegmentIndex = 0,
  defaultBlindMode = true,
  onExit,
  onSegmentUpdate,
}) => {
  // Local segments state to reflect in-place updates immediately
  const [segments, setSegments] = useState<SegmentRead[]>(initialSegments);

  useEffect(() => {
    setSegments(initialSegments);
  }, [initialSegments]);

  // Clamp initial index
  const safeInitialIndex = Math.max(
    0,
    Math.min(initialSegmentIndex, Math.max(0, segments.length - 1))
  );

  const [currentIndex, setCurrentIndex] = useState(safeInitialIndex);

  // Synchronize currentIndex if initialSegmentIndex changes
  useEffect(() => {
    const clamped = Math.max(
      0,
      Math.min(initialSegmentIndex, Math.max(0, segments.length - 1))
    );
    setCurrentIndex(clamped);
  }, [initialSegmentIndex, segments.length]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [isMasked, setIsMasked] = useState(defaultBlindMode);

  // Transcript Editing State
  const [isEditingText, setIsEditingText] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [isSavingText, setIsSavingText] = useState(false);
  const [textEditError, setTextEditError] = useState<string | null>(null);

  // Boundary Adjustment State
  const [isAdjustingBounds, setIsAdjustingBounds] = useState(false);
  const [draftStartMs, setDraftStartMs] = useState(0);
  const [draftEndMs, setDraftEndMs] = useState(0);
  const [isSavingBounds, setIsSavingBounds] = useState(false);
  const [boundsError, setBoundsError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const playbackSpeedRef = useRef(playbackSpeed);
  const isPlayingRef = useRef(isPlaying);
  const currentIndexRef = useRef(currentIndex);

  // Sync refs
  useEffect(() => {
    playbackSpeedRef.current = playbackSpeed;
  }, [playbackSpeed]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  const currentSegment = segments[currentIndex] || null;

  // Synchronize draft states when currentIndex or currentSegment changes
  useEffect(() => {
    if (currentSegment) {
      setDraftText(currentSegment.text);
      setDraftStartMs(currentSegment.start_time_ms);
      setDraftEndMs(currentSegment.end_time_ms);
      setTextEditError(null);
      setBoundsError(null);
    }
  }, [currentIndex, currentSegment?.id]);

  // Calculate neighbor boundary limits
  const prevSegment = currentIndex > 0 ? segments[currentIndex - 1] : null;
  const nextSegment = currentIndex < segments.length - 1 ? segments[currentIndex + 1] : null;

  const minStartFloor = prevSegment ? prevSegment.end_time_ms : 0;
  const maxEndCeiling = nextSegment
    ? nextSegment.start_time_ms
    : projectDurationSeconds && projectDurationSeconds > 0
    ? Math.ceil(projectDurationSeconds * 1000)
    : Infinity;

  // Active target boundaries (draft boundaries if adjusting, persisted boundaries otherwise)
  const activeStartMs = isAdjustingBounds ? draftStartMs : currentSegment?.start_time_ms || 0;
  const activeEndMs = isAdjustingBounds ? draftEndMs : currentSegment?.end_time_ms || 0;

  // Helper to cancel any pending stop timer
  const clearStopTimer = useCallback(() => {
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  }, []);

  // Stop playback at boundary or manual halt
  const stopPlaybackAtBoundary = useCallback(
    (endTimeSec?: number) => {
      clearStopTimer();
      if (audioRef.current) {
        audioRef.current.pause();
        if (endTimeSec !== undefined) {
          audioRef.current.currentTime = endTimeSec;
        }
      }
      setIsPlaying(false);
    },
    [clearStopTimer]
  );

  // Stop timer scheduler accounting for playbackRate
  const scheduleStopTimer = useCallback(
    (endTimeSec: number) => {
      clearStopTimer();
      if (!audioRef.current) return;
      const speed = playbackSpeedRef.current || 1.0;
      const remainingSec = Math.max(0, endTimeSec - audioRef.current.currentTime);
      const remainingWallMs = Math.max(20, (remainingSec * 1000) / speed);

      stopTimerRef.current = window.setTimeout(() => {
        stopPlaybackAtBoundary(endTimeSec);
      }, remainingWallMs);
    },
    [clearStopTimer, stopPlaybackAtBoundary]
  );

  // Play / Pause / Resume
  const handlePlayPause = useCallback(() => {
    if (!audioRef.current || !currentSegment) return;
    const audio = audioRef.current;
    const startTimeSec = activeStartMs / 1000;
    const endTimeSec = activeEndMs / 1000;

    // Case 1: If currently playing -> PAUSE at current position
    if (isPlayingRef.current) {
      clearStopTimer();
      audio.pause();
      setIsPlaying(false);
      return;
    }

    // Case 2: Resume or Start
    clearStopTimer();
    let targetTime = startTimeSec;

    // If currentTime is already within the active segment boundaries, resume from position
    if (audio.currentTime >= startTimeSec && audio.currentTime < endTimeSec) {
      targetTime = audio.currentTime;
    }

    audio.currentTime = targetTime;
    audio.playbackRate = playbackSpeedRef.current;

    audio
      .play()
      .then(() => {
        setIsPlaying(true);
        scheduleStopTimer(endTimeSec);
      })
      .catch((err) => {
        console.error('Audio playback error:', err);
      });
  }, [activeStartMs, activeEndMs, clearStopTimer, currentSegment, scheduleStopTimer]);

  // Replay from segment start
  const handleReplay = useCallback(() => {
    if (!audioRef.current || !currentSegment) return;
    const audio = audioRef.current;
    const startTimeSec = activeStartMs / 1000;
    const endTimeSec = activeEndMs / 1000;

    clearStopTimer();
    audio.currentTime = startTimeSec;
    audio.playbackRate = playbackSpeedRef.current;

    audio
      .play()
      .then(() => {
        setIsPlaying(true);
        scheduleStopTimer(endTimeSec);
      })
      .catch((err) => {
        console.error('Audio replay error:', err);
      });
  }, [activeStartMs, activeEndMs, clearStopTimer, currentSegment, scheduleStopTimer]);

  // Preview draft boundaries directly
  const handlePreviewDraft = useCallback(() => {
    if (!audioRef.current) return;
    const audio = audioRef.current;
    const startTimeSec = draftStartMs / 1000;
    const endTimeSec = draftEndMs / 1000;

    clearStopTimer();
    audio.currentTime = startTimeSec;
    audio.playbackRate = playbackSpeedRef.current;

    audio
      .play()
      .then(() => {
        setIsPlaying(true);
        scheduleStopTimer(endTimeSec);
      })
      .catch((err) => {
        console.error('Preview playback error:', err);
      });
  }, [clearStopTimer, draftStartMs, draftEndMs, scheduleStopTimer]);

  // Navigate to previous clip
  const handlePreviousClip = useCallback(() => {
    if (currentIndex <= 0) return;
    clearStopTimer();
    const prevIndex = currentIndex - 1;
    const prevSeg = segments[prevIndex];

    if (audioRef.current && prevSeg) {
      audioRef.current.pause();
      audioRef.current.currentTime = prevSeg.start_time_ms / 1000;
    }
    setIsPlaying(false);
    setIsEditingText(false);
    setIsAdjustingBounds(false);
    setCurrentIndex(prevIndex);
    setIsMasked(defaultBlindMode);
  }, [clearStopTimer, currentIndex, defaultBlindMode, segments]);

  // Navigate to next clip
  const handleNextClip = useCallback(() => {
    if (currentIndex >= segments.length - 1) return;
    clearStopTimer();
    const nextIndex = currentIndex + 1;
    const nextSeg = segments[nextIndex];

    if (audioRef.current && nextSeg) {
      audioRef.current.pause();
      audioRef.current.currentTime = nextSeg.start_time_ms / 1000;
    }
    setIsPlaying(false);
    setIsEditingText(false);
    setIsAdjustingBounds(false);
    setCurrentIndex(nextIndex);
    setIsMasked(defaultBlindMode);
  }, [clearStopTimer, currentIndex, defaultBlindMode, segments]);

  // Change playback speed
  const handleSpeedChange = useCallback(
    (speed: number) => {
      setPlaybackSpeed(speed);
      playbackSpeedRef.current = speed;

      if (audioRef.current) {
        audioRef.current.playbackRate = speed;
        // If actively playing, reschedule the boundary timer with the updated speed
        if (isPlayingRef.current) {
          scheduleStopTimer(activeEndMs / 1000);
        }
      }
    },
    [activeEndMs, scheduleStopTimer]
  );

  // Audio event listeners
  const handleTimeUpdate = () => {
    if (!audioRef.current || !currentSegment) return;
    const current = audioRef.current.currentTime;
    const endTimeSec = activeEndMs / 1000;
    if (current >= endTimeSec) {
      stopPlaybackAtBoundary(endTimeSec);
    }
  };

  const handleAudioPause = () => {
    clearStopTimer();
    setIsPlaying(false);
  };

  const handleAudioPlay = () => {
    setIsPlaying(true);
  };

  const handleAudioEnded = () => {
    stopPlaybackAtBoundary(activeEndMs / 1000);
  };

  // Transcript Editing Handlers
  const handleStartTextEdit = () => {
    if (!currentSegment) return;
    setDraftText(currentSegment.text);
    setTextEditError(null);
    setIsEditingText(true);
  };

  const handleCancelTextEdit = () => {
    if (!currentSegment) return;
    setDraftText(currentSegment.text);
    setTextEditError(null);
    setIsEditingText(false);
  };

  const handleSaveTextEdit = async () => {
    if (!currentSegment) return;
    const trimmed = draftText.trim();
    if (!trimmed) {
      setTextEditError('Transcript text cannot be empty or whitespace only.');
      return;
    }

    setIsSavingText(true);
    setTextEditError(null);

    try {
      const updated = await updateSegment(currentSegment.id, { text: trimmed });
      // Update local segment array atomically
      setSegments((prev) =>
        prev.map((s) => (s.id === updated.id ? updated : s))
      );
      onSegmentUpdate?.(updated);
      setIsEditingText(false);
    } catch (err: unknown) {
      setTextEditError(err instanceof Error ? err.message : 'Failed to save transcript');
    } finally {
      setIsSavingText(false);
    }
  };

  // Boundary Adjustment Handlers
  const nudgeStart = (deltaMs: number) => {
    setBoundsError(null);
    setDraftStartMs((prev) => {
      const target = prev + deltaMs;
      // Clamp between minStartFloor and draftEndMs - MIN_CLIP_DURATION_MS
      const maxAllowed = draftEndMs - MIN_CLIP_DURATION_MS;
      return Math.max(minStartFloor, Math.min(maxAllowed, target));
    });
  };

  const nudgeEnd = (deltaMs: number) => {
    setBoundsError(null);
    setDraftEndMs((prev) => {
      const target = prev + deltaMs;
      // Clamp between draftStartMs + MIN_CLIP_DURATION_MS and maxEndCeiling
      const minAllowed = draftStartMs + MIN_CLIP_DURATION_MS;
      return Math.max(minAllowed, Math.min(maxEndCeiling, target));
    });
  };

  const handleResetBounds = () => {
    if (!currentSegment) return;
    setDraftStartMs(currentSegment.start_time_ms);
    setDraftEndMs(currentSegment.end_time_ms);
    setBoundsError(null);
    // If playing, reset audio position to saved start
    if (audioRef.current) {
      audioRef.current.currentTime = currentSegment.start_time_ms / 1000;
    }
  };

  const handleSaveBounds = async () => {
    if (!currentSegment) return;
    if (draftEndMs - draftStartMs < MIN_CLIP_DURATION_MS) {
      setBoundsError(`Duration must be at least ${MIN_CLIP_DURATION_MS}ms.`);
      return;
    }

    setIsSavingBounds(true);
    setBoundsError(null);

    try {
      // Stop playback if running so it cannot continue with stale timings
      if (isPlayingRef.current) {
        stopPlaybackAtBoundary(draftEndMs / 1000);
      }

      const updated = await updateSegment(currentSegment.id, {
        start_time_ms: draftStartMs,
        end_time_ms: draftEndMs,
      });

      // Update local segment array atomically
      setSegments((prev) =>
        prev.map((s) => (s.id === updated.id ? updated : s))
      );
      onSegmentUpdate?.(updated);

      if (audioRef.current) {
        audioRef.current.currentTime = updated.start_time_ms / 1000;
      }
    } catch (err: unknown) {
      setBoundsError(err instanceof Error ? err.message : 'Failed to save boundary adjustments');
    } finally {
      setIsSavingBounds(false);
    }
  };

  // Keyboard shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is inside form fields
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        handlePlayPause();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        handleReplay();
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        setIsMasked((prev) => !prev);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePreviousClip();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNextClip();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onExit(currentIndexRef.current);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    handlePlayPause,
    handleReplay,
    handlePreviousClip,
    handleNextClip,
    onExit,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearStopTimer();
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, [clearStopTimer]);

  if (!currentSegment || segments.length === 0) {
    return (
      <div className="empty-state">
        <h3 className="empty-state-title">No Clips Available</h3>
        <button
          className="btn btn-secondary"
          onClick={() => onExit(0)}
          style={{ marginTop: '16px' }}
        >
          <ArrowLeft size={16} />
          <span>Back to Overview</span>
        </button>
      </div>
    );
  }

  const isFirstClip = currentIndex === 0;
  const isLastClip = currentIndex === segments.length - 1;
  const progressPercent = ((currentIndex + 1) / segments.length) * 100;
  const isBoundsModified =
    draftStartMs !== currentSegment.start_time_ms ||
    draftEndMs !== currentSegment.end_time_ms;

  return (
    <div className="shadowing-player-container" data-testid="shadowing-player">
      {/* Persistent HTML5 Audio element */}
      <audio
        ref={audioRef}
        src={getMasterAudioUrl(projectId)}
        preload="auto"
        onTimeUpdate={handleTimeUpdate}
        onPlay={handleAudioPlay}
        onPause={handleAudioPause}
        onEnded={handleAudioEnded}
      />

      {/* Top Navigation & Status Bar */}
      <header className="player-header">
        <button
          className="player-back-btn"
          onClick={() => onExit(currentIndex)}
          aria-label="Back to project overview"
        >
          <ArrowLeft size={16} />
          <span>Overview</span>
        </button>

        <div className="player-header-title">
          <span className="player-project-name" title={projectTitle}>
            {projectTitle}
          </span>
          <span className="player-counter-badge" aria-label={`Clip ${currentIndex + 1} of ${segments.length}`}>
            Clip {currentIndex + 1} / {segments.length}
          </span>
        </div>
      </header>

      {/* Project Clip Progress Bar */}
      <div className="player-progress-track" role="progressbar" aria-valuenow={currentIndex + 1} aria-valuemin={1} aria-valuemax={segments.length}>
        <div
          className="player-progress-fill"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Center Stage: Focused Clip Card */}
      <main className="player-stage">
        <div className="player-clip-card">
          {/* Timing & Duration Header */}
          <div className="player-clip-meta">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span className="player-timing-badge">
                {formatMs(isAdjustingBounds ? draftStartMs : currentSegment.start_time_ms)} →{' '}
                {formatMs(isAdjustingBounds ? draftEndMs : currentSegment.end_time_ms)}
              </span>
              {currentSegment.is_edited && (
                <span className="player-edited-tag" title="Transcript or boundaries manually edited">
                  Edited
                </span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="player-duration-badge">
                {(
                  ((isAdjustingBounds ? draftEndMs - draftStartMs : currentSegment.duration_ms) /
                    1000)
                ).toFixed(2)}s
              </span>
              <button
                className={`player-bounds-toggle-btn ${isAdjustingBounds ? 'active' : ''}`}
                onClick={() => setIsAdjustingBounds((prev) => !prev)}
                aria-label="Toggle boundary adjustment drawer"
                title="Adjust clip start and end boundaries"
              >
                <SlidersHorizontal size={13} />
                <span>Adjust</span>
              </button>
            </div>
          </div>

          {/* Boundary Adjustment Drawer */}
          {isAdjustingBounds && (
            <div className="player-bounds-drawer" data-testid="bounds-drawer">
              {/* Start Boundary Nudges */}
              <div className="player-bounds-row">
                <div className="player-bounds-label-group">
                  <span className="player-bounds-label">Start:</span>
                  <span className="player-bounds-value">{formatMs(draftStartMs)}</span>
                </div>
                <div className="player-nudge-group">
                  <button
                    className="player-nudge-btn"
                    onClick={() => nudgeStart(-100)}
                    disabled={draftStartMs - 100 < minStartFloor}
                    aria-label="Nudge start back 100ms"
                  >
                    -100ms
                  </button>
                  <button
                    className="player-nudge-btn"
                    onClick={() => nudgeStart(-25)}
                    disabled={draftStartMs - 25 < minStartFloor}
                    aria-label="Nudge start back 25ms"
                  >
                    -25ms
                  </button>
                  <button
                    className="player-nudge-btn"
                    onClick={() => nudgeStart(25)}
                    disabled={draftStartMs + 25 > draftEndMs - MIN_CLIP_DURATION_MS}
                    aria-label="Nudge start forward 25ms"
                  >
                    +25ms
                  </button>
                  <button
                    className="player-nudge-btn"
                    onClick={() => nudgeStart(100)}
                    disabled={draftStartMs + 100 > draftEndMs - MIN_CLIP_DURATION_MS}
                    aria-label="Nudge start forward 100ms"
                  >
                    +100ms
                  </button>
                </div>
              </div>

              {/* End Boundary Nudges */}
              <div className="player-bounds-row">
                <div className="player-bounds-label-group">
                  <span className="player-bounds-label">End:</span>
                  <span className="player-bounds-value">{formatMs(draftEndMs)}</span>
                </div>
                <div className="player-nudge-group">
                  <button
                    className="player-nudge-btn"
                    onClick={() => nudgeEnd(-100)}
                    disabled={draftEndMs - 100 < draftStartMs + MIN_CLIP_DURATION_MS}
                    aria-label="Nudge end back 100ms"
                  >
                    -100ms
                  </button>
                  <button
                    className="player-nudge-btn"
                    onClick={() => nudgeEnd(-25)}
                    disabled={draftEndMs - 25 < draftStartMs + MIN_CLIP_DURATION_MS}
                    aria-label="Nudge end back 25ms"
                  >
                    -25ms
                  </button>
                  <button
                    className="player-nudge-btn"
                    onClick={() => nudgeEnd(25)}
                    disabled={draftEndMs + 25 > maxEndCeiling}
                    aria-label="Nudge end forward 25ms"
                  >
                    +25ms
                  </button>
                  <button
                    className="player-nudge-btn"
                    onClick={() => nudgeEnd(100)}
                    disabled={draftEndMs + 100 > maxEndCeiling}
                    aria-label="Nudge end forward 100ms"
                  >
                    +100ms
                  </button>
                </div>
              </div>

              {/* Error banner if save fails */}
              {boundsError && (
                <div className="player-edit-error" role="alert">
                  <AlertCircle size={14} />
                  <span>{boundsError}</span>
                </div>
              )}

              {/* Boundary Actions Row */}
              <div className="player-bounds-bottom-row">
                <span className="player-bounds-duration">
                  Duration: {((draftEndMs - draftStartMs) / 1000).toFixed(2)}s
                </span>
                <div className="player-bounds-actions">
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handlePreviewDraft}
                    aria-label="Preview draft boundaries"
                    title="Play clip using draft boundaries"
                  >
                    <Play size={12} />
                    <span>Preview</span>
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleResetBounds}
                    disabled={!isBoundsModified || isSavingBounds}
                    aria-label="Reset boundaries to saved values"
                  >
                    <RotateCcw size={12} />
                    <span>Reset</span>
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleSaveBounds}
                    disabled={!isBoundsModified || isSavingBounds}
                    aria-label="Save boundaries"
                  >
                    {isSavingBounds ? <Loader2 size={12} className="spin" /> : <Check size={12} />}
                    <span>Save Bounds</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Transcript Display or Inline Edit Form */}
          {isEditingText ? (
            <div className="player-edit-form" data-testid="transcript-edit-form">
              <textarea
                className="player-edit-textarea"
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                placeholder="German transcript text..."
                rows={3}
                autoFocus
                aria-label="Edit German transcript"
              />

              {textEditError && (
                <div className="player-edit-error" role="alert">
                  <AlertCircle size={14} />
                  <span>{textEditError}</span>
                </div>
              )}

              <div className="player-edit-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleCancelTextEdit}
                  disabled={isSavingText}
                  aria-label="Cancel editing"
                >
                  <X size={13} />
                  <span>Cancel</span>
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleSaveTextEdit}
                  disabled={isSavingText || !draftText.trim()}
                  aria-label="Save transcript"
                >
                  {isSavingText ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
                  <span>Save Text</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Masked / Revealed Transcript Display */}
              <div className="player-transcript-wrapper">
                <div
                  className={`player-transcript-box ${isMasked ? 'masked' : 'revealed'}`}
                  onClick={() => setIsMasked(!isMasked)}
                  tabIndex={0}
                  role="button"
                  aria-label={
                    isMasked
                      ? 'Masked German transcript. Tap to reveal.'
                      : 'German transcript. Tap to mask.'
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setIsMasked(!isMasked);
                    }
                  }}
                >
                  <p className="player-transcript-text">{currentSegment.text}</p>
                </div>
                {isMasked && (
                  <div className="player-mask-hint">Tap text or Reveal button to unmask [T]</div>
                )}
              </div>

              {/* Reveal / Hide & Edit Actions */}
              <div className="player-reveal-row" style={{ gap: '10px' }}>
                <button
                  className="btn btn-secondary btn-sm player-reveal-btn"
                  onClick={() => setIsMasked(!isMasked)}
                  aria-label={isMasked ? 'Reveal transcript' : 'Hide transcript'}
                >
                  {isMasked ? <Eye size={15} /> : <EyeOff size={15} />}
                  <span>{isMasked ? 'Reveal Transcript' : 'Hide Transcript'}</span>
                </button>

                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleStartTextEdit}
                  aria-label="Edit transcript text"
                  title="Correct transcription text"
                  style={{ minHeight: 'var(--touch-target-min)', padding: '8px 14px' }}
                >
                  <Pencil size={14} />
                  <span>Edit Text</span>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Playback Speed Controls */}
        <section className="player-speed-section" aria-label="Playback speed selection">
          <div className="player-speed-label">
            <Gauge size={14} />
            <span>Speed:</span>
          </div>
          <div className="player-speed-group" role="radiogroup" aria-label="Playback speed">
            {SPEED_PRESETS.map((speed) => {
              const isSelected = playbackSpeed === speed;
              return (
                <button
                  key={speed}
                  className={`player-speed-btn ${isSelected ? 'active' : ''}`}
                  onClick={() => handleSpeedChange(speed)}
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={`${speed} times playback speed`}
                >
                  {speed}x
                </button>
              );
            })}
          </div>
        </section>

        {/* Primary Controls Row: Previous, Play/Pause, Replay, Next */}
        <section className="player-controls-section" aria-label="Audio controls">
          <button
            className="player-nav-btn"
            onClick={handlePreviousClip}
            disabled={isFirstClip}
            aria-label="Previous clip"
            title="Previous clip (Left arrow)"
          >
            <ChevronLeft size={22} />
            <span className="player-btn-label">Prev</span>
          </button>

          <button
            className="player-main-play-btn"
            onClick={handlePlayPause}
            aria-label={isPlaying ? 'Pause clip' : 'Play clip'}
            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          >
            {isPlaying ? <Pause size={28} /> : <Play size={28} style={{ marginLeft: '3px' }} />}
          </button>

          <button
            className="player-replay-btn"
            onClick={handleReplay}
            aria-label="Replay clip from start"
            title="Replay from start (R)"
          >
            <RotateCcw size={20} />
            <span className="player-btn-label">Replay</span>
          </button>

          <button
            className="player-nav-btn"
            onClick={handleNextClip}
            disabled={isLastClip}
            aria-label="Next clip"
            title="Next clip (Right arrow)"
          >
            <span className="player-btn-label">Next</span>
            <ChevronRight size={22} />
          </button>
        </section>
      </main>

      {/* Desktop Keyboard Shortcuts Legend */}
      <footer className="player-shortcuts-footer" aria-label="Keyboard shortcuts legend">
        <span className="shortcut-item">
          <kbd>Space</kbd> Play/Pause
        </span>
        <span className="shortcut-item">
          <kbd>R</kbd> Replay
        </span>
        <span className="shortcut-item">
          <kbd>T</kbd> Reveal
        </span>
        <span className="shortcut-item">
          <kbd>←</kbd> / <kbd>→</kbd> Prev/Next
        </span>
        <span className="shortcut-item">
          <kbd>Esc</kbd> Exit
        </span>
      </footer>
    </div>
  );
};

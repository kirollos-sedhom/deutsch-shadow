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
} from 'lucide-react';
import { SegmentRead, getMasterAudioUrl } from '../api/client';
import { formatMs } from '../utils/formatters';

export interface ShadowingPlayerProps {
  projectId: string;
  projectTitle: string;
  segments: SegmentRead[];
  initialSegmentIndex?: number;
  defaultBlindMode?: boolean;
  onExit: (lastSegmentIndex: number) => void;
}

const SPEED_PRESETS = [0.75, 0.85, 1.0, 1.15, 1.25];

export const ShadowingPlayer: React.FC<ShadowingPlayerProps> = ({
  projectId,
  projectTitle,
  segments,
  initialSegmentIndex = 0,
  defaultBlindMode = true,
  onExit,
}) => {
  // Clamp initial index
  const safeInitialIndex = Math.max(
    0,
    Math.min(initialSegmentIndex, Math.max(0, segments.length - 1))
  );

  const [currentIndex, setCurrentIndex] = useState(safeInitialIndex);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [isMasked, setIsMasked] = useState(defaultBlindMode);

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
    const startTimeSec = currentSegment.start_time_ms / 1000;
    const endTimeSec = currentSegment.end_time_ms / 1000;

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
  }, [clearStopTimer, currentSegment, scheduleStopTimer]);

  // Replay from segment start
  const handleReplay = useCallback(() => {
    if (!audioRef.current || !currentSegment) return;
    const audio = audioRef.current;
    const startTimeSec = currentSegment.start_time_ms / 1000;
    const endTimeSec = currentSegment.end_time_ms / 1000;

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
  }, [clearStopTimer, currentSegment, scheduleStopTimer]);

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
        if (isPlayingRef.current && currentSegment) {
          scheduleStopTimer(currentSegment.end_time_ms / 1000);
        }
      }
    },
    [currentSegment, scheduleStopTimer]
  );

  // Audio event listeners
  const handleTimeUpdate = () => {
    if (!audioRef.current || !currentSegment) return;
    const current = audioRef.current.currentTime;
    const endTimeSec = currentSegment.end_time_ms / 1000;
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
    if (currentSegment) {
      stopPlaybackAtBoundary(currentSegment.end_time_ms / 1000);
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
            <span className="player-timing-badge">
              {formatMs(currentSegment.start_time_ms)} → {formatMs(currentSegment.end_time_ms)}
            </span>
            <span className="player-duration-badge">
              {(currentSegment.duration_ms / 1000).toFixed(2)}s
            </span>
          </div>

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

          {/* Reveal / Hide Toggle Action */}
          <div className="player-reveal-row">
            <button
              className="btn btn-secondary btn-sm player-reveal-btn"
              onClick={() => setIsMasked(!isMasked)}
              aria-label={isMasked ? 'Reveal transcript' : 'Hide transcript'}
            >
              {isMasked ? <Eye size={15} /> : <EyeOff size={15} />}
              <span>{isMasked ? 'Reveal Transcript' : 'Hide Transcript'}</span>
            </button>
          </div>
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

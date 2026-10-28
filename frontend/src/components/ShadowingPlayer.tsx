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
  Repeat,
  GitCompare,
  Volume2,
} from 'lucide-react';
import {
  SegmentRead,
  RecordingRead,
  getMasterAudioUrl,
  getRecordingAudioUrl,
  updateSegment,
} from '../api/client';
import { formatMs } from '../utils/formatters';
import { RecordingStudio, RecordingStudioHandle } from './RecordingStudio';

export interface ShadowingPlayerProps {
  projectId: string;
  projectTitle: string;
  segments: SegmentRead[];
  projectDurationSeconds?: number;
  initialSegmentIndex?: number;
  defaultBlindMode?: boolean;
  initialAutoPauseMultiplier?: number;
  onExit: (lastSegmentIndex: number) => void;
  onSegmentUpdate?: (updatedSegment: SegmentRead) => void;
}

const SPEED_PRESETS = [0.75, 0.85, 1.0, 1.15, 1.25];
const MULTIPLIER_PRESETS = [1.0, 1.2, 1.5, 2.0];
const MIN_CLIP_DURATION_MS = 100;

export const PAUSE_MULTIPLIER_STORAGE_KEY = 'deutsch_shadow_pause_multiplier';
export const LOOP_MODE_STORAGE_KEY = 'deutsch_shadow_loop_mode';

export interface CountdownState {
  isActive: boolean;
  totalMs: number;
  remainingMs: number;
  isPaused: boolean;
}

export type ComparisonPhase = 'idle' | 'original' | 'gap' | 'take';

export interface ComparisonState {
  isActive: boolean;
  phase: ComparisonPhase;
  error: string | null;
}

export const ShadowingPlayer: React.FC<ShadowingPlayerProps> = ({
  projectId,
  projectTitle,
  segments: initialSegments,
  projectDurationSeconds,
  initialSegmentIndex = 0,
  defaultBlindMode = true,
  initialAutoPauseMultiplier = 1.2,
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

  // Auto-Pause Loop & Multiplier State
  const [isLoopMode, setIsLoopMode] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(LOOP_MODE_STORAGE_KEY);
      return saved !== null ? saved === 'true' : false;
    } catch {
      return false;
    }
  });

  const [pauseMultiplier, setPauseMultiplier] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(PAUSE_MULTIPLIER_STORAGE_KEY);
      if (saved !== null) {
        const parsed = parseFloat(saved);
        if (MULTIPLIER_PRESETS.includes(parsed)) return parsed;
      }
    } catch {
      // ignore
    }
    return initialAutoPauseMultiplier;
  });

  const [countdownState, setCountdownState] = useState<CountdownState>({
    isActive: false,
    totalMs: 0,
    remainingMs: 0,
    isPaused: false,
  });

  // Milestone 8 Phase 2: One-Click Comparison Player State & Refs
  const [comparisonState, setComparisonState] = useState<ComparisonState>({
    isActive: false,
    phase: 'idle',
    error: null,
  });
  const [activeTake, setActiveTake] = useState<RecordingRead | null>(null);
  const [isTakesLoading, setIsTakesLoading] = useState(false);

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

  // Vocal Recording Studio State & Ref
  const recordingStudioRef = useRef<RecordingStudioHandle | null>(null);
  const [recordingBusyState, setRecordingBusyState] = useState({
    isBusy: false,
    isUploading: false,
    isReviewPending: false,
  });
  const [pendingNavAction, setPendingNavAction] = useState<'prev' | 'next' | 'exit' | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const playbackSpeedRef = useRef(playbackSpeed);
  const isPlayingRef = useRef(isPlaying);
  const currentIndexRef = useRef(currentIndex);

  // Countdown refs for monotonic clock & accuracy
  const isLoopModeRef = useRef(isLoopMode);
  const pauseMultiplierRef = useRef(pauseMultiplier);
  const countdownStateRef = useRef(countdownState);
  const countdownDeadlineRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const countdownTotalMsRef = useRef<number>(0);
  const countdownRemainingMsRef = useRef<number>(0);

  // Comparison Player refs
  const comparisonStateRef = useRef<ComparisonState>(comparisonState);
  const activeTakeRef = useRef<RecordingRead | null>(null);
  const isTakesLoadingRef = useRef(false);
  const comparisonGapTimerRef = useRef<number | null>(null);
  const comparisonRequestIdRef = useRef<number>(0);
  const comparisonAudioRef = useRef<HTMLAudioElement | null>(null);

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

  useEffect(() => {
    isLoopModeRef.current = isLoopMode;
  }, [isLoopMode]);

  useEffect(() => {
    pauseMultiplierRef.current = pauseMultiplier;
  }, [pauseMultiplier]);

  useEffect(() => {
    countdownStateRef.current = countdownState;
  }, [countdownState]);

  useEffect(() => {
    comparisonStateRef.current = comparisonState;
  }, [comparisonState]);

  useEffect(() => {
    activeTakeRef.current = activeTake;
  }, [activeTake]);

  useEffect(() => {
    isTakesLoadingRef.current = isTakesLoading;
  }, [isTakesLoading]);

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

  const playRequestIdRef = useRef(0);

  // Helper to cancel any pending stop timer
  const clearStopTimer = useCallback(() => {
    playRequestIdRef.current++;
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  }, []);

  // Countdown timer helpers
  const clearCountdownTimer = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  const cancelCountdown = useCallback(() => {
    clearCountdownTimer();
    countdownDeadlineRef.current = null;
    countdownRemainingMsRef.current = 0;
    countdownTotalMsRef.current = 0;
    const nextState: CountdownState = {
      isActive: false,
      totalMs: 0,
      remainingMs: 0,
      isPaused: false,
    };
    countdownStateRef.current = nextState;
    setCountdownState(nextState);
  }, [clearCountdownTimer]);

  // One-Click Comparison Player Helpers
  const cancelComparison = useCallback((stopMasterAudio: boolean = false) => {
    comparisonRequestIdRef.current++;
    if (comparisonGapTimerRef.current !== null) {
      window.clearTimeout(comparisonGapTimerRef.current);
      comparisonGapTimerRef.current = null;
    }
    if (comparisonAudioRef.current) {
      comparisonAudioRef.current.pause();
    }
    if (stopMasterAudio && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      isPlayingRef.current = false;
      setIsPlaying(false);
    }
    const next: ComparisonState = {
      isActive: false,
      phase: 'idle',
      error: null,
    };
    comparisonStateRef.current = next;
    setComparisonState(next);
  }, []);

  const handleComparisonGapToPhaseB = useCallback(() => {
    const currentRequestId = comparisonRequestIdRef.current;
    const take = activeTakeRef.current;

    if (!take) {
      cancelComparison(false);
      return;
    }

    const next: ComparisonState = {
      isActive: true,
      phase: 'take',
      error: null,
    };
    comparisonStateRef.current = next;
    setComparisonState(next);

    if (!comparisonAudioRef.current) return;
    const compAudio = comparisonAudioRef.current;
    compAudio.src = getRecordingAudioUrl(take.id);
    compAudio.playbackRate = 1.0;

    compAudio
      .play()
      .then(() => {
        if (comparisonRequestIdRef.current !== currentRequestId) {
          compAudio.pause();
        }
      })
      .catch((err) => {
        if (comparisonRequestIdRef.current !== currentRequestId) return;
        console.error('Comparison Phase B playback error:', err);
        cancelComparison(false);
        setComparisonState({
          isActive: false,
          phase: 'idle',
          error: 'Unable to play recorded take. Audio file may be missing or unreadable.',
        });
      });
  }, [cancelComparison]);

  const handleComparisonPhaseAToGap = useCallback(() => {
    const currentRequestId = comparisonRequestIdRef.current;
    const next: ComparisonState = {
      isActive: true,
      phase: 'gap',
      error: null,
    };
    comparisonStateRef.current = next;
    setComparisonState(next);

    comparisonGapTimerRef.current = window.setTimeout(() => {
      if (comparisonRequestIdRef.current !== currentRequestId) return;
      handleComparisonGapToPhaseB();
    }, 250);
  }, [handleComparisonGapToPhaseB]);

  // Execute replay when countdown completes
  const executeCountdownFinished = useCallback(() => {
    clearCountdownTimer();
    countdownDeadlineRef.current = null;
    countdownRemainingMsRef.current = 0;
    countdownTotalMsRef.current = 0;
    const nextState: CountdownState = {
      isActive: false,
      totalMs: 0,
      remainingMs: 0,
      isPaused: false,
    };
    countdownStateRef.current = nextState;
    setCountdownState(nextState);

    // If loop mode is still enabled, start next playback cycle from activeStartMs
    if (isLoopModeRef.current) {
      if (!audioRef.current) return;
      const audio = audioRef.current;
      const startTimeSec = activeStartMs / 1000;
      const endTimeSec = activeEndMs / 1000;

      clearStopTimer();
      const currentRequestId = ++playRequestIdRef.current;
      audio.currentTime = startTimeSec;
      audio.playbackRate = playbackSpeedRef.current;

      audio
        .play()
        .then(() => {
          if (playRequestIdRef.current !== currentRequestId) return;
          isPlayingRef.current = true;
          setIsPlaying(true);
          scheduleStopTimer(endTimeSec);
        })
        .catch((err) => {
          if (playRequestIdRef.current !== currentRequestId) return;
          console.error('Auto-pause loop replay error:', err);
          isPlayingRef.current = false;
          setIsPlaying(false);
        });
    }
  }, [activeStartMs, activeEndMs, clearCountdownTimer, clearStopTimer]);

  // Monotonic countdown tick
  const tickCountdown = useCallback(() => {
    if (countdownDeadlineRef.current === null) return;
    const now = performance.now();
    const remaining = Math.max(0, countdownDeadlineRef.current - now);

    if (remaining <= 0) {
      executeCountdownFinished();
      return;
    }

    countdownRemainingMsRef.current = remaining;
    setCountdownState((prev) => {
      if (!prev.isActive || prev.isPaused) return prev;
      return {
        ...prev,
        remainingMs: remaining,
      };
    });
  }, [executeCountdownFinished]);

  const startCountdown = useCallback(
    (totalMs: number, initialRemainingMs?: number) => {
      clearCountdownTimer();
      const remaining = initialRemainingMs ?? totalMs;
      const now = performance.now();
      countdownDeadlineRef.current = now + remaining;
      countdownTotalMsRef.current = totalMs;
      countdownRemainingMsRef.current = remaining;

      const nextState: CountdownState = {
        isActive: true,
        totalMs,
        remainingMs: remaining,
        isPaused: false,
      };
      countdownStateRef.current = nextState;
      setCountdownState(nextState);

      countdownTimerRef.current = window.setInterval(tickCountdown, 50);
    },
    [clearCountdownTimer, tickCountdown]
  );

  const pauseCountdown = useCallback(() => {
    if (!countdownStateRef.current.isActive || countdownStateRef.current.isPaused) return;
    clearCountdownTimer();

    const now = performance.now();
    const remaining =
      countdownDeadlineRef.current !== null
        ? Math.max(0, countdownDeadlineRef.current - now)
        : countdownRemainingMsRef.current;

    countdownDeadlineRef.current = null;
    countdownRemainingMsRef.current = remaining;

    const nextState: CountdownState = {
      ...countdownStateRef.current,
      remainingMs: remaining,
      isPaused: true,
    };
    countdownStateRef.current = nextState;
    setCountdownState(nextState);
  }, [clearCountdownTimer]);

  const resumeCountdown = useCallback(() => {
    if (!countdownStateRef.current.isActive || !countdownStateRef.current.isPaused) return;
    const remaining = countdownRemainingMsRef.current;
    if (remaining <= 0) {
      executeCountdownFinished();
      return;
    }

    const now = performance.now();
    countdownDeadlineRef.current = now + remaining;

    const nextState: CountdownState = {
      ...countdownStateRef.current,
      isPaused: false,
    };
    countdownStateRef.current = nextState;
    setCountdownState(nextState);

    countdownTimerRef.current = window.setInterval(tickCountdown, 50);
  }, [clearCountdownTimer, executeCountdownFinished, tickCountdown]);

  const handleToggleLoop = useCallback(() => {
    cancelComparison(true);
    setIsLoopMode((prev) => {
      const next = !prev;
      isLoopModeRef.current = next;
      try {
        localStorage.setItem(LOOP_MODE_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }

      // If loop is disabled during a countdown: cancel countdown, clear timers,
      // and stop playback at current clip. Do NOT seek back to start.
      if (!next && countdownStateRef.current.isActive) {
        cancelCountdown();
      }
      // If loop is disabled during normal playback, allow current clip to finish
      // and stop at its end boundary without replaying.

      return next;
    });
  }, [cancelComparison, cancelCountdown]);

  const handleMultiplierChange = useCallback((newMultiplier: number) => {
    const oldMultiplier = pauseMultiplierRef.current || 1.2;
    setPauseMultiplier(newMultiplier);
    pauseMultiplierRef.current = newMultiplier;

    try {
      localStorage.setItem(PAUSE_MULTIPLIER_STORAGE_KEY, String(newMultiplier));
    } catch {
      // ignore
    }

    // If countdown is active, preserve remaining-time proportion:
    if (countdownStateRef.current.isActive && oldMultiplier > 0) {
      const now = performance.now();
      const currentRemaining =
        countdownDeadlineRef.current !== null
          ? Math.max(0, countdownDeadlineRef.current - now)
          : countdownRemainingMsRef.current;

      const multRatio = newMultiplier / oldMultiplier;
      const rescaledRemaining = Math.max(20, Math.round(currentRemaining * multRatio));
      const rescaledTotal = Math.max(
        rescaledRemaining,
        Math.round(countdownTotalMsRef.current * multRatio)
      );

      countdownTotalMsRef.current = rescaledTotal;
      countdownRemainingMsRef.current = rescaledRemaining;

      if (!countdownStateRef.current.isPaused) {
        countdownDeadlineRef.current = now + rescaledRemaining;
      }

      setCountdownState((prev) => ({
        ...prev,
        totalMs: rescaledTotal,
        remainingMs: rescaledRemaining,
      }));
    }
  }, []);

  // Stop playback at boundary or manual halt
  const stopPlaybackAtBoundary = useCallback(
    (endTimeSec?: number, isBoundaryEnd: boolean = false) => {
      clearStopTimer();
      isPlayingRef.current = false;
      setIsPlaying(false);

      if (audioRef.current) {
        audioRef.current.pause();
        if (endTimeSec !== undefined && Math.abs(audioRef.current.currentTime - endTimeSec) > 0.001) {
          audioRef.current.currentTime = endTimeSec;
        }
      }

      // If comparison is active and in Phase A, transition to 250ms gap
      if (comparisonStateRef.current.isActive && comparisonStateRef.current.phase === 'original') {
        handleComparisonPhaseAToGap();
        return;
      }

      // If Loop Mode is enabled and we reached the boundary end, transition to countdown
      if (isBoundaryEnd && isLoopModeRef.current) {
        // Prevent re-entrant countdown reset if already counting down
        if (countdownStateRef.current.isActive) return;

        const clipDurationMs = Math.max(MIN_CLIP_DURATION_MS, activeEndMs - activeStartMs);
        const speed = playbackSpeedRef.current || 1.0;
        const multiplier = pauseMultiplierRef.current || 1.2;
        const totalPauseMs = Math.max(100, Math.round((clipDurationMs / speed) * multiplier));
        startCountdown(totalPauseMs);
      }
    },
    [clearStopTimer, activeStartMs, activeEndMs, startCountdown, handleComparisonPhaseAToGap]
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
        stopPlaybackAtBoundary(endTimeSec, true);
      }, remainingWallMs);
    },
    [clearStopTimer, stopPlaybackAtBoundary]
  );

  // One-Click Comparison Player Toggle & Active Take Tracker
  const handleToggleComparison = useCallback(() => {
    // If currently comparing: cancel/stop comparison
    if (comparisonStateRef.current.isActive) {
      cancelComparison(true);
      return;
    }

    const take = activeTakeRef.current;
    if (!take || isTakesLoadingRef.current) return;
    const studio = recordingStudioRef.current;
    if (studio?.isBusy() || recordingBusyState.isBusy) return;

    cancelCountdown();
    clearStopTimer();
    if (comparisonAudioRef.current) {
      comparisonAudioRef.current.pause();
    }

    const currentRequestId = ++comparisonRequestIdRef.current;
    const next: ComparisonState = {
      isActive: true,
      phase: 'original',
      error: null,
    };
    comparisonStateRef.current = next;
    setComparisonState(next);

    if (!audioRef.current || !currentSegment) return;
    const audio = audioRef.current;
    const startTimeSec = activeStartMs / 1000;
    const endTimeSec = activeEndMs / 1000;

    audio.currentTime = startTimeSec;
    audio.playbackRate = playbackSpeedRef.current || 1.0;

    audio
      .play()
      .then(() => {
        if (comparisonRequestIdRef.current !== currentRequestId) {
          audio.pause();
          return;
        }
        isPlayingRef.current = true;
        setIsPlaying(true);
        scheduleStopTimer(endTimeSec);
      })
      .catch((err) => {
        if (comparisonRequestIdRef.current !== currentRequestId) return;
        console.error('Comparison Phase A playback error:', err);
        isPlayingRef.current = false;
        setIsPlaying(false);
        cancelComparison(false);
        setComparisonState({
          isActive: false,
          phase: 'idle',
          error: 'Failed to play original audio clip.',
        });
      });
  }, [
    activeStartMs,
    activeEndMs,
    cancelComparison,
    cancelCountdown,
    clearStopTimer,
    currentSegment,
    recordingBusyState.isBusy,
    scheduleStopTimer,
  ]);

  const handleActiveTakeChange = useCallback((take: RecordingRead | null, loading: boolean) => {
    setActiveTake(take);
    setIsTakesLoading(loading);
    activeTakeRef.current = take;
    isTakesLoadingRef.current = loading;
  }, []);

  // Play / Pause / Resume
  const handlePlayPause = useCallback(() => {
    // Case 0: If comparison is active, stop comparison immediately
    if (comparisonStateRef.current.isActive) {
      cancelComparison(true);
      return;
    }

    // Case 1: If countdown is active, toggle freeze / resume of countdown
    if (countdownStateRef.current.isActive) {
      if (countdownStateRef.current.isPaused) {
        resumeCountdown();
      } else {
        pauseCountdown();
      }
      return;
    }

    if (!audioRef.current || !currentSegment) return;
    const audio = audioRef.current;
    const startTimeSec = activeStartMs / 1000;
    const endTimeSec = activeEndMs / 1000;

    // Case 2: If currently playing audio -> PAUSE at current position
    if (isPlayingRef.current) {
      clearStopTimer();
      audio.pause();
      isPlayingRef.current = false;
      setIsPlaying(false);
      return;
    }

    // Case 3: Resume or Start audio
    clearStopTimer();
    const currentRequestId = ++playRequestIdRef.current;
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
        if (playRequestIdRef.current !== currentRequestId) return;
        isPlayingRef.current = true;
        setIsPlaying(true);
        scheduleStopTimer(endTimeSec);
      })
      .catch((err) => {
        if (playRequestIdRef.current !== currentRequestId) return;
        console.error('Audio playback error:', err);
        isPlayingRef.current = false;
        setIsPlaying(false);
      });
  }, [
    activeStartMs,
    activeEndMs,
    cancelComparison,
    clearStopTimer,
    currentSegment,
    pauseCountdown,
    resumeCountdown,
    scheduleStopTimer,
  ]);

  // Replay from segment start
  const handleReplay = useCallback(() => {
    cancelComparison(true);
    cancelCountdown();
    if (!audioRef.current || !currentSegment) return;
    const audio = audioRef.current;
    const startTimeSec = activeStartMs / 1000;
    const endTimeSec = activeEndMs / 1000;

    clearStopTimer();
    const currentRequestId = ++playRequestIdRef.current;
    audio.currentTime = startTimeSec;
    audio.playbackRate = playbackSpeedRef.current;

    audio
      .play()
      .then(() => {
        if (playRequestIdRef.current !== currentRequestId) return;
        isPlayingRef.current = true;
        setIsPlaying(true);
        scheduleStopTimer(endTimeSec);
      })
      .catch((err) => {
        if (playRequestIdRef.current !== currentRequestId) return;
        console.error('Audio replay error:', err);
        isPlayingRef.current = false;
        setIsPlaying(false);
      });
  }, [activeStartMs, activeEndMs, cancelComparison, cancelCountdown, clearStopTimer, currentSegment, scheduleStopTimer]);

  // Preview draft boundaries directly
  const handlePreviewDraft = useCallback(() => {
    cancelComparison(true);
    cancelCountdown();
    if (!audioRef.current) return;
    const audio = audioRef.current;
    const startTimeSec = draftStartMs / 1000;
    const endTimeSec = draftEndMs / 1000;

    clearStopTimer();
    const currentRequestId = ++playRequestIdRef.current;
    audio.currentTime = startTimeSec;
    audio.playbackRate = playbackSpeedRef.current;

    audio
      .play()
      .then(() => {
        if (playRequestIdRef.current !== currentRequestId) return;
        isPlayingRef.current = true;
        setIsPlaying(true);
        scheduleStopTimer(endTimeSec);
      })
      .catch((err) => {
        if (playRequestIdRef.current !== currentRequestId) return;
        console.error('Preview playback error:', err);
        isPlayingRef.current = false;
        setIsPlaying(false);
      });
  }, [cancelComparison, cancelCountdown, clearStopTimer, draftStartMs, draftEndMs, scheduleStopTimer]);

  // Recording Studio Callbacks
  const handleBusyStateChange = useCallback(
    (isBusy: boolean, isUploading: boolean, isReviewPending: boolean) => {
      setRecordingBusyState({ isBusy, isUploading, isReviewPending });
      if (isBusy) {
        cancelComparison(true);
        cancelCountdown();
        stopPlaybackAtBoundary();
      }
    },
    [cancelComparison, cancelCountdown, stopPlaybackAtBoundary]
  );

  const handleStopMasterPlayback = useCallback(() => {
    cancelComparison(true);
    cancelCountdown();
    clearStopTimer();
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
    }
    isPlayingRef.current = false;
    setIsPlaying(false);
  }, [cancelComparison, cancelCountdown, clearStopTimer]);

  const handleRecordingCountChange = useCallback(
    (newCount: number) => {
      if (!currentSegment) return;
      const updated = { ...currentSegment, recordings_count: newCount };
      setSegments((prev) =>
        prev.map((s) => (s.id === updated.id ? updated : s))
      );
      onSegmentUpdate?.(updated);
    },
    [currentSegment, onSegmentUpdate]
  );

  // Navigate to previous clip
  const executePreviousClip = useCallback(() => {
    if (currentIndex <= 0) return;
    cancelComparison(true);
    cancelCountdown();
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
  }, [cancelComparison, cancelCountdown, clearStopTimer, currentIndex, defaultBlindMode, segments]);

  const handlePreviousClip = useCallback(() => {
    if (currentIndex <= 0) return;
    const studio = recordingStudioRef.current;
    if (studio?.isUploading() || recordingBusyState.isUploading) return;
    if (studio?.isBusy() || recordingBusyState.isBusy) {
      setPendingNavAction('prev');
      return;
    }
    executePreviousClip();
  }, [currentIndex, recordingBusyState, executePreviousClip]);

  // Navigate to next clip
  const executeNextClip = useCallback(() => {
    if (currentIndex >= segments.length - 1) return;
    cancelComparison(true);
    cancelCountdown();
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
  }, [cancelComparison, cancelCountdown, clearStopTimer, currentIndex, defaultBlindMode, segments]);

  const handleNextClip = useCallback(() => {
    if (currentIndex >= segments.length - 1) return;
    const studio = recordingStudioRef.current;
    if (studio?.isUploading() || recordingBusyState.isUploading) return;
    if (studio?.isBusy() || recordingBusyState.isBusy) {
      setPendingNavAction('next');
      return;
    }
    executeNextClip();
  }, [currentIndex, segments.length, recordingBusyState, executeNextClip]);

  // Exit back to overview
  const handleExit = useCallback(() => {
    const studio = recordingStudioRef.current;
    if (studio?.isUploading() || recordingBusyState.isUploading) return;
    if (studio?.isBusy() || recordingBusyState.isBusy) {
      setPendingNavAction('exit');
      return;
    }
    cancelComparison(true);
    cancelCountdown();
    clearStopTimer();
    if (audioRef.current) {
      audioRef.current.pause();
    }
    onExit(currentIndexRef.current);
  }, [recordingBusyState, cancelComparison, cancelCountdown, clearStopTimer, onExit]);

  const handleStay = useCallback(() => {
    setPendingNavAction(null);
  }, []);

  const handleDiscardAndProceed = useCallback(() => {
    recordingStudioRef.current?.cancelAndDiscard();
    const action = pendingNavAction;
    setPendingNavAction(null);
    if (action === 'prev') {
      executePreviousClip();
    } else if (action === 'next') {
      executeNextClip();
    } else if (action === 'exit') {
      onExit(currentIndexRef.current);
    }
  }, [pendingNavAction, executePreviousClip, executeNextClip, onExit]);

  // Change playback speed
  const handleSpeedChange = useCallback(
    (speed: number) => {
      const oldSpeed = playbackSpeedRef.current || 1.0;
      setPlaybackSpeed(speed);
      playbackSpeedRef.current = speed;

      if (audioRef.current) {
        audioRef.current.playbackRate = speed;
        // If actively playing, reschedule the boundary timer with the updated speed
        if (isPlayingRef.current) {
          scheduleStopTimer(activeEndMs / 1000);
        }
      }

      // If countdown is active: preserve remaining-time proportion based on speed:
      // pause_ms = (clip_duration / speed) * multiplier, so ratio is oldSpeed / newSpeed
      if (countdownStateRef.current.isActive && speed > 0) {
        const now = performance.now();
        const currentRemaining =
          countdownDeadlineRef.current !== null
            ? Math.max(0, countdownDeadlineRef.current - now)
            : countdownRemainingMsRef.current;

        const speedRatio = oldSpeed / speed;
        const rescaledRemaining = Math.max(20, Math.round(currentRemaining * speedRatio));
        const rescaledTotal = Math.max(
          rescaledRemaining,
          Math.round(countdownTotalMsRef.current * speedRatio)
        );

        countdownTotalMsRef.current = rescaledTotal;
        countdownRemainingMsRef.current = rescaledRemaining;

        if (!countdownStateRef.current.isPaused) {
          countdownDeadlineRef.current = now + rescaledRemaining;
        }

        setCountdownState((prev) => ({
          ...prev,
          totalMs: rescaledTotal,
          remainingMs: rescaledRemaining,
        }));
      }
    },
    [activeEndMs, scheduleStopTimer]
  );

  // Audio event listeners
  const handleTimeUpdate = () => {
    if (!audioRef.current || !currentSegment) return;
    if (!isPlayingRef.current) return;
    if (countdownStateRef.current.isActive) return;

    const current = audioRef.current.currentTime;
    const endTimeSec = activeEndMs / 1000;
    if (current >= endTimeSec) {
      stopPlaybackAtBoundary(endTimeSec, true);
    }
  };

  const handleAudioPause = () => {
    clearStopTimer();
    isPlayingRef.current = false;
    setIsPlaying(false);
  };

  const handleAudioPlay = () => {
    isPlayingRef.current = true;
    setIsPlaying(true);
  };

  const handleAudioEnded = () => {
    if (countdownStateRef.current.isActive) return;
    stopPlaybackAtBoundary(activeEndMs / 1000, true);
  };

  // Transcript Editing Handlers
  const handleStartTextEdit = () => {
    if (!currentSegment) return;
    cancelComparison(true);
    cancelCountdown();
    stopPlaybackAtBoundary();
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

    cancelComparison(true);
    cancelCountdown();
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
      } else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        handleToggleComparison();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        handleReplay();
      } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        handleToggleLoop();
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
        handleExit();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    handlePlayPause,
    handleToggleComparison,
    handleReplay,
    handleToggleLoop,
    handlePreviousClip,
    handleNextClip,
    handleExit,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelComparison(true);
      cancelCountdown();
      clearStopTimer();
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, [cancelComparison, cancelCountdown, clearStopTimer]);

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

      {/* Comparison Take Audio Element */}
      <audio
        ref={comparisonAudioRef}
        preload="auto"
        data-testid="comparison-audio"
        onEnded={() => {
          if (comparisonStateRef.current.isActive && comparisonStateRef.current.phase === 'take') {
            cancelComparison(false);
          }
        }}
        onError={() => {
          if (comparisonStateRef.current.isActive) {
            cancelComparison(false);
            setComparisonState({
              isActive: false,
              phase: 'idle',
              error: 'Unable to play recorded take. Audio file may be missing or unreadable.',
            });
          }
        }}
      />

      {/* Top Navigation & Status Bar */}
      <header className="player-header">
        <button
          className="player-back-btn"
          onClick={handleExit}
          disabled={recordingBusyState.isUploading}
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
                onClick={() => {
                  setIsAdjustingBounds((prev) => {
                    const next = !prev;
                    if (next) {
                      cancelComparison(true);
                      cancelCountdown();
                      stopPlaybackAtBoundary();
                    }
                    return next;
                  });
                }}
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

              {/* Auto-Pause Countdown Banner */}
              {countdownState.isActive && (
                <div
                  className={`player-countdown-card ${countdownState.isPaused ? 'paused' : 'active'}`}
                  role="status"
                  aria-live="polite"
                  data-testid="countdown-card"
                >
                  <div className="player-countdown-header">
                    <div className="player-countdown-label">
                      <RotateCcw size={14} className={countdownState.isPaused ? '' : 'spin-slow'} />
                      <span>
                        {countdownState.isPaused
                          ? `Paused: ${(countdownState.remainingMs / 1000).toFixed(1)}s (Press Space to resume)`
                          : `Repeat aloud: ${(countdownState.remainingMs / 1000).toFixed(1)}s`}
                      </span>
                    </div>
                    <span className="player-countdown-multiplier-tag">
                      {pauseMultiplier.toFixed(1)}x pause
                    </span>
                  </div>
                  <div className="player-countdown-track" aria-hidden="true">
                    <div
                      className="player-countdown-fill"
                      style={{
                        width: `${Math.max(
                          0,
                          Math.min(
                            100,
                            (countdownState.remainingMs / (countdownState.totalMs || 1)) * 100
                          )
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              )}
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

        {/* Auto-Pause Loop Controls */}
        <section className="player-loop-section" aria-label="Auto-Pause Loop controls">
          <div className="player-loop-left">
            <button
              className={`player-loop-btn ${isLoopMode ? 'active' : ''}`}
              onClick={handleToggleLoop}
              aria-pressed={isLoopMode}
              aria-label={isLoopMode ? 'Disable Auto-Pause Loop' : 'Enable Auto-Pause Loop'}
              title="Toggle Auto-Pause Loop (L)"
            >
              <Repeat size={15} />
              <span>Loop</span>
              <kbd className="player-loop-kbd">L</kbd>
            </button>
          </div>

          {isLoopMode && (
            <div
              className="player-multiplier-group"
              role="radiogroup"
              aria-label="Pause duration multiplier"
            >
              <span className="player-multiplier-label">Pause:</span>
              {MULTIPLIER_PRESETS.map((mult) => {
                const isSelected = pauseMultiplier === mult;
                return (
                  <button
                    key={mult}
                    className={`player-multiplier-btn ${isSelected ? 'active' : ''}`}
                    onClick={() => handleMultiplierChange(mult)}
                    role="radio"
                    aria-checked={isSelected}
                    aria-label={`${mult.toFixed(1)} times segment duration pause`}
                  >
                    {mult.toFixed(1)}x
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Primary Controls Row: Previous, Play/Pause, Replay, Next */}
        <section className="player-controls-section" aria-label="Audio controls">
          <button
            className="player-nav-btn"
            onClick={handlePreviousClip}
            disabled={isFirstClip || recordingBusyState.isUploading}
            aria-label="Previous clip"
            title="Previous clip (Left arrow)"
          >
            <ChevronLeft size={22} />
            <span className="player-btn-label">Prev</span>
          </button>

          <button
            className="player-main-play-btn"
            onClick={handlePlayPause}
            aria-label={
              isPlaying || (countdownState.isActive && !countdownState.isPaused)
                ? 'Pause clip'
                : 'Play clip'
            }
            title={
              isPlaying || (countdownState.isActive && !countdownState.isPaused)
                ? 'Pause (Space)'
                : 'Play (Space)'
            }
          >
            {isPlaying || (countdownState.isActive && !countdownState.isPaused) ? (
              <Pause size={28} />
            ) : (
              <Play size={28} style={{ marginLeft: '3px' }} />
            )}
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
            disabled={isLastClip || recordingBusyState.isUploading}
            aria-label="Next clip"
            title="Next clip (Right arrow)"
          >
            <span className="player-btn-label">Next</span>
            <ChevronRight size={22} />
          </button>
        </section>

        {/* Milestone 8 Phase 2: One-Click Comparison Player */}
        <section className="player-comparison-section" aria-label="One-click comparison controls">
          <div className="player-comparison-bar">
            <button
              className={`player-comparison-btn ${comparisonState.isActive ? 'active' : ''}`}
              onClick={handleToggleComparison}
              disabled={!activeTake || isTakesLoading || recordingBusyState.isBusy}
              aria-label={
                comparisonState.isActive
                  ? 'Stop comparison playback'
                  : !activeTake
                  ? 'Comparison unavailable: No saved recording for this clip'
                  : `Compare original audio with Take ${activeTake.take_number}`
              }
              title={
                !activeTake
                  ? 'No saved recording for this clip'
                  : comparisonState.isActive
                  ? 'Stop Comparison (C)'
                  : 'Compare original and your recording (C)'
              }
              data-testid="compare-btn"
            >
              <GitCompare size={16} />
              <span>{comparisonState.isActive ? 'Stop Comparison' : 'Compare A/B'}</span>
              <kbd className="player-loop-kbd">C</kbd>
              {activeTake && (
                <span className="player-comparison-take-badge" data-testid="comparison-take-badge">
                  Take {activeTake.take_number}
                </span>
              )}
            </button>

            {!activeTake && !isTakesLoading && (
              <span className="player-comparison-hint" data-testid="comparison-hint">
                Record your voice below to enable comparison
              </span>
            )}

            {isTakesLoading && (
              <span className="player-comparison-hint loading" data-testid="comparison-loading">
                <Loader2 size={12} className="spin-slow" />
                Loading recordings...
              </span>
            )}
          </div>

          {/* Active Comparison Phase Banner */}
          {comparisonState.isActive && (
            <div
              className={`player-comparison-banner ${comparisonState.phase}`}
              role="status"
              aria-live="polite"
              data-testid="comparison-banner"
            >
              {comparisonState.phase === 'original' && (
                <>
                  <Volume2 size={16} className="spin-slow" />
                  <span>
                    <strong>1/2 Original German</strong> ({playbackSpeed}x speed)...
                  </span>
                </>
              )}
              {comparisonState.phase === 'gap' && (
                <span className="comparison-gap-dots">...</span>
              )}
              {comparisonState.phase === 'take' && (
                <>
                  <Volume2 size={16} />
                  <span>
                    <strong>2/2 Your Voice</strong> (Take {activeTake?.take_number} at 1.0x)...
                  </span>
                </>
              )}
            </div>
          )}

          {/* Dismissible Error Banner */}
          {comparisonState.error && (
            <div className="player-comparison-error" role="alert" data-testid="comparison-error">
              <AlertCircle size={15} />
              <span>{comparisonState.error}</span>
              <button
                type="button"
                className="player-error-dismiss-btn"
                onClick={() => setComparisonState((prev) => ({ ...prev, error: null }))}
                aria-label="Dismiss error"
              >
                <X size={14} />
              </button>
            </div>
          )}
        </section>

        {/* Vocal Recording Studio & Local Takes */}
        <RecordingStudio
          ref={recordingStudioRef}
          segment={currentSegment}
          isMasterPlaying={isPlaying || comparisonState.isActive}
          onStopMasterPlayback={handleStopMasterPlayback}
          onRecordingCountChange={handleRecordingCountChange}
          onBusyStateChange={handleBusyStateChange}
          onActiveTakeChange={handleActiveTakeChange}
        />
      </main>

      {/* Desktop Keyboard Shortcuts Legend */}
      <footer className="player-shortcuts-footer" aria-label="Keyboard shortcuts legend">
        <span className="shortcut-item">
          <kbd>Space</kbd> Play/Pause
        </span>
        <span className="shortcut-item">
          <kbd>C</kbd> Compare
        </span>
        <span className="shortcut-item">
          <kbd>L</kbd> Loop
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

      {/* Navigation Guard Confirmation Modal */}
      {pendingNavAction && (
        <div
          className="player-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="discard-modal-title"
        >
          <div className="player-modal-box">
            <h3 id="discard-modal-title" className="player-modal-title">
              Discard Unsaved Recording?
            </h3>
            <p className="player-modal-desc">
              {(recordingStudioRef.current?.isReviewPending() || recordingBusyState.isReviewPending)
                ? 'You have an unsaved take awaiting review. If you leave now, this recording will be discarded.'
                : 'A recording is currently in progress. If you leave now, the recording will be cancelled and discarded.'}
            </p>
            <div className="player-modal-actions">
              <button
                className="btn btn-secondary"
                onClick={handleStay}
                autoFocus
              >
                Stay on Clip
              </button>
              <button
                className="btn btn-danger"
                onClick={handleDiscardAndProceed}
              >
                Discard & Proceed
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

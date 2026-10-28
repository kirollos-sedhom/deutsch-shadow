import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ArrowLeft,
  Layers,
  FileAudio,
  FileVideo,
  Play,
  Pause,
  RefreshCw,
  Trash2,
  Loader2,
  AlertCircle,
  Volume2,
  Eye,
  EyeOff,
  Headphones,
} from 'lucide-react';
import {
  ProjectDetail,
  SegmentRead,
  getProject,
  getProjectSegments,
  processProject,
  getMasterAudioUrl,
} from '../api/client';
import { formatDate, formatDuration, formatMs } from '../utils/formatters';
import { ShadowingPlayer } from './ShadowingPlayer';

interface ProjectDetailViewProps {
  projectId: string;
  onBack: () => void;
  onDelete: (projectId: string, title: string) => void;
}

export const ProjectDetailView: React.FC<ProjectDetailViewProps> = ({
  projectId,
  onBack,
  onDelete,
}) => {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [segments, setSegments] = useState<SegmentRead[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Blind Listening State
  const [isBlindMode, setIsBlindMode] = useState(true);
  const [revealedSegmentIds, setRevealedSegmentIds] = useState<Set<string>>(new Set());

  // Dedicated Shadowing Player mode
  const [practicingClipIndex, setPracticingClipIndex] = useState<number | null>(null);

  // Playback state
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const segmentStopTimeoutRef = useRef<number | null>(null);
  const activeSegmentIdRef = useRef<string | null>(null);

  // Keep ref synchronized with state
  useEffect(() => {
    activeSegmentIdRef.current = activeSegmentId;
  }, [activeSegmentId]);

  // Load project & segments
  const fetchProjectData = useCallback(async () => {
    try {
      const p = await getProject(projectId);
      setProject(p);
      if (p.settings?.blind_mode_default !== undefined) {
        setIsBlindMode(p.settings.blind_mode_default);
      }

      if (p.status === 'ready') {
        const segs = await getProjectSegments(projectId);
        setSegments(segs);
      }
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load project details');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchProjectData();
    // Reset revealed clips when project changes
    setRevealedSegmentIds(new Set());
  }, [fetchProjectData]);

  // Polling if processing
  useEffect(() => {
    if (!project || (project.status !== 'pending' && project.status !== 'processing')) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const updated = await getProject(projectId);
        setProject(updated);
        if (updated.status === 'ready') {
          const segs = await getProjectSegments(projectId);
          setSegments(segs);
          setIsProcessing(false);
          clearInterval(interval);
        } else if (updated.status === 'failed') {
          setIsProcessing(false);
          clearInterval(interval);
        }
      } catch {
        // silent retry during polling
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [projectId, project?.status]);

  // Handle asynchronous retry
  const handleRetry = async () => {
    setIsProcessing(true);
    try {
      const updated = await processProject(projectId);
      setProject(updated);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Retry failed');
      setIsProcessing(false);
    }
  };

  // Toggle reveal for individual segment
  const toggleSegmentReveal = (segmentId: string) => {
    setRevealedSegmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(segmentId)) {
        next.delete(segmentId);
      } else {
        next.add(segmentId);
      }
      return next;
    });
  };

  // Toggle global blind mode
  const toggleGlobalBlindMode = () => {
    if (isBlindMode) {
      // Switch to unmasked
      setIsBlindMode(false);
    } else {
      // Switch to masked & clear individually revealed clips
      setIsBlindMode(true);
      setRevealedSegmentIds(new Set());
    }
  };

  // Keyboard shortcut listener ('T' key toggles reveal)
  useEffect(() => {
    // If practicing in focused player, let ShadowingPlayer handle shortcuts
    if (practicingClipIndex !== null) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in form inputs
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        if (activeSegmentId) {
          toggleSegmentReveal(activeSegmentId);
        } else {
          toggleGlobalBlindMode();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSegmentId, isBlindMode, practicingClipIndex]);

  // Helper to clear segment stop timeout
  const clearSegmentStopTimer = () => {
    if (segmentStopTimeoutRef.current) {
      window.clearTimeout(segmentStopTimeoutRef.current);
      segmentStopTimeoutRef.current = null;
    }
  };

  // Helper to stop active segment playback at boundary or manual reset
  const stopActiveSegmentPlayback = (endTimeSec?: number) => {
    clearSegmentStopTimer();
    if (audioRef.current) {
      audioRef.current.pause();
      if (endTimeSec !== undefined) {
        audioRef.current.currentTime = endTimeSec;
      }
    }
    setIsPlaying(false);
    setActiveSegmentId(null);
    activeSegmentIdRef.current = null;
  };

  // Play / pause / resume specific segment
  const togglePlaySegment = (segment: SegmentRead) => {
    if (!audioRef.current) return;
    const audio = audioRef.current;
    const startTimeSec = segment.start_time_ms / 1000;
    const endTimeSec = segment.end_time_ms / 1000;

    // Case 1: Clicking the currently playing segment -> PAUSE at current position
    if (activeSegmentId === segment.id && isPlaying) {
      clearSegmentStopTimer();
      audio.pause();
      setIsPlaying(false);
      return;
    }

    // Clear any previous timer before starting or resuming
    clearSegmentStopTimer();

    // Determine target playback start position:
    // Case 2: Resuming the same paused segment if currentTime is still within boundaries
    let targetTime = startTimeSec;
    if (activeSegmentId === segment.id && !isPlaying) {
      if (audio.currentTime >= startTimeSec && audio.currentTime < endTimeSec) {
        targetTime = audio.currentTime;
      }
    }

    // Set audio position and calculate remaining duration
    audio.currentTime = targetTime;
    const remainingMs = Math.max(50, (endTimeSec - targetTime) * 1000);

    audio.play().then(() => {
      setActiveSegmentId(segment.id);
      activeSegmentIdRef.current = segment.id;
      setIsPlaying(true);

      // Boundary timer: stop automatically when reaching segment end
      segmentStopTimeoutRef.current = window.setTimeout(() => {
        if (activeSegmentIdRef.current === segment.id) {
          stopActiveSegmentPlayback(endTimeSec);
        }
      }, remainingMs);
    }).catch((e) => {
      console.error('Audio play error:', e);
    });
  };

  // Time update listener enforcing boundaries and updating display
  const handleTimeUpdate = () => {
    if (!audioRef.current) return;
    const current = audioRef.current.currentTime;
    setCurrentTime(current);

    // Active segment boundary enforcement
    if (activeSegmentIdRef.current) {
      const activeSeg = segments.find((s) => s.id === activeSegmentIdRef.current);
      if (activeSeg) {
        const endTimeSec = activeSeg.end_time_ms / 1000;
        if (current >= endTimeSec) {
          stopActiveSegmentPlayback(endTimeSec);
        }
      }
    }
  };

  const handleAudioPause = () => {
    clearSegmentStopTimer();
    setIsPlaying(false);
  };

  const handleAudioPlay = () => {
    setIsPlaying(true);
  };

  const handleAudioEnded = () => {
    stopActiveSegmentPlayback();
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearSegmentStopTimer();
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  if (isLoading) {
    return (
      <div className="empty-state">
        <Loader2 size={32} className="spin empty-state-icon" style={{ color: 'var(--primary)' }} />
        <h3 className="empty-state-title">Loading Project...</h3>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div>
        <button className="detail-nav-back" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>Back to Library</span>
        </button>
        <div className="alert-banner alert-error" role="alert">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertCircle size={16} />
            <span>{error || 'Project not found.'}</span>
          </div>
        </div>
      </div>
    );
  }

  // Focused Shadowing Player view mode
  if (practicingClipIndex !== null && project.status === 'ready') {
    return (
      <ShadowingPlayer
        projectId={project.id}
        projectTitle={project.title}
        segments={segments}
        projectDurationSeconds={project.duration_seconds}
        initialSegmentIndex={practicingClipIndex}
        defaultBlindMode={isBlindMode}
        onSegmentUpdate={(updated) => {
          setSegments((prev) =>
            prev.map((s) => (s.id === updated.id ? updated : s))
          );
        }}
        onExit={(lastIndex) => {
          setPracticingClipIndex(null);
          const targetSeg = segments[lastIndex];
          if (targetSeg) {
            setActiveSegmentId(targetSeg.id);
            setTimeout(() => {
              const el = document.getElementById(`clip-card-${targetSeg.id}`);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }, 50);
          }
        }}
      />
    );
  }

  const isVideo = project.media_type.startsWith('video');

  return (
    <div>
      <div className="detail-header">
        <button className="detail-nav-back" onClick={onBack} aria-label="Back to Library">
          <ArrowLeft size={16} />
          <span>Back to Library</span>
        </button>

        <div className="detail-title-row">
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-secondary)' }}>
                {isVideo ? <FileVideo size={20} /> : <FileAudio size={20} />}
              </span>
              <h1 className="section-title" style={{ wordBreak: 'break-word' }}>
                {project.title}
              </h1>
              <span className={`badge badge-${project.status}`}>
                {project.status === 'processing' && <Loader2 size={11} className="spin" />}
                {project.status}
              </span>
            </div>
            <div className="project-filename" style={{ marginTop: '4px' }}>
              {project.original_filename} • Added: {formatDate(project.created_at)}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            {project.status === 'failed' && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleRetry}
                disabled={isProcessing}
                aria-label="Retry pipeline"
              >
                <RefreshCw size={13} className={isProcessing ? 'spin' : ''} />
                <span>{isProcessing ? 'Retrying...' : 'Retry'}</span>
              </button>
            )}
            <button
              className="btn btn-danger btn-sm"
              onClick={() => onDelete(project.id, project.title)}
              aria-label="Delete project"
            >
              <Trash2 size={13} />
              <span>Delete</span>
            </button>
          </div>
        </div>

        <div className="detail-stats-bar">
          <div className="stat-box">
            <div className="stat-label">Duration</div>
            <div className="stat-value">
              {project.duration_seconds > 0 ? formatDuration(project.duration_seconds) : '—'}
            </div>
          </div>
          <div className="stat-box">
            <div className="stat-label">Clips</div>
            <div className="stat-value">{segments.length || project.segments_count}</div>
          </div>
          <div className="stat-box">
            <div className="stat-label">Model</div>
            <div className="stat-value" style={{ textTransform: 'uppercase' }}>
              {project.whisper_model}
            </div>
          </div>
          <div className="stat-box">
            <div className="stat-label">Speed</div>
            <div className="stat-value">
              {project.settings?.playback_speed ? `${project.settings.playback_speed}x` : '1.0x'}
            </div>
          </div>
        </div>
      </div>

      {project.status === 'processing' && (
        <div className="alert-banner alert-info" role="status">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Loader2 size={14} className="spin" />
            <span>
              Transcribing audio and detecting sentence boundaries in background... This page updates automatically.
            </span>
          </div>
        </div>
      )}

      {project.status === 'failed' && (
        <div className="alert-banner alert-error" role="alert">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertCircle size={14} />
            <span>Error: {project.error_message || 'Transcription pipeline failed.'}</span>
          </div>
        </div>
      )}

      {project.status === 'ready' && (
        <>
          <div className="audio-player-container">
            <div className="audio-player-top">
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 600 }}>
                <Volume2 size={15} color="var(--primary)" />
                <span>Master Audio</span>
              </div>
              <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                {formatDuration(currentTime)} / {formatDuration(project.duration_seconds)}
              </div>
            </div>

            <audio
              ref={audioRef}
              src={getMasterAudioUrl(project.id)}
              controls
              className="audio-element"
              onTimeUpdate={handleTimeUpdate}
              onPlay={handleAudioPlay}
              onPause={handleAudioPause}
              onEnded={handleAudioEnded}
            />
          </div>

          <div className="clips-section-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Layers size={16} color="var(--primary)" />
              <span style={{ fontWeight: 600, fontSize: '14px' }}>
                Practice Clips ({segments.length})
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {segments.length > 0 && (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    if (audioRef.current) audioRef.current.pause();
                    setIsPlaying(false);
                    setPracticingClipIndex(0);
                  }}
                  aria-label="Start shadowing all clips"
                  style={{ gap: '6px' }}
                >
                  <Headphones size={13} />
                  <span>Start Shadowing</span>
                </button>
              )}

              <button
                className={`blind-mode-toggle-btn ${isBlindMode ? 'active' : ''}`}
                onClick={toggleGlobalBlindMode}
                title="Toggle Blind Listening (Shortcut: T)"
                aria-label="Toggle blind listening mode"
              >
                {isBlindMode ? <EyeOff size={14} /> : <Eye size={14} />}
                <span>{isBlindMode ? 'Blind Mode: ON (Masked)' : 'Blind Mode: OFF (Revealed)'}</span>
              </button>
            </div>
          </div>

          {segments.length === 0 ? (
            <div className="empty-state">
              <p className="empty-state-desc">No speech clips recognized in this audio.</p>
            </div>
          ) : (
            <div className="clips-list">
              {segments.map((segment) => {
                const isActive = activeSegmentId === segment.id;
                const isRevealed = !isBlindMode || revealedSegmentIds.has(segment.id);

                return (
                  <div
                    key={segment.id}
                    id={`clip-card-${segment.id}`}
                    className={`clip-card ${isActive ? 'active-playback' : ''}`}
                  >
                    <div className="clip-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className="clip-index">#{segment.sequence_index + 1}</span>
                        <span className="clip-timing">
                          {formatMs(segment.start_time_ms)} → {formatMs(segment.end_time_ms)}
                        </span>
                      </div>
                      <span className="clip-duration">
                        {(segment.duration_ms / 1000).toFixed(2)}s
                      </span>
                    </div>

                    <div className="clip-transcript-wrapper">
                      <div
                        className={`transcript-text ${isRevealed ? 'revealed' : 'masked'}`}
                        onClick={() => toggleSegmentReveal(segment.id)}
                        tabIndex={0}
                        role="button"
                        aria-label={isRevealed ? 'German transcript (tap to mask)' : 'Masked German transcript (tap to reveal)'}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') toggleSegmentReveal(segment.id);
                        }}
                      >
                        {segment.text}
                      </div>
                      {!isRevealed && (
                        <div className="masked-hint">Tap text or Reveal button to unmask</div>
                      )}
                    </div>

                    <div className="clip-actions">
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          if (audioRef.current) audioRef.current.pause();
                          setIsPlaying(false);
                          setPracticingClipIndex(segment.sequence_index);
                        }}
                        aria-label={`Shadow clip #${segment.sequence_index + 1}`}
                        title={`Practice clip #${segment.sequence_index + 1} in focused player`}
                        style={{ gap: '5px' }}
                      >
                        <Headphones size={12} />
                        <span>Shadow</span>
                      </button>

                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => toggleSegmentReveal(segment.id)}
                        aria-label={isRevealed ? 'Hide transcript' : 'Reveal transcript'}
                      >
                        {isRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
                        <span>{isRevealed ? 'Hide' : 'Reveal'}</span>
                      </button>

                      <button
                        className={`btn btn-sm ${isActive ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => togglePlaySegment(segment)}
                        aria-label={
                          isActive && isPlaying
                            ? `Pause clip #${segment.sequence_index + 1}`
                            : `Play clip #${segment.sequence_index + 1}`
                        }
                      >
                        {isActive && isPlaying ? <Pause size={12} /> : <Play size={12} />}
                        <span>{isActive && isPlaying ? 'Pause' : 'Play'}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};

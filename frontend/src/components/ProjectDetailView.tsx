import React, { useState, useEffect, useRef } from 'react';
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

  // Playback state
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const segmentStopTimeoutRef = useRef<number | null>(null);

  // Load project & segments
  const fetchProjectData = async () => {
    try {
      const p = await getProject(projectId);
      setProject(p);

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
  };

  useEffect(() => {
    fetchProjectData();
  }, [projectId]);

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
          clearInterval(interval);
        } else if (updated.status === 'failed') {
          clearInterval(interval);
        }
      } catch {
        // silent retry during polling
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [projectId, project?.status]);

  // Handle retry
  const handleRetry = async () => {
    setIsProcessing(true);
    try {
      const updated = await processProject(projectId);
      setProject(updated);
      const segs = await getProjectSegments(projectId);
      setSegments(segs);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Processing failed');
    } finally {
      setIsProcessing(false);
    }
  };

  // Play specific segment
  const playSegment = (segment: SegmentRead) => {
    if (!audioRef.current) return;

    if (segmentStopTimeoutRef.current) {
      window.clearTimeout(segmentStopTimeoutRef.current);
      segmentStopTimeoutRef.current = null;
    }

    const startTimeSec = segment.start_time_ms / 1000;
    const endTimeSec = segment.end_time_ms / 1000;
    const durationSec = Math.max(0.1, endTimeSec - startTimeSec);

    audioRef.current.currentTime = startTimeSec;
    audioRef.current.play().then(() => {
      setActiveSegmentId(segment.id);
      setIsPlaying(true);

      segmentStopTimeoutRef.current = window.setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.pause();
          setIsPlaying(false);
          setActiveSegmentId(null);
        }
      }, durationSec * 1000);
    }).catch((e) => {
      console.error('Audio play error:', e);
    });
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  if (isLoading) {
    return (
      <div className="empty-state">
        <Loader2 size={36} className="spin empty-state-icon" style={{ color: 'var(--primary)' }} />
        <h3 className="empty-state-title">Loading Project...</h3>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div>
        <button className="detail-nav-back" onClick={onBack} style={{ marginBottom: '16px' }}>
          <ArrowLeft size={16} />
          <span>Back to Library</span>
        </button>
        <div className="alert-banner alert-error">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertCircle size={16} />
            <span>{error || 'Project not found.'}</span>
          </div>
        </div>
      </div>
    );
  }

  const isVideo = project.media_type.startsWith('video');

  return (
    <div>
      <div className="detail-header">
        <button className="detail-nav-back" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>Back to Library</span>
        </button>

        <div className="detail-title-row">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>
                {isVideo ? <FileVideo size={24} /> : <FileAudio size={24} />}
              </span>
              <h1 className="section-title" style={{ fontSize: '24px' }}>
                {project.title}
              </h1>
              <span className={`badge badge-${project.status}`}>
                {project.status === 'processing' && <Loader2 size={12} className="spin" />}
                {project.status}
              </span>
            </div>
            <div className="project-filename" style={{ marginTop: '6px' }}>
              Original File: {project.original_filename} • Added: {formatDate(project.created_at)}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            {project.status === 'failed' && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleRetry}
                disabled={isProcessing}
              >
                <RefreshCw size={14} className={isProcessing ? 'spin' : ''} />
                <span>{isProcessing ? 'Processing...' : 'Retry Pipeline'}</span>
              </button>
            )}
            <button
              className="btn btn-danger btn-sm"
              onClick={() => onDelete(project.id, project.title)}
            >
              <Trash2 size={14} />
              <span>Delete</span>
            </button>
          </div>
        </div>

        <div className="detail-stats-bar">
          <div className="stat-box">
            <div className="stat-label">Total Duration</div>
            <div className="stat-value">
              {project.duration_seconds > 0 ? formatDuration(project.duration_seconds) : '—'}
            </div>
          </div>
          <div className="stat-box">
            <div className="stat-label">Practice Segments</div>
            <div className="stat-value">{segments.length || project.segments_count}</div>
          </div>
          <div className="stat-box">
            <div className="stat-label">Whisper Model</div>
            <div className="stat-value" style={{ textTransform: 'uppercase' }}>
              {project.whisper_model}
            </div>
          </div>
          <div className="stat-box">
            <div className="stat-label">Playback Speed</div>
            <div className="stat-value">
              {project.settings?.playback_speed ? `${project.settings.playback_speed}x` : '1.0x'}
            </div>
          </div>
        </div>
      </div>

      {project.status === 'processing' && (
        <div className="alert-banner alert-info" style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Loader2 size={16} className="spin" />
            <span>
              Transcribing German speech and detecting natural sentence boundaries... This page will update automatically when ready.
            </span>
          </div>
        </div>
      )}

      {project.status === 'failed' && (
        <div className="alert-banner alert-error" style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertCircle size={16} />
            <span>Pipeline Error: {project.error_message || 'Speech recognition pipeline encountered an unexpected error.'}</span>
          </div>
        </div>
      )}

      {project.status === 'ready' && (
        <>
          <div className="audio-player-container">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 600 }}>
                <Volume2 size={16} color="var(--primary)" />
                <span>Master Audio Player (HTTP Range Streaming)</span>
              </div>
              <div style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                {formatDuration(currentTime)} / {formatDuration(project.duration_seconds)}
              </div>
            </div>

            <audio
              ref={audioRef}
              src={getMasterAudioUrl(project.id)}
              controls
              className="audio-element"
              style={{ width: '100%' }}
              onTimeUpdate={handleTimeUpdate}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />
          </div>

          <div className="segments-container">
            <div className="segments-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Layers size={16} color="var(--primary)" />
                <span style={{ fontWeight: 600, fontSize: '14px' }}>Practice Segments ({segments.length})</span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Click a segment's play button to practice on-demand
              </div>
            </div>

            {segments.length === 0 ? (
              <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                No speech segments detected in this file.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="segments-table">
                  <thead>
                    <tr>
                      <th style={{ width: '60px' }}>#</th>
                      <th style={{ width: '170px' }}>Time Range</th>
                      <th style={{ width: '90px' }}>Duration</th>
                      <th>German Transcript</th>
                      <th style={{ width: '110px', textAlign: 'right' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {segments.map((segment) => {
                      const isActive = activeSegmentId === segment.id;
                      return (
                        <tr
                          key={segment.id}
                          style={{
                            backgroundColor: isActive ? 'rgba(56, 189, 248, 0.1)' : undefined,
                          }}
                        >
                          <td style={{ fontWeight: 600, color: 'var(--text-muted)' }}>
                            #{segment.sequence_index + 1}
                          </td>
                          <td className="timestamp-mono">
                            {formatMs(segment.start_time_ms)} → {formatMs(segment.end_time_ms)}
                          </td>
                          <td className="timestamp-mono" style={{ color: 'var(--text-secondary)' }}>
                            {(segment.duration_ms / 1000).toFixed(2)}s
                          </td>
                          <td className="transcript-german">
                            {segment.text}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              className={`btn btn-sm ${isActive ? 'btn-primary' : 'btn-secondary'}`}
                              onClick={() => playSegment(segment)}
                              title="Play this speech segment"
                            >
                              {isActive && isPlaying ? <Pause size={12} /> : <Play size={12} />}
                              <span>{isActive && isPlaying ? 'Playing' : 'Play'}</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

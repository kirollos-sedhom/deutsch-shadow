import React from 'react';
import {
  FolderOpen,
  Clock,
  Layers,
  FileAudio,
  FileVideo,
  Trash2,
  RefreshCw,
  Plus,
  Loader2,
  AlertCircle,
  Play,
} from 'lucide-react';
import { ProjectSummary } from '../api/client';
import { formatDate, formatDuration } from '../utils/formatters';

interface ProjectListProps {
  projects: ProjectSummary[];
  isLoading: boolean;
  onSelectProject: (projectId: string) => void;
  onDeleteProject: (project: ProjectSummary) => void;
  onRetryProcess: (projectId: string) => void;
  onOpenImport: () => void;
}

export const ProjectList: React.FC<ProjectListProps> = ({
  projects,
  isLoading,
  onSelectProject,
  onDeleteProject,
  onRetryProcess,
  onOpenImport,
}) => {
  if (isLoading && projects.length === 0) {
    return (
      <div className="empty-state">
        <Loader2 size={32} className="spin empty-state-icon" style={{ color: 'var(--primary)' }} />
        <h3 className="empty-state-title">Loading Library...</h3>
        <p className="empty-state-desc">Retrieving projects from local database</p>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="empty-state">
        <FolderOpen size={40} className="empty-state-icon" />
        <h3 className="empty-state-title">No Media Imported</h3>
        <p className="empty-state-desc">
          Your shadowing library is empty. Import a German audio or video file to generate practice clips.
        </p>
        <button className="btn btn-primary" onClick={onOpenImport}>
          <Plus size={16} />
          <span>Import First File</span>
        </button>
      </div>
    );
  }

  const renderStatusBadge = (project: ProjectSummary) => {
    switch (project.status) {
      case 'ready':
        return (
          <span className="badge badge-ready" title="Audio transcribed and segmented">
            Ready
          </span>
        );
      case 'processing':
        return (
          <span className="badge badge-processing" title="Whisper transcription running">
            <Loader2 size={11} className="spin" /> Transcribing
          </span>
        );
      case 'pending':
        return (
          <span className="badge badge-pending" title="Queued for processing">
            Queued
          </span>
        );
      case 'failed':
        return (
          <span
            className="badge badge-failed"
            title={project.error_message || 'Pipeline failed'}
          >
            <AlertCircle size={11} /> Failed
          </span>
        );
      default:
        return <span className="badge">{project.status}</span>;
    }
  };

  return (
    <div>
      <div className="section-header">
        <div>
          <h2 className="section-title">Media Library</h2>
          <p className="section-subtitle">
            {projects.length} project{projects.length === 1 ? '' : 's'} stored locally
          </p>
        </div>
        <button className="btn btn-primary" onClick={onOpenImport}>
          <Plus size={16} />
          <span>Import Media</span>
        </button>
      </div>

      <div className="projects-grid">
        {projects.map((project) => {
          const isVideo = project.media_type.startsWith('video');

          return (
            <div
              key={project.id}
              className="project-card"
              onClick={() => onSelectProject(project.id)}
              tabIndex={0}
              role="button"
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSelectProject(project.id);
              }}
            >
              <div>
                <div className="project-card-header">
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0 }}>
                    <div style={{ color: 'var(--text-secondary)', marginTop: '2px', flexShrink: 0 }}>
                      {isVideo ? <FileVideo size={18} /> : <FileAudio size={18} />}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <h3 className="project-title">{project.title}</h3>
                      <div className="project-filename">{project.original_filename}</div>
                    </div>
                  </div>
                  <div style={{ flexShrink: 0 }}>{renderStatusBadge(project)}</div>
                </div>

                <div className="project-meta-list">
                  <div className="meta-item">
                    <span className="meta-label">Duration</span>
                    <span className="meta-value">
                      <Clock size={11} style={{ display: 'inline', marginRight: '4px' }} />
                      {project.duration_seconds > 0
                        ? formatDuration(project.duration_seconds)
                        : '—'}
                    </span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Practice Clips</span>
                    <span className="meta-value">
                      <Layers size={11} style={{ display: 'inline', marginRight: '4px' }} />
                      {project.segments_count > 0 ? `${project.segments_count} clips` : '—'}
                    </span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Whisper Model</span>
                    <span className="meta-value" style={{ textTransform: 'uppercase' }}>
                      {project.whisper_model || 'base'}
                    </span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Added</span>
                    <span className="meta-value">{formatDate(project.created_at)}</span>
                  </div>
                </div>

                {project.status === 'failed' && project.error_message && (
                  <div
                    style={{
                      fontSize: '11px',
                      color: '#fca5a5',
                      backgroundColor: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid rgba(239, 68, 68, 0.25)',
                      padding: '6px 8px',
                      borderRadius: 'var(--radius-sm)',
                      marginBottom: '10px',
                      wordBreak: 'break-word',
                    }}
                  >
                    {project.error_message}
                  </div>
                )}
              </div>

              <div
                className="project-card-footer"
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ display: 'flex', gap: '6px' }}>
                  {project.status === 'ready' && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => onSelectProject(project.id)}
                      aria-label="View project and practice"
                    >
                      <Play size={12} />
                      <span>Open</span>
                    </button>
                  )}
                  {project.status === 'failed' && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => onRetryProcess(project.id)}
                      title="Retry transcription pipeline"
                      aria-label="Retry transcription"
                    >
                      <RefreshCw size={12} />
                      <span>Retry</span>
                    </button>
                  )}
                </div>

                <button
                  className="btn btn-ghost btn-sm"
                  style={{ color: 'var(--text-muted)', minWidth: 'var(--touch-target-min)' }}
                  onClick={() => onDeleteProject(project)}
                  title="Delete project"
                  aria-label="Delete project"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

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
        <Loader2 size={36} className="spin empty-state-icon" style={{ color: 'var(--primary)' }} />
        <h3 className="empty-state-title">Loading Projects Library...</h3>
        <p className="empty-state-desc">Connecting to SQLite database...</p>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="empty-state">
        <FolderOpen size={48} className="empty-state-icon" />
        <h3 className="empty-state-title">No Audio or Video Projects Found</h3>
        <p className="empty-state-desc">
          Your shadowing library is empty. Import a German audio or video file to start practice segmentation.
        </p>
        <button className="btn btn-primary" onClick={onOpenImport}>
          <Plus size={16} />
          <span>Import Your First File</span>
        </button>
      </div>
    );
  }

  const renderStatusBadge = (project: ProjectSummary) => {
    switch (project.status) {
      case 'ready':
        return (
          <span className="badge badge-ready" title="Speech recognized and segmented into practice chunks">
            ● Ready
          </span>
        );
      case 'processing':
        return (
          <span className="badge badge-processing" title="Speech recognition running in background">
            <Loader2 size={12} className="spin" /> Processing
          </span>
        );
      case 'pending':
        return (
          <span className="badge badge-pending" title="Queued for speech recognition">
            ● Queued
          </span>
        );
      case 'failed':
        return (
          <span
            className="badge badge-failed"
            title={project.error_message || 'Pipeline processing failed'}
          >
            <AlertCircle size={12} /> Failed
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
            {projects.length} project{projects.length === 1 ? '' : 's'} stored in local database
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
            >
              <div>
                <div className="project-card-header">
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                    <div style={{ color: 'var(--text-secondary)', marginTop: '2px' }}>
                      {isVideo ? <FileVideo size={20} /> : <FileAudio size={20} />}
                    </div>
                    <div>
                      <h3 className="project-title">{project.title}</h3>
                      <div className="project-filename">{project.original_filename}</div>
                    </div>
                  </div>
                  <div>{renderStatusBadge(project)}</div>
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
                    <span className="meta-label">Practice Segments</span>
                    <span className="meta-value">
                      <Layers size={11} style={{ display: 'inline', marginRight: '4px' }} />
                      {project.segments_count > 0 ? `${project.segments_count} segments` : '—'}
                    </span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Model</span>
                    <span className="meta-value" style={{ textTransform: 'uppercase' }}>
                      {project.whisper_model || 'base'}
                    </span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Created</span>
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
                    >
                      <Play size={12} />
                      <span>View & Practice</span>
                    </button>
                  )}
                  {project.status === 'failed' && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => onRetryProcess(project.id)}
                      title="Retry speech recognition pipeline"
                    >
                      <RefreshCw size={12} />
                      <span>Retry</span>
                    </button>
                  )}
                </div>

                <button
                  className="btn btn-ghost btn-sm"
                  style={{ color: 'var(--text-muted)' }}
                  onClick={() => onDeleteProject(project)}
                  title="Delete project"
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

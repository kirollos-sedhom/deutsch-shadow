import React from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import { ProjectSummary } from '../api/client';

interface DeleteConfirmModalProps {
  project: ProjectSummary | null;
  isOpen: boolean;
  isDeleting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  project,
  isOpen,
  isDeleting,
  onConfirm,
  onClose,
}) => {
  if (!isOpen || !project) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger)' }}>
            <AlertTriangle size={18} />
            <h3 className="modal-title" style={{ color: 'var(--danger)' }}>Delete Project</h3>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={isDeleting}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <p style={{ marginTop: 0, fontSize: '14px', lineHeight: 1.6 }}>
            Are you sure you want to delete <strong>"{project.title}"</strong>?
          </p>
          <div
            style={{
              padding: '12px 14px',
              backgroundColor: 'rgba(239, 68, 68, 0.08)',
              border: '1px solid rgba(239, 68, 68, 0.25)',
              borderRadius: 'var(--radius-md)',
              fontSize: '12px',
              color: '#fca5a5',
              lineHeight: 1.5,
            }}
          >
            This action will permanently delete:
            <ul style={{ margin: '6px 0 0 0', paddingLeft: '18px' }}>
              <li>The project record in the SQLite database</li>
              <li>All {project.segments_count} generated practice segments and user edits</li>
              <li>The master audio file and stored source media on disk</li>
            </ul>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={isDeleting}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={isDeleting}>
            <Trash2 size={14} />
            <span>{isDeleting ? 'Deleting...' : 'Delete Permanently'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

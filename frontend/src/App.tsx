import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { ProjectList } from './components/ProjectList';
import { ProjectDetailView } from './components/ProjectDetailView';
import { ImportModal } from './components/ImportModal';
import { DeleteConfirmModal } from './components/DeleteConfirmModal';
import {
  ProjectSummary,
  SystemCapabilities,
  WhisperModelTier,
  getProjects,
  deleteProject,
  importProject,
  processProject,
  getSystemCapabilities,
  getWhisperModels,
} from './api/client';
import { AlertCircle, Loader2, X } from 'lucide-react';

interface BackgroundNotification {
  projectId: string;
  title: string;
  whisperModel: string;
}

export const App: React.FC = () => {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // System & Models
  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(null);
  const [models, setModels] = useState<WhisperModelTier[]>([]);

  // Modals state
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isSubmittingImport, setIsSubmittingImport] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<ProjectSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Background active job notification
  const [backgroundNotification, setBackgroundNotification] = useState<BackgroundNotification | null>(null);

  // Fetch initial data
  const loadProjects = useCallback(async () => {
    try {
      const data = await getProjects();
      setProjects(data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to connect to backend server');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadSystemInfo = useCallback(async () => {
    try {
      const [caps, mdlList] = await Promise.all([
        getSystemCapabilities(),
        getWhisperModels(),
      ]);
      setCapabilities(caps);
      setModels(mdlList);
    } catch {
      // capabilities may fail gracefully if backend is booting
    }
  }, []);

  useEffect(() => {
    loadProjects();
    loadSystemInfo();
  }, [loadProjects, loadSystemInfo]);

  // Polling for processing projects
  useEffect(() => {
    const hasActiveProcessing = projects.some(
      (p) => p.status === 'pending' || p.status === 'processing'
    );
    if (!hasActiveProcessing) {
      if (backgroundNotification) {
        // Automatically clear background notification when all jobs finish
        const matchingProject = projects.find((p) => p.id === backgroundNotification.projectId);
        if (matchingProject && (matchingProject.status === 'ready' || matchingProject.status === 'failed')) {
          const timer = setTimeout(() => setBackgroundNotification(null), 4000);
          return () => clearTimeout(timer);
        }
      }
      return;
    }

    const interval = setInterval(async () => {
      try {
        const data = await getProjects();
        setProjects(data);
      } catch {
        // silent fail during polling
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [projects, backgroundNotification]);

  // Handlers
  const handleImport = async (file: File, title: string, model: string, signal?: AbortSignal) => {
    setIsSubmittingImport(true);
    try {
      const res = await importProject(file, title, model, signal);
      await loadProjects();
      setIsImportOpen(false);
      setBackgroundNotification({
        projectId: res.project_id,
        title: res.title || file.name,
        whisperModel: model,
      });
    } finally {
      setIsSubmittingImport(false);
    }
  };

  const handleRetryProcess = async (projectId: string) => {
    try {
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, status: 'processing' } : p))
      );
      await processProject(projectId);
      await loadProjects();
      const proj = projects.find((p) => p.id === projectId);
      if (proj) {
        setBackgroundNotification({
          projectId,
          title: proj.title,
          whisperModel: proj.whisper_model,
        });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Retry failed');
      await loadProjects();
    }
  };

  const handleDeleteConfirm = async () => {
    if (!projectToDelete) return;
    setIsDeleting(true);
    try {
      await deleteProject(projectToDelete.id);
      setProjects((prev) => prev.filter((p) => p.id !== projectToDelete.id));
      if (selectedProjectId === projectToDelete.id) {
        setSelectedProjectId(null);
      }
      if (backgroundNotification?.projectId === projectToDelete.id) {
        setBackgroundNotification(null);
      }
      setProjectToDelete(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteFromDetail = (projectId: string, title: string) => {
    const p = projects.find((x) => x.id === projectId) || {
      id: projectId,
      title,
      original_filename: '',
      media_type: '',
      duration_seconds: 0,
      whisper_model: 'base',
      status: 'ready',
      segments_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setProjectToDelete(p);
  };

  return (
    <div className="app-container">
      <Navbar
        capabilities={capabilities}
        onOpenImport={() => setIsImportOpen(true)}
        onNavigateHome={() => setSelectedProjectId(null)}
      />

      <main className="main-content">
        {backgroundNotification && (
          <div className="background-task-bar" role="status">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
              <Loader2 size={15} className="spin" style={{ color: 'var(--primary)', flexShrink: 0 }} />
              <span style={{ wordBreak: 'break-word', fontSize: '12px' }}>
                Transcribing <strong>{backgroundNotification.title}</strong> in background ({backgroundNotification.whisperModel}). You can continue using other projects.
              </span>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setBackgroundNotification(null)}
              style={{ minHeight: '32px', padding: '4px 8px', flexShrink: 0 }}
              aria-label="Dismiss notification"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {error && (
          <div className="alert-banner alert-error" role="alert">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          </div>
        )}

        {selectedProjectId ? (
          <ProjectDetailView
            projectId={selectedProjectId}
            onBack={() => {
              setSelectedProjectId(null);
              loadProjects();
            }}
            onDelete={handleDeleteFromDetail}
          />
        ) : (
          <ProjectList
            projects={projects}
            isLoading={isLoading}
            onSelectProject={(id) => setSelectedProjectId(id)}
            onDeleteProject={(p) => setProjectToDelete(p)}
            onRetryProcess={handleRetryProcess}
            onOpenImport={() => setIsImportOpen(true)}
          />
        )}
      </main>

      <ImportModal
        isOpen={isImportOpen}
        models={models}
        recommendedModel={capabilities?.recommended_model || 'base'}
        isSubmitting={isSubmittingImport}
        onClose={() => setIsImportOpen(false)}
        onSubmit={handleImport}
      />

      <DeleteConfirmModal
        project={projectToDelete}
        isOpen={Boolean(projectToDelete)}
        isDeleting={isDeleting}
        onConfirm={handleDeleteConfirm}
        onClose={() => setProjectToDelete(null)}
      />
    </div>
  );
};

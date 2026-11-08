import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { ProjectList } from './components/ProjectList';
import { ProjectDetailView } from './components/ProjectDetailView';
import { ImportModal } from './components/ImportModal';
import { DeleteConfirmModal } from './components/DeleteConfirmModal';
import { LoginView } from './components/LoginView';
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
  getAuthStatus,
  logout,
  setUnauthorizedHandler,
} from './api/client';
import { AlertCircle, Loader2, X } from 'lucide-react';

interface BackgroundNotification {
  projectId: string;
  title: string;
  whisperModel: string;
}

type AuthState = 'checking' | 'authenticated' | 'unauthenticated' | 'connection_error';

export const App: React.FC = () => {
  // Authentication state
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [authRequired, setAuthRequired] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

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

  // Authentication session check
  const checkAuth = useCallback(async () => {
    setAuthState('checking');
    setAuthError(null);
    try {
      const status = await getAuthStatus();
      setAuthRequired(status.auth_required);
      if (!status.auth_required || status.authenticated) {
        setAuthState('authenticated');
      } else {
        setAuthState('unauthenticated');
      }
    } catch (err: unknown) {
      setAuthState('connection_error');
      setAuthError(err instanceof Error ? err.message : 'Failed to connect to backend server');
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Intercept 401 Unauthorized from protected API calls
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthState('unauthenticated');
      setProjects([]);
      setSelectedProjectId(null);
      setBackgroundNotification(null);
    });
    return () => {
      setUnauthorizedHandler(null);
    };
  }, []);

  // Fetch initial data only when authenticated
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
    if (authState === 'authenticated') {
      loadProjects();
      loadSystemInfo();
    }
  }, [authState, loadProjects, loadSystemInfo]);

  // Polling for processing projects
  useEffect(() => {
    if (authState !== 'authenticated') return;

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
  }, [authState, projects, backgroundNotification]);

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      // ignore network errors on logout
    } finally {
      setAuthState('unauthenticated');
      setProjects([]);
      setSelectedProjectId(null);
      setBackgroundNotification(null);
    }
  };

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
        whisperModel: res.whisper_model || (authRequired ? 'tiny' : model),
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

  if (authState === 'checking') {
    return (
      <div className="login-container" role="status" aria-label="Connecting to server">
        <Loader2 size={36} className="spin" style={{ color: 'var(--primary)' }} />
        <span style={{ marginTop: '16px', color: 'var(--text-secondary)', fontSize: '13px' }}>
          Connecting to Deutsch Shadow...
        </span>
      </div>
    );
  }

  if (authState === 'connection_error') {
    return (
      <div className="login-container" role="alert">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <AlertCircle size={44} style={{ color: 'var(--danger)', margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>Connection Error</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '20px', lineHeight: 1.5 }}>
            {authError || 'Could not connect to the backend server. Please verify the service is running.'}
          </p>
          <button
            className="btn btn-primary"
            onClick={checkAuth}
            style={{ minHeight: 'var(--touch-target-min)', width: '100%', justifyContent: 'center' }}
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  if (authState === 'unauthenticated') {
    return <LoginView onLoginSuccess={() => setAuthState('authenticated')} />;
  }

  return (
    <div className="app-container">
      <Navbar
        capabilities={capabilities}
        onOpenImport={() => setIsImportOpen(true)}
        onNavigateHome={() => setSelectedProjectId(null)}
        authRequired={authRequired}
        onLogout={handleLogout}
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
            authRequired={authRequired}
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
        isCloudMode={authRequired}
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

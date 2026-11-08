import React from 'react';
import { Volume2, Plus, ExternalLink, Cpu, LogOut } from 'lucide-react';
import { SystemCapabilities } from '../api/client';

interface NavbarProps {
  capabilities: SystemCapabilities | null;
  onOpenImport: () => void;
  onNavigateHome: () => void;
  authRequired?: boolean;
  onLogout?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  capabilities,
  onOpenImport,
  onNavigateHome,
  authRequired = false,
  onLogout,
}) => {
  return (
    <header className="navbar">
      <div className="nav-brand-row">
        <div
          className="nav-brand"
          onClick={onNavigateHome}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onNavigateHome();
          }}
          aria-label="Deutsch Shadow Home"
        >
          <Volume2 size={20} style={{ color: 'var(--primary)' }} />
          <span>Deutsch Shadow</span>
          <span className="brand-badge">{authRequired ? 'Cloud' : 'Local'}</span>
        </div>

        <button
          className="btn btn-primary btn-sm"
          onClick={onOpenImport}
          style={{ minHeight: 'var(--touch-target-min)' }}
          aria-label="Import Media"
        >
          <Plus size={16} />
          <span>Import</span>
        </button>
      </div>

      <div className="nav-actions">
        {capabilities && (
          <div
            className="hardware-chip"
            title={`CPU: ${capabilities.cpu_physical_cores}c/${capabilities.cpu_logical_cores}t | RAM: ${capabilities.ram_total_gb.toFixed(1)} GB | Model: ${capabilities.recommended_model}`}
          >
            <Cpu size={13} style={{ color: capabilities.cuda_available ? 'var(--status-mastered-text)' : 'var(--text-muted)' }} />
            <span>{capabilities.cuda_available ? 'CUDA' : 'CPU'}</span>
            <span style={{ color: 'var(--text-muted)' }}>•</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{capabilities.recommended_model}</span>
          </div>
        )}

        {!authRequired && (
          <a
            href="http://127.0.0.1:8080"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary btn-sm"
            title="Open Milestone 3 Debugging Player on port 8080"
          >
            <span>M3 Player</span>
            <ExternalLink size={12} />
          </a>
        )}

        {authRequired && onLogout && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={onLogout}
            title="Log out of cloud session"
            aria-label="Log Out"
          >
            <LogOut size={13} />
            <span>Logout</span>
          </button>
        )}
      </div>
    </header>
  );
};

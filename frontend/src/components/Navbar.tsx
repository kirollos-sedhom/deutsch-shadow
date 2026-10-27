import React from 'react';
import { Volume2, Plus, ExternalLink, Cpu } from 'lucide-react';
import { SystemCapabilities } from '../api/client';

interface NavbarProps {
  capabilities: SystemCapabilities | null;
  onOpenImport: () => void;
  onNavigateHome: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  capabilities,
  onOpenImport,
  onNavigateHome,
}) => {
  return (
    <header className="navbar">
      <div className="nav-brand" onClick={onNavigateHome} role="button" tabIndex={0}>
        <Volume2 size={22} className="text-primary" style={{ color: 'var(--primary)' }} />
        <span>Deutsch Shadow</span>
        <span className="brand-badge">Milestone 5</span>
      </div>

      <div className="nav-actions">
        {capabilities && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              color: 'var(--text-secondary)',
              backgroundColor: 'rgba(15, 23, 42, 0.6)',
              padding: '5px 10px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-subtle)',
            }}
            title={`CPU: ${capabilities.cpu_physical_cores}c/${capabilities.cpu_logical_cores}t | RAM: ${capabilities.ram_total_gb.toFixed(1)} GB | Recommended model: ${capabilities.recommended_model}`}
          >
            <Cpu size={14} style={{ color: capabilities.cuda_available ? 'var(--success)' : 'var(--text-muted)' }} />
            <span>
              {capabilities.cuda_available ? 'GPU (CUDA)' : 'CPU Mode'}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>•</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{capabilities.recommended_model}</span>
          </div>
        )}

        <a
          href="http://127.0.0.1:8080"
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-secondary btn-sm"
          title="Open Milestone 3 Debugging Player on port 8080"
        >
          <span>M3 Debug Player</span>
          <ExternalLink size={13} />
        </a>

        <button className="btn btn-primary" onClick={onOpenImport}>
          <Plus size={16} />
          <span>Import Media</span>
        </button>
      </div>
    </header>
  );
};

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectDetailView } from './ProjectDetailView';
import * as client from '../api/client';

vi.mock('../api/client', () => ({
  getProject: vi.fn(),
  getProjectSegments: vi.fn(),
  processProject: vi.fn(),
  getMasterAudioUrl: vi.fn((id: string) => `/api/media/${id}/master`),
}));

describe('ProjectDetailView Component & Blind Mode', () => {
  const mockProject: client.ProjectDetail = {
    id: 'proj-test-1',
    title: 'Test Audio Project',
    original_filename: 'audio.mp3',
    media_type: 'audio',
    duration_seconds: 45.0,
    whisper_model: 'base',
    status: 'ready',
    segments_count: 2,
    settings: {
      playback_speed: 1.0,
      auto_pause_multiplier: 1.2,
      blind_mode_default: true,
    },
    created_at: '2026-10-28T10:00:00Z',
    updated_at: '2026-10-28T10:05:00Z',
  };

  const mockSegments: client.SegmentRead[] = [
    {
      id: 'seg-1',
      project_id: 'proj-test-1',
      sequence_index: 0,
      start_time_ms: 1000,
      end_time_ms: 4500,
      duration_ms: 3500,
      text: 'Guten Tag, wie geht es Ihnen?',
      raw_transcript: 'Guten Tag, wie geht es Ihnen?',
      is_edited: false,
      recordings_count: 0,
      created_at: '2026-10-28T10:00:00Z',
      updated_at: '2026-10-28T10:05:00Z',
    },
    {
      id: 'seg-2',
      project_id: 'proj-test-1',
      sequence_index: 1,
      start_time_ms: 4800,
      end_time_ms: 8200,
      duration_ms: 3400,
      text: 'Mir geht es sehr gut, danke.',
      raw_transcript: 'Mir geht es sehr gut, danke.',
      is_edited: false,
      recordings_count: 0,
      created_at: '2026-10-28T10:00:00Z',
      updated_at: '2026-10-28T10:05:00Z',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.getProject).mockResolvedValue(mockProject);
    vi.mocked(client.getProjectSegments).mockResolvedValue(mockSegments);
  });

  it('renders project metadata and clips in responsive cards', async () => {
    render(
      <ProjectDetailView
        projectId="proj-test-1"
        onBack={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Test Audio Project')).toBeInTheDocument();
    });

    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    expect(screen.getByText('00:01.000 → 00:04.500')).toBeInTheDocument();
  });

  it('masks transcripts by default in blind mode', async () => {
    render(
      <ProjectDetailView
        projectId="proj-test-1"
        onBack={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Guten Tag, wie geht es Ihnen?')).toBeInTheDocument();
    });

    const transcriptEl1 = screen.getByText('Guten Tag, wie geht es Ihnen?');
    expect(transcriptEl1).toHaveClass('masked');
    expect(transcriptEl1).not.toHaveClass('revealed');

    const transcriptEl2 = screen.getByText('Mir geht es sehr gut, danke.');
    expect(transcriptEl2).toHaveClass('masked');
  });

  it('unmasks an individual transcript when tapped or clicked', async () => {
    render(
      <ProjectDetailView
        projectId="proj-test-1"
        onBack={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Guten Tag, wie geht es Ihnen?')).toBeInTheDocument();
    });

    const transcriptEl1 = screen.getByText('Guten Tag, wie geht es Ihnen?');
    const transcriptEl2 = screen.getByText('Mir geht es sehr gut, danke.');

    // Click transcript #1
    fireEvent.click(transcriptEl1);
    expect(transcriptEl1).toHaveClass('revealed');
    // Transcript #2 remains masked
    expect(transcriptEl2).toHaveClass('masked');

    // Click again to re-mask
    fireEvent.click(transcriptEl1);
    expect(transcriptEl1).toHaveClass('masked');
  });

  it('toggles all transcripts via the global Blind Mode button', async () => {
    render(
      <ProjectDetailView
        projectId="proj-test-1"
        onBack={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Blind Mode: ON (Masked)')).toBeInTheDocument();
    });

    const globalBtn = screen.getByText('Blind Mode: ON (Masked)');
    const transcriptEl1 = screen.getByText('Guten Tag, wie geht es Ihnen?');
    const transcriptEl2 = screen.getByText('Mir geht es sehr gut, danke.');

    expect(transcriptEl1).toHaveClass('masked');
    expect(transcriptEl2).toHaveClass('masked');

    // Turn Blind Mode OFF -> reveals all
    fireEvent.click(globalBtn);
    expect(screen.getByText('Blind Mode: OFF (Revealed)')).toBeInTheDocument();
    expect(transcriptEl1).toHaveClass('revealed');
    expect(transcriptEl2).toHaveClass('revealed');

    // Turn Blind Mode back ON -> masks all
    fireEvent.click(screen.getByText('Blind Mode: OFF (Revealed)'));
    expect(screen.getByText('Blind Mode: ON (Masked)')).toBeInTheDocument();
    expect(transcriptEl1).toHaveClass('masked');
    expect(transcriptEl2).toHaveClass('masked');
  });

  it('toggles reveal using keyboard shortcut T', async () => {
    render(
      <ProjectDetailView
        projectId="proj-test-1"
        onBack={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Blind Mode: ON (Masked)')).toBeInTheDocument();
    });

    const transcriptEl1 = screen.getByText('Guten Tag, wie geht es Ihnen?');
    expect(transcriptEl1).toHaveClass('masked');

    // Press 't' key
    fireEvent.keyDown(window, { key: 't' });
    expect(transcriptEl1).toHaveClass('revealed');

    // Press 't' key again
    fireEvent.keyDown(window, { key: 't' });
    expect(transcriptEl1).toHaveClass('masked');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectDetailView } from './ProjectDetailView';
import * as client from '../api/client';

vi.mock('../api/client', () => ({
  getProject: vi.fn(),
  getProjectSegments: vi.fn(),
  processProject: vi.fn(),
  getMasterAudioUrl: vi.fn((id: string) => `/api/media/${id}/master`),
  updateSegment: vi.fn(),
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

  it('renders styled Back to Library button and calls onBack when clicked', async () => {
    const onBack = vi.fn();
    render(
      <ProjectDetailView
        projectId="proj-test-1"
        onBack={onBack}
        onDelete={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Back to Library')).toBeInTheDocument();
    });

    const backBtn = screen.getByRole('button', { name: /Back to Library/i });
    expect(backBtn).toHaveClass('detail-nav-back');
    fireEvent.click(backBtn);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('handles segment play, pause without seeking back, resume, and switching segments', async () => {
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

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

    const playBtnSeg1 = screen.getByRole('button', { name: /Play clip #1/i });
    const audioEl = document.querySelector('audio') as HTMLAudioElement;
    expect(audioEl).toBeInTheDocument();

    // 1. Initial Play: starts segment 1 at start_time_ms (1000ms = 1.0s)
    fireEvent.click(playBtnSeg1);
    await waitFor(() => {
      expect(playSpy).toHaveBeenCalled();
      expect(audioEl.currentTime).toBe(1.0);
    });

    const pauseBtnSeg1 = screen.getByRole('button', { name: /Pause clip #1/i });
    expect(pauseBtnSeg1).toHaveTextContent('Pause');

    // 2. Pause while playing: simulate playback advancing to 2.5s and clicking Pause
    audioEl.currentTime = 2.5;
    fireEvent.click(pauseBtnSeg1);

    expect(pauseSpy).toHaveBeenCalled();
    // It must NOT seek back to the beginning!
    expect(audioEl.currentTime).toBe(2.5);

    // Button reverts to Play
    const resumeBtnSeg1 = screen.getByRole('button', { name: /Play clip #1/i });
    expect(resumeBtnSeg1).toHaveTextContent('Play');

    // 3. Resume: clicking again resumes from 2.5s
    fireEvent.click(resumeBtnSeg1);
    await waitFor(() => {
      expect(audioEl.currentTime).toBe(2.5);
    });

    // 4. Switching segments: clicking segment 2 stops segment 1 and starts segment 2 from start boundary (4800ms = 4.8s)
    const playBtnSeg2 = screen.getByRole('button', { name: /Play clip #2/i });
    fireEvent.click(playBtnSeg2);

    await waitFor(() => {
      expect(audioEl.currentTime).toBe(4.8);
      expect(screen.getByRole('button', { name: /Pause clip #2/i })).toBeInTheDocument();
    });

    // Segment 1 button is reset to stopped Play state
    expect(screen.getByRole('button', { name: /Play clip #1/i })).toBeInTheDocument();
  });

  it('stops playback and resets button state when segment reaches end boundary', async () => {
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

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

    const playBtnSeg1 = screen.getByRole('button', { name: /Play clip #1/i });
    const audioEl = document.querySelector('audio') as HTMLAudioElement;

    // Start playback
    fireEvent.click(playBtnSeg1);
    await waitFor(() => {
      expect(playSpy).toHaveBeenCalled();
    });

    expect(screen.getByRole('button', { name: /Pause clip #1/i })).toBeInTheDocument();

    // Advance audio position past segment 1 end boundary (4500ms = 4.5s)
    audioEl.currentTime = 4.5;
    fireEvent.timeUpdate(audioEl);

    // Audio should be paused and clamped to end time
    expect(pauseSpy).toHaveBeenCalled();
    expect(audioEl.currentTime).toBe(4.5);

    // Button should be reset back to stopped Play state
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Play clip #1/i })).toBeInTheDocument();
    });
  });

  it('enters ShadowingPlayer via Start Shadowing button and returns to overview', async () => {
    render(
      <ProjectDetailView
        projectId="proj-test-1"
        onBack={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Start shadowing all clips/i })).toBeInTheDocument();
    });

    const startBtn = screen.getByRole('button', { name: /Start shadowing all clips/i });
    fireEvent.click(startBtn);

    // Player mounted and focused on clip 1
    await waitFor(() => {
      expect(screen.getByTestId('shadowing-player')).toBeInTheDocument();
      expect(screen.getByText('Clip 1 / 2')).toBeInTheDocument();
    });

    // Click Overview to return
    const overviewBtn = screen.getByRole('button', { name: /Back to project overview/i });
    fireEvent.click(overviewBtn);

    // Overview is back
    await waitFor(() => {
      expect(screen.getByText('Practice Clips (2)')).toBeInTheDocument();
    });
  });

  it('enters ShadowingPlayer for a specific clip and preserves selected clip on return', async () => {
    render(
      <ProjectDetailView
        projectId="proj-test-1"
        onBack={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Shadow clip #2/i })).toBeInTheDocument();
    });

    const shadowClip2Btn = screen.getByRole('button', { name: /Shadow clip #2/i });
    fireEvent.click(shadowClip2Btn);

    // Focused on clip 2
    await waitFor(() => {
      expect(screen.getByTestId('shadowing-player')).toBeInTheDocument();
      expect(screen.getByText('Clip 2 / 2')).toBeInTheDocument();
    });

    // Return to overview
    const overviewBtn = screen.getByRole('button', { name: /Back to project overview/i });
    fireEvent.click(overviewBtn);

    // Overview back and clip 2 is highlighted as active
    await waitFor(() => {
      const clipCard2 = document.getElementById('clip-card-seg-2');
      expect(clipCard2).toBeInTheDocument();
      expect(clipCard2).toHaveClass('active-playback');
    });
  });

  it('synchronizes edited segment from ShadowingPlayer back to overview list', async () => {
    const updatedSeg1: client.SegmentRead = {
      ...mockSegments[0],
      text: 'Guten Tag, wie geht es Ihnen? (Persisted Edit)',
      is_edited: true,
    };
    vi.mocked(client.updateSegment).mockResolvedValue(updatedSeg1);

    render(
      <ProjectDetailView
        projectId="proj-test-1"
        onBack={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    // Enter player
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Start shadowing all clips/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Start shadowing all clips/i }));

    await waitFor(() => {
      expect(screen.getByTestId('shadowing-player')).toBeInTheDocument();
    });

    // Edit text
    fireEvent.click(screen.getByRole('button', { name: /Edit transcript text/i }));
    const textarea = screen.getByRole('textbox', { name: /Edit German transcript/i });
    fireEvent.change(textarea, { target: { value: 'Guten Tag, wie geht es Ihnen? (Persisted Edit)' } });
    fireEvent.click(screen.getByRole('button', { name: /Save transcript/i }));

    await waitFor(() => {
      expect(client.updateSegment).toHaveBeenCalled();
    });

    // Return to overview
    fireEvent.click(screen.getByRole('button', { name: /Back to project overview/i }));

    // Overview displays the updated text
    await waitFor(() => {
      expect(screen.getByText('Guten Tag, wie geht es Ihnen? (Persisted Edit)')).toBeInTheDocument();
    });
  });
});


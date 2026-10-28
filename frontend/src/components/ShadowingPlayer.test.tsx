import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShadowingPlayer } from './ShadowingPlayer';
import { SegmentRead } from '../api/client';

const mockSegments: SegmentRead[] = [
  {
    id: 'seg-1',
    project_id: 'proj-1',
    sequence_index: 0,
    start_time_ms: 1000,
    end_time_ms: 4500,
    duration_ms: 3500,
    text: 'Guten Tag, wie geht es Ihnen heute?',
    raw_transcript: 'Guten Tag, wie geht es Ihnen heute?',
    is_edited: false,
    recordings_count: 0,
    created_at: '2026-10-28T10:00:00Z',
    updated_at: '2026-10-28T10:00:00Z',
  },
  {
    id: 'seg-2',
    project_id: 'proj-1',
    sequence_index: 1,
    start_time_ms: 4800,
    end_time_ms: 8200,
    duration_ms: 3400,
    text: 'Mir geht es sehr gut, vielen Dank!',
    raw_transcript: 'Mir geht es sehr gut, vielen Dank!',
    is_edited: false,
    recordings_count: 0,
    created_at: '2026-10-28T10:00:00Z',
    updated_at: '2026-10-28T10:00:00Z',
  },
  {
    id: 'seg-3',
    project_id: 'proj-1',
    sequence_index: 2,
    start_time_ms: 8500,
    end_time_ms: 12000,
    duration_ms: 3500,
    text: 'Das ist wunderbar zu hören.',
    raw_transcript: 'Das ist wunderbar zu hören.',
    is_edited: false,
    recordings_count: 0,
    created_at: '2026-10-28T10:00:00Z',
    updated_at: '2026-10-28T10:00:00Z',
  },
];

describe('ShadowingPlayer Component', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders focused clip view with clip number, progress, and timing', () => {
    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Tagesschau German News"
        segments={mockSegments}
        initialSegmentIndex={0}
        onExit={vi.fn()}
      />
    );

    expect(screen.getByText('Tagesschau German News')).toBeInTheDocument();
    expect(screen.getByText('Clip 1 / 3')).toBeInTheDocument();
    expect(screen.getByText(/00:01.000 → 00:04.500/)).toBeInTheDocument();
    expect(screen.getByText('3.50s')).toBeInTheDocument();
    expect(screen.getByText('Guten Tag, wie geht es Ihnen heute?')).toBeInTheDocument();
  });

  it('handles play, pause in place, and resume without unwanted seeking', async () => {
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={0}
        onExit={vi.fn()}
      />
    );

    const audioEl = document.querySelector('audio') as HTMLAudioElement;
    expect(audioEl).toBeInTheDocument();

    const mainPlayBtn = screen.getByRole('button', { name: /^play clip$/i });

    // 1. Initial Play: seeks to clip start (1.0s) and calls play()
    fireEvent.click(mainPlayBtn);
    await waitFor(() => {
      expect(playSpy).toHaveBeenCalled();
      expect(audioEl.currentTime).toBe(1.0);
      expect(screen.getByRole('button', { name: /^pause clip$/i })).toBeInTheDocument();
    });

    const pauseBtn = screen.getByRole('button', { name: /^pause clip$/i });

    // 2. Advance time to 2.5s and click Pause
    audioEl.currentTime = 2.5;
    fireEvent.click(pauseBtn);

    await waitFor(() => {
      expect(pauseSpy).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /^play clip$/i })).toBeInTheDocument();
    });
    // Pausing must NOT seek to start
    expect(audioEl.currentTime).toBe(2.5);

    // 3. Resume: clicking play resumes from 2.5s
    const resumeBtn = screen.getByRole('button', { name: /^play clip$/i });
    fireEvent.click(resumeBtn);

    await waitFor(() => {
      expect(audioEl.currentTime).toBe(2.5);
      expect(screen.getByRole('button', { name: /^pause clip$/i })).toBeInTheDocument();
    });
  });

  it('replays from the active segment start boundary', async () => {
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={1} // Seg 2: start is 4.8s
        onExit={vi.fn()}
      />
    );

    const audioEl = document.querySelector('audio') as HTMLAudioElement;
    audioEl.currentTime = 6.5;

    const replayBtn = screen.getByRole('button', { name: /Replay clip from start/i });
    fireEvent.click(replayBtn);

    await waitFor(() => {
      expect(playSpy).toHaveBeenCalled();
      expect(audioEl.currentTime).toBe(4.8);
    });
  });

  it('stops playback at end boundary and clamps position', async () => {
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={0} // Seg 1: end is 4.5s
        onExit={vi.fn()}
      />
    );

    const audioEl = document.querySelector('audio') as HTMLAudioElement;
    const playBtn = screen.getByRole('button', { name: /^play clip$/i });

    fireEvent.click(playBtn);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^pause clip$/i })).toBeInTheDocument();
    });

    // Advance time to or beyond segment end
    audioEl.currentTime = 4.5;
    fireEvent.timeUpdate(audioEl);

    expect(pauseSpy).toHaveBeenCalled();
    expect(audioEl.currentTime).toBe(4.5);
    // Button resets to Play
    expect(screen.getByRole('button', { name: /^play clip$/i })).toBeInTheDocument();
  });

  it('navigates next and previous clips, stops playback, and disables boundaries', async () => {
    const pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={0}
        onExit={vi.fn()}
      />
    );

    const prevBtn = screen.getByRole('button', { name: /Previous clip/i });
    const nextBtn = screen.getByRole('button', { name: /Next clip/i });

    // On clip 1, Previous is disabled
    expect(prevBtn).toBeDisabled();
    expect(nextBtn).not.toBeDisabled();

    // Click Next -> moves to Clip 2
    fireEvent.click(nextBtn);
    expect(pauseSpy).toHaveBeenCalled();
    expect(screen.getByText('Clip 2 / 3')).toBeInTheDocument();
    expect(screen.getByText('Mir geht es sehr gut, vielen Dank!')).toBeInTheDocument();
    expect(prevBtn).not.toBeDisabled();

    // Click Next -> moves to Clip 3
    fireEvent.click(nextBtn);
    expect(screen.getByText('Clip 3 / 3')).toBeInTheDocument();
    expect(nextBtn).toBeDisabled(); // Last clip disabled

    // Click Prev -> moves back to Clip 2
    fireEvent.click(prevBtn);
    expect(screen.getByText('Clip 2 / 3')).toBeInTheDocument();
    expect(nextBtn).not.toBeDisabled();
  });

  it('masks transcript by default and predictably remasks on clip change', () => {
    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={0}
        defaultBlindMode={true}
        onExit={vi.fn()}
      />
    );

    const transcriptBox = screen.getByRole('button', {
      name: /Masked German transcript/i,
    });
    expect(transcriptBox).toHaveClass('masked');

    // Reveal transcript via toggle button
    const revealBtn = screen.getByRole('button', { name: /Reveal transcript/i });
    fireEvent.click(revealBtn);
    expect(transcriptBox).toHaveClass('revealed');
    expect(screen.getByRole('button', { name: /Hide transcript/i })).toBeInTheDocument();

    // Navigating to Next clip predictably re-masks the new clip
    const nextBtn = screen.getByRole('button', { name: /Next clip/i });
    fireEvent.click(nextBtn);

    const newTranscriptBox = screen.getByRole('button', {
      name: /Masked German transcript/i,
    });
    expect(newTranscriptBox).toHaveClass('masked');
  });

  it('handles playback speed changes with pitch preservation', () => {
    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={0}
        onExit={vi.fn()}
      />
    );

    const audioEl = document.querySelector('audio') as HTMLAudioElement;
    const speed085Btn = screen.getByRole('radio', { name: /0.85 times/i });
    const speed125Btn = screen.getByRole('radio', { name: /1.25 times/i });

    // Initial speed 1.0x
    const speed100Btn = screen.getByRole('radio', { name: /1 times/i });
    expect(speed100Btn).toHaveClass('active');

    // Select 0.85x
    fireEvent.click(speed085Btn);
    expect(speed085Btn).toHaveClass('active');
    expect(audioEl.playbackRate).toBe(0.85);

    // Select 1.25x
    fireEvent.click(speed125Btn);
    expect(speed125Btn).toHaveClass('active');
    expect(audioEl.playbackRate).toBe(1.25);
  });

  it('responds to keyboard shortcuts (Space, R, T, Left, Right, Esc)', async () => {
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const onExit = vi.fn();

    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={0}
        onExit={onExit}
      />
    );

    // 1. Space triggers Play
    fireEvent.keyDown(window, { code: 'Space' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^pause clip$/i })).toBeInTheDocument();
    });

    // 2. Space triggers Pause
    fireEvent.keyDown(window, { code: 'Space' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^play clip$/i })).toBeInTheDocument();
    });

    // 3. 't' toggles transcript reveal
    const transcriptBox = screen.getByRole('button', { name: /Masked German transcript/i });
    expect(transcriptBox).toHaveClass('masked');
    fireEvent.keyDown(window, { key: 't' });
    expect(transcriptBox).toHaveClass('revealed');

    // 4. 'ArrowRight' moves to next clip
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('Clip 2 / 3')).toBeInTheDocument();

    // 5. 'ArrowLeft' moves to prev clip
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('Clip 1 / 3')).toBeInTheDocument();

    // 6. 'Escape' calls onExit with current index
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('does NOT trigger keyboard shortcuts when typing in inputs', () => {
    const onExit = vi.fn();
    render(
      <div>
        <input data-testid="test-input" type="text" />
        <ShadowingPlayer
          projectId="proj-1"
          projectTitle="Test Project"
          segments={mockSegments}
          initialSegmentIndex={0}
          onExit={onExit}
        />
      </div>
    );

    const input = screen.getByTestId('test-input');
    input.focus();

    // Press Space inside input
    fireEvent.keyDown(input, { code: 'Space' });
    // Should NOT start playback
    expect(screen.getByRole('button', { name: /^play clip$/i })).toBeInTheDocument();

    // Press Escape inside input
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onExit).not.toHaveBeenCalled();
  });

  it('calls onExit with the current segment index when clicking Overview button', () => {
    const onExit = vi.fn();
    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={1}
        onExit={onExit}
      />
    );

    const backBtn = screen.getByRole('button', { name: /Back to project overview/i });
    fireEvent.click(backBtn);
    expect(onExit).toHaveBeenCalledWith(1);
  });
});

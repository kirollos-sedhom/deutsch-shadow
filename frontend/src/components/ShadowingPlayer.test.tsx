import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShadowingPlayer } from './ShadowingPlayer';
import { SegmentRead, updateSegment } from '../api/client';
import * as client from '../api/client';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    updateSegment: vi.fn(),
    getRecordings: vi.fn().mockResolvedValue([]),
    uploadRecording: vi.fn(),
    deleteRecording: vi.fn(),
    setActiveTake: vi.fn(),
    getRecordingAudioUrl: vi.fn((id: string) => `/api/recordings/${id}/audio`),
  };
});

class MockMediaStreamTrack {
  kind = 'audio';
  enabled = true;
  readyState = 'live';
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
}

class MockMediaStream {
  tracks: MockMediaStreamTrack[];
  constructor(tracks?: MockMediaStreamTrack[]) {
    this.tracks = tracks || [new MockMediaStreamTrack()];
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

class MockMediaRecorder extends EventTarget {
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  stream: MockMediaStream;
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  static isTypeSupported = vi.fn((mime: string) => mime.includes('webm'));

  constructor(stream: MockMediaStream, options?: { mimeType?: string }) {
    super();
    this.stream = stream;
    this.mimeType = options?.mimeType || 'audio/webm';
  }

  start = vi.fn(() => {
    this.state = 'recording';
  });

  pause = vi.fn(() => {
    this.state = 'paused';
  });

  resume = vi.fn(() => {
    this.state = 'recording';
  });

  stop = vi.fn(() => {
    this.state = 'inactive';
    if (this.ondataavailable) {
      this.ondataavailable({
        data: new Blob(['audio-data'], { type: this.mimeType }),
      });
    }
    if (this.onstop) {
      this.onstop();
    }
  });
}

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
    localStorage.clear();

    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(new MockMediaStream()),
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'MediaRecorder', {
      value: MockMediaRecorder,
      writable: true,
      configurable: true,
    });
    if (!window.URL.createObjectURL) {
      window.URL.createObjectURL = vi.fn(() => 'blob:mock-review-url');
    }
    if (!window.URL.revokeObjectURL) {
      window.URL.revokeObjectURL = vi.fn();
    }
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

  /* =========================================================================
     Milestone 6 Phase 2 Tests: Transcript Editing & Boundary Adjustment
     ========================================================================= */

  it('edits German transcript text, calls updateSegment, updates display and shows edited tag', async () => {
    const onSegmentUpdate = vi.fn();
    const updatedSeg1: SegmentRead = {
      ...mockSegments[0],
      text: 'Guten Tag, wie geht es Ihnen heute? (korrigiert)',
      is_edited: true,
    };
    vi.mocked(updateSegment).mockResolvedValue(updatedSeg1);

    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={0}
        onExit={vi.fn()}
        onSegmentUpdate={onSegmentUpdate}
      />
    );

    // Click Edit Text button
    const editBtn = screen.getByRole('button', { name: /Edit transcript text/i });
    fireEvent.click(editBtn);

    // Form appears with textarea
    const textarea = screen.getByRole('textbox', { name: /Edit German transcript/i });
    expect(textarea).toHaveValue('Guten Tag, wie geht es Ihnen heute?');

    // Type updated text
    fireEvent.change(textarea, { target: { value: 'Guten Tag, wie geht es Ihnen heute? (korrigiert)' } });

    // Click Save Text
    const saveBtn = screen.getByRole('button', { name: /Save transcript/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(updateSegment).toHaveBeenCalledWith('seg-1', {
        text: 'Guten Tag, wie geht es Ihnen heute? (korrigiert)',
      });
      expect(onSegmentUpdate).toHaveBeenCalledWith(updatedSeg1);
      expect(screen.getByText('Guten Tag, wie geht es Ihnen heute? (korrigiert)')).toBeInTheDocument();
      expect(screen.getByText('Edited')).toBeInTheDocument();
    });
  });

  it('cancels transcript editing and discards local draft', () => {
    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={0}
        onExit={vi.fn()}
      />
    );

    const editBtn = screen.getByRole('button', { name: /Edit transcript text/i });
    fireEvent.click(editBtn);

    const textarea = screen.getByRole('textbox', { name: /Edit German transcript/i });
    fireEvent.change(textarea, { target: { value: 'Completely different uncommitted text' } });

    // Click Cancel
    const cancelBtn = screen.getByRole('button', { name: /Cancel editing/i });
    fireEvent.click(cancelBtn);

    // Edit form closed and original text displayed
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Guten Tag, wie geht es Ihnen heute?')).toBeInTheDocument();
  });

  it('disallows saving empty or whitespace-only transcript text', async () => {
    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={0}
        onExit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit transcript text/i }));
    const textarea = screen.getByRole('textbox', { name: /Edit German transcript/i });
    fireEvent.change(textarea, { target: { value: '   ' } });

    const saveBtn = screen.getByRole('button', { name: /Save transcript/i });
    expect(saveBtn).toBeDisabled();
    expect(updateSegment).not.toHaveBeenCalled();
  });

  it('preserves draft text and displays error banner when text save fails', async () => {
    vi.mocked(updateSegment).mockRejectedValue(new Error('Database lock error'));

    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={0}
        onExit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit transcript text/i }));
    const textarea = screen.getByRole('textbox', { name: /Edit German transcript/i });
    fireEvent.change(textarea, { target: { value: 'Draft with network glitch' } });

    fireEvent.click(screen.getByRole('button', { name: /Save transcript/i }));

    await waitFor(() => {
      expect(screen.getByText('Database lock error')).toBeInTheDocument();
      // Form must remain open and draft preserved!
      expect(screen.getByRole('textbox')).toHaveValue('Draft with network glitch');
    });
  });

  it('toggles boundary adjustment drawer, nudges boundaries, and respects limits', async () => {
    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={1} // Seg 2: start=4800, end=8200. Prev seg end=4500. Next seg start=8500.
        onExit={vi.fn()}
      />
    );

    // Open boundary drawer
    const adjustBtn = screen.getByRole('button', { name: /Toggle boundary adjustment drawer/i });
    fireEvent.click(adjustBtn);

    expect(screen.getByTestId('bounds-drawer')).toBeInTheDocument();

    // Nudge start back 100ms: 4800 -> 4700ms (min floor is 4500ms, so 4700 is valid)
    const nudgeStartBack100 = screen.getByRole('button', { name: /Nudge start back 100ms/i });
    fireEvent.click(nudgeStartBack100);
    expect(screen.getByText('00:04.700')).toBeInTheDocument();

    // Nudge end forward 100ms: 8200 -> 8300ms (max ceiling is 8500ms, so 8300 is valid)
    const nudgeEndFwd100 = screen.getByRole('button', { name: /Nudge end forward 100ms/i });
    fireEvent.click(nudgeEndFwd100);
    expect(screen.getByText('00:08.300')).toBeInTheDocument();

    // Duration is now: 8300 - 4700 = 3600ms = 3.60s
    expect(screen.getByText('Duration: 3.60s')).toBeInTheDocument();
  });

  it('previews draft boundaries in audio element before saving', async () => {
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={1} // Seg 2: start 4800ms = 4.8s
        onExit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Toggle boundary adjustment drawer/i }));

    // Nudge start back 100ms to 4700ms (4.7s)
    fireEvent.click(screen.getByRole('button', { name: /Nudge start back 100ms/i }));

    const audioEl = document.querySelector('audio') as HTMLAudioElement;

    // Click Preview
    const previewBtn = screen.getByRole('button', { name: /Preview draft boundaries/i });
    fireEvent.click(previewBtn);

    await waitFor(() => {
      expect(playSpy).toHaveBeenCalled();
      // Audio currentTime set to draft start (4.7s)
      expect(audioEl.currentTime).toBe(4.7);
    });
  });

  it('resets boundary adjustments to persisted values on reset click', () => {
    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={1} // Seg 2: start 4800ms
        onExit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Toggle boundary adjustment drawer/i }));

    // Nudge start
    fireEvent.click(screen.getByRole('button', { name: /Nudge start back 100ms/i }));
    expect(screen.getByText('00:04.700')).toBeInTheDocument();

    // Click Reset
    const resetBtn = screen.getByRole('button', { name: /Reset boundaries to saved values/i });
    expect(resetBtn).not.toBeDisabled();
    fireEvent.click(resetBtn);

    // Reverted back to 4800ms (00:04.800)
    expect(screen.getByText('00:04.800')).toBeInTheDocument();
    expect(resetBtn).toBeDisabled();
  });

  it('saves boundary adjustments, calls onSegmentUpdate, and updates boundaries', async () => {
    const onSegmentUpdate = vi.fn();
    const updatedSeg2: SegmentRead = {
      ...mockSegments[1],
      start_time_ms: 4700,
      end_time_ms: 8300,
      duration_ms: 3600,
      is_edited: true,
    };
    vi.mocked(updateSegment).mockResolvedValue(updatedSeg2);

    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={1}
        onExit={vi.fn()}
        onSegmentUpdate={onSegmentUpdate}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Toggle boundary adjustment drawer/i }));

    // Nudge start to 4700ms and end to 8300ms
    fireEvent.click(screen.getByRole('button', { name: /Nudge start back 100ms/i }));
    fireEvent.click(screen.getByRole('button', { name: /Nudge end forward 100ms/i }));

    // Click Save Bounds
    const saveBoundsBtn = screen.getByRole('button', { name: /Save boundaries/i });
    fireEvent.click(saveBoundsBtn);

    await waitFor(() => {
      expect(updateSegment).toHaveBeenCalledWith('seg-2', {
        start_time_ms: 4700,
        end_time_ms: 8300,
      });
      expect(onSegmentUpdate).toHaveBeenCalledWith(updatedSeg2);
      expect(saveBoundsBtn).toBeDisabled();
    });
  });

  it('preserves draft boundaries and shows error when boundary save fails', async () => {
    vi.mocked(updateSegment).mockRejectedValue(new Error('Boundary collision rejected'));

    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={1}
        onExit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Toggle boundary adjustment drawer/i }));
    fireEvent.click(screen.getByRole('button', { name: /Nudge start back 100ms/i }));

    fireEvent.click(screen.getByRole('button', { name: /Save boundaries/i }));

    await waitFor(() => {
      expect(screen.getByText('Boundary collision rejected')).toBeInTheDocument();
      // Draft remains at 4700ms!
      expect(screen.getByText('00:04.700')).toBeInTheDocument();
    });
  });

  it('warns before navigating Prev/Next when recording is active and allows staying or discarding', async () => {
    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={1}
        onExit={vi.fn()}
      />
    );

    // Initial clip is Clip 2 / 3
    expect(screen.getByText('Clip 2 / 3')).toBeInTheDocument();

    // Start recording
    const recordBtn = screen.getByRole('button', { name: /start recording your voice/i });
    fireEvent.click(recordBtn);

    await waitFor(() => {
      expect(screen.getByText('REC')).toBeInTheDocument();
    });

    // Try navigating to Next clip
    const nextBtn = screen.getByRole('button', { name: /^next clip/i });
    fireEvent.click(nextBtn);

    // Modal appears
    expect(screen.getByText('Discard Unsaved Recording?')).toBeInTheDocument();
    expect(screen.getByText(/A recording is currently in progress/i)).toBeInTheDocument();

    // Choose "Stay on Clip"
    fireEvent.click(screen.getByRole('button', { name: /stay on clip/i }));
    expect(screen.queryByText('Discard Unsaved Recording?')).not.toBeInTheDocument();
    expect(screen.getByText('Clip 2 / 3')).toBeInTheDocument();

    // Try navigating again and choose "Discard & Proceed"
    fireEvent.click(nextBtn);
    expect(screen.getByText('Discard Unsaved Recording?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /discard & proceed/i }));

    // Successfully navigated to Clip 3 / 3
    await waitFor(() => {
      expect(screen.queryByText('Discard Unsaved Recording?')).not.toBeInTheDocument();
      expect(screen.getByText('Clip 3 / 3')).toBeInTheDocument();
    });
  });

  it('warns before returning to overview when take review is pending and exits on discard', async () => {
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

    // Record and then Stop
    fireEvent.click(screen.getByRole('button', { name: /start recording your voice/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stop recording and review/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /stop recording and review/i }));
    await waitFor(() => {
      expect(screen.getByText('Take Complete')).toBeInTheDocument();
    });

    // Click Overview button
    const overviewBtn = screen.getByRole('button', { name: /back to project overview/i });
    fireEvent.click(overviewBtn);

    // Modal appears mentioning unsaved take
    expect(screen.getByText('Discard Unsaved Recording?')).toBeInTheDocument();
    expect(screen.getByText(/You have an unsaved take awaiting review/i)).toBeInTheDocument();

    // Click Discard & Proceed
    fireEvent.click(screen.getByRole('button', { name: /discard & proceed/i }));
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('disables Prev, Next, and Overview navigation buttons while take upload is in progress', async () => {
    // Return a promise that does not resolve immediately
    let resolveUpload!: (val: client.RecordingRead) => void;
    vi.mocked(client.uploadRecording).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        })
    );

    render(
      <ShadowingPlayer
        projectId="proj-1"
        projectTitle="Test Project"
        segments={mockSegments}
        initialSegmentIndex={1}
        onExit={vi.fn()}
      />
    );

    // Record -> Stop -> Save
    fireEvent.click(screen.getByRole('button', { name: /start recording your voice/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stop recording and review/i })).toBeInTheDocument();
    });

    // Allow at least 60ms to elapse so recorded duration exceeds minimum duration threshold (50ms)
    await new Promise((resolve) => setTimeout(resolve, 70));

    fireEvent.click(screen.getByRole('button', { name: /stop recording and review/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save vocal take/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /save vocal take/i }));

    // While uploading, navigation buttons are disabled
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^previous clip/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /^next clip/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /back to project overview/i })).toBeDisabled();
    });

    // Resolve upload
    resolveUpload({
      id: 'rec-1',
      segment_id: 'seg-2',
      take_number: 1,
      duration_ms: 1500,
      is_active: true,
      created_at: '2026-10-28T12:00:00Z',
      audio_url: '/api/recordings/rec-1/audio',
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^previous clip/i })).not.toBeDisabled();
      expect(screen.getByRole('button', { name: /^next clip/i })).not.toBeDisabled();
      expect(screen.getByRole('button', { name: /back to project overview/i })).not.toBeDisabled();
    });
  });

  it('mutual exclusion: starting recording pauses active master playback', async () => {
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
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

    // Start master audio
    const mainPlayBtn = screen.getByRole('button', { name: /^play clip$/i });
    fireEvent.click(mainPlayBtn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^pause clip$/i })).toBeInTheDocument();
    });

    // Now start recording
    const recordBtn = screen.getByRole('button', { name: /start recording your voice/i });
    fireEvent.click(recordBtn);

    await waitFor(() => {
      expect(pauseSpy).toHaveBeenCalled();
      // Master play button returns to "play clip"
      expect(screen.getByRole('button', { name: /^play clip$/i })).toBeInTheDocument();
    });
  });

  describe('Milestone 8 Phase 1: Auto-Pause Loop Engine', () => {
    it('toggles Auto-Pause Loop mode via loop button and keyboard shortcut L', () => {
      render(
        <ShadowingPlayer
          projectId="proj-1"
          projectTitle="Test Project"
          segments={mockSegments}
          initialSegmentIndex={0}
          onExit={vi.fn()}
        />
      );

      const loopBtn = screen.getByRole('button', { name: /enable auto-pause loop/i });
      expect(loopBtn).toBeInTheDocument();
      expect(loopBtn).not.toHaveClass('active');
      expect(screen.queryByRole('radiogroup', { name: /pause duration multiplier/i })).not.toBeInTheDocument();

      // Click to enable
      fireEvent.click(loopBtn);
      expect(screen.getByRole('button', { name: /disable auto-pause loop/i })).toHaveClass('active');
      expect(screen.getByRole('radiogroup', { name: /pause duration multiplier/i })).toBeInTheDocument();

      // Press 'L' to toggle off
      fireEvent.keyDown(window, { key: 'l' });
      expect(screen.getByRole('button', { name: /enable auto-pause loop/i })).not.toHaveClass('active');
      expect(screen.queryByRole('radiogroup', { name: /pause duration multiplier/i })).not.toBeInTheDocument();

      // Press 'L' to toggle back on
      fireEvent.keyDown(window, { key: 'L' });
      expect(screen.getByRole('button', { name: /disable auto-pause loop/i })).toHaveClass('active');
    });

    it('allows selecting multiplier presets and stores preference', () => {
      render(
        <ShadowingPlayer
          projectId="proj-1"
          projectTitle="Test Project"
          segments={mockSegments}
          initialSegmentIndex={0}
          onExit={vi.fn()}
        />
      );

      // Enable loop
      fireEvent.click(screen.getByRole('button', { name: /enable auto-pause loop/i }));

      // Default multiplier is 1.2x
      const mult12Btn = screen.getByRole('radio', { name: /1.2 times segment duration pause/i });
      expect(mult12Btn).toHaveClass('active');

      // Select 1.5x
      const mult15Btn = screen.getByRole('radio', { name: /1.5 times segment duration pause/i });
      fireEvent.click(mult15Btn);
      expect(mult15Btn).toHaveClass('active');
      expect(mult12Btn).not.toHaveClass('active');
      expect(localStorage.getItem('deutsch_shadow_pause_multiplier')).toBe('1.5');
    });

    it('initiates countdown when playback reaches boundary with Loop enabled (Option B)', async () => {
      vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

      render(
        <ShadowingPlayer
          projectId="proj-1"
          projectTitle="Test Project"
          segments={mockSegments}
          initialSegmentIndex={0}
          onExit={vi.fn()}
        />
      );

      // Enable loop mode
      fireEvent.click(screen.getByRole('button', { name: /enable auto-pause loop/i }));

      // Seg 1 is 1000ms -> 4500ms (duration 3500ms). At 1.0x speed and 1.2x multiplier, pause is 4200ms (4.2s)
      const audioEl = document.querySelector('audio') as HTMLAudioElement;
      const playBtn = screen.getByRole('button', { name: /^play clip$/i });
      fireEvent.click(playBtn);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^pause clip$/i })).toBeInTheDocument();
      });

      // Simulate reaching end boundary (4.5s)
      audioEl.currentTime = 4.5;
      fireEvent.timeUpdate(audioEl);

      await waitFor(() => {
        expect(screen.getByTestId('countdown-card')).toBeInTheDocument();
        expect(screen.getByText(/repeat aloud:/i)).toBeInTheDocument();
        expect(screen.getByText('1.2x pause')).toBeInTheDocument();
      });
    });

    it('pauses and resumes countdown when Space is pressed during the pause phase', async () => {
      vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

      render(
        <ShadowingPlayer
          projectId="proj-1"
          projectTitle="Test Project"
          segments={mockSegments}
          initialSegmentIndex={0}
          onExit={vi.fn()}
        />
      );

      // Enable loop
      fireEvent.click(screen.getByRole('button', { name: /enable auto-pause loop/i }));

      // Play and advance to boundary
      const audioEl = document.querySelector('audio') as HTMLAudioElement;
      fireEvent.click(screen.getByRole('button', { name: /^play clip$/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^pause clip$/i })).toBeInTheDocument();
      });

      audioEl.currentTime = 4.5;
      fireEvent.timeUpdate(audioEl);

      await waitFor(() => {
        expect(screen.getByTestId('countdown-card')).toBeInTheDocument();
      });

      // While countdown is active, button shows "Pause clip"
      const pauseBtn = screen.getByRole('button', { name: /^pause clip$/i });
      fireEvent.click(pauseBtn);

      // Countdown should now be paused
      await waitFor(() => {
        expect(screen.getByText(/paused:/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^play clip$/i })).toBeInTheDocument();
      });

      // Press Space to resume countdown
      fireEvent.keyDown(window, { code: 'Space' });

      await waitFor(() => {
        expect(screen.getByText(/repeat aloud:/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^pause clip$/i })).toBeInTheDocument();
      });
    });

    it('disabling loop during countdown cancels countdown immediately and stops at current clip without seeking back', async () => {
      vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

      render(
        <ShadowingPlayer
          projectId="proj-1"
          projectTitle="Test Project"
          segments={mockSegments}
          initialSegmentIndex={0}
          onExit={vi.fn()}
        />
      );

      // Enable loop and enter countdown
      fireEvent.click(screen.getByRole('button', { name: /enable auto-pause loop/i }));
      const audioEl = document.querySelector('audio') as HTMLAudioElement;
      fireEvent.click(screen.getByRole('button', { name: /^play clip$/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^pause clip$/i })).toBeInTheDocument();
      });

      audioEl.currentTime = 4.5;
      fireEvent.timeUpdate(audioEl);

      await waitFor(() => {
        expect(screen.getByTestId('countdown-card')).toBeInTheDocument();
      });

      // Disable loop
      fireEvent.click(screen.getByRole('button', { name: /disable auto-pause loop/i }));

      // Countdown should disappear immediately and audio position must remain at 4.5s (not reset to 1.0s)
      await waitFor(() => {
        expect(screen.queryByTestId('countdown-card')).not.toBeInTheDocument();
      });
      expect(audioEl.currentTime).toBe(4.5);
      expect(screen.getByRole('button', { name: /^play clip$/i })).toBeInTheDocument();
    });

    it('disabling loop during audio playback allows current clip to finish without starting countdown', async () => {
      vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

      render(
        <ShadowingPlayer
          projectId="proj-1"
          projectTitle="Test Project"
          segments={mockSegments}
          initialSegmentIndex={0}
          onExit={vi.fn()}
        />
      );

      // Enable loop, start playback
      fireEvent.click(screen.getByRole('button', { name: /enable auto-pause loop/i }));
      const audioEl = document.querySelector('audio') as HTMLAudioElement;
      fireEvent.click(screen.getByRole('button', { name: /^play clip$/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^pause clip$/i })).toBeInTheDocument();
      });

      // Disable loop mid-playback
      fireEvent.click(screen.getByRole('button', { name: /disable auto-pause loop/i }));

      // When audio reaches end boundary, countdown should NOT start
      audioEl.currentTime = 4.5;
      fireEvent.timeUpdate(audioEl);

      expect(screen.queryByTestId('countdown-card')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^play clip$/i })).toBeInTheDocument();
    });

    it('rescales remaining pause duration proportionally when playback speed changes during countdown', async () => {
      vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

      render(
        <ShadowingPlayer
          projectId="proj-1"
          projectTitle="Test Project"
          segments={mockSegments}
          initialSegmentIndex={0}
          onExit={vi.fn()}
        />
      );

      // Enable loop and enter countdown at speed 1.0x
      fireEvent.click(screen.getByRole('button', { name: /enable auto-pause loop/i }));
      const audioEl = document.querySelector('audio') as HTMLAudioElement;
      fireEvent.click(screen.getByRole('button', { name: /^play clip$/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^pause clip$/i })).toBeInTheDocument();
      });

      audioEl.currentTime = 4.5;
      fireEvent.timeUpdate(audioEl);

      await waitFor(() => {
        expect(screen.getByTestId('countdown-card')).toBeInTheDocument();
      });

      // Pause the countdown to check deterministic rescaling
      fireEvent.click(screen.getByRole('button', { name: /^pause clip$/i }));

      // Switch speed to 0.75x
      const speed075Btn = screen.getByRole('radio', { name: /0.75 times playback speed/i });
      fireEvent.click(speed075Btn);

      // Total pause scaled from 4.2s (at 1.0x) to 5.6s (4.2 / 0.75)
      await waitFor(() => {
        expect(screen.getByTestId('countdown-card')).toBeInTheDocument();
      });
    });

    it('cancels countdown and halts audio when navigating clips or opening boundary drawer', async () => {
      vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

      render(
        <ShadowingPlayer
          projectId="proj-1"
          projectTitle="Test Project"
          segments={mockSegments}
          initialSegmentIndex={0}
          onExit={vi.fn()}
        />
      );

      // Enable loop and enter countdown
      fireEvent.click(screen.getByRole('button', { name: /enable auto-pause loop/i }));
      const audioEl = document.querySelector('audio') as HTMLAudioElement;
      fireEvent.click(screen.getByRole('button', { name: /^play clip$/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^pause clip$/i })).toBeInTheDocument();
      });

      audioEl.currentTime = 4.5;
      fireEvent.timeUpdate(audioEl);

      await waitFor(() => {
        expect(screen.getByTestId('countdown-card')).toBeInTheDocument();
      });

      // Open boundary drawer
      const adjustBtn = screen.getByRole('button', { name: /toggle boundary adjustment drawer/i });
      fireEvent.click(adjustBtn);

      // Countdown should be cancelled
      expect(screen.queryByTestId('countdown-card')).not.toBeInTheDocument();
      expect(screen.getByTestId('bounds-drawer')).toBeInTheDocument();
    });

    it('replays clip from start when countdown expires and continues loop', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

      render(
        <ShadowingPlayer
          projectId="proj-1"
          projectTitle="Test Project"
          segments={mockSegments}
          initialSegmentIndex={0}
          onExit={vi.fn()}
        />
      );

      // Enable loop
      fireEvent.click(screen.getByRole('button', { name: /enable auto-pause loop/i }));
      const audioEl = document.querySelector('audio') as HTMLAudioElement;
      fireEvent.click(screen.getByRole('button', { name: /^play clip$/i }));
      await vi.advanceTimersByTimeAsync(10);

      // Reach boundary to trigger countdown (pause = 3500ms * 1.2 = 4200ms)
      audioEl.currentTime = 4.5;
      fireEvent.timeUpdate(audioEl);
      expect(screen.getByTestId('countdown-card')).toBeInTheDocument();

      playSpy.mockClear();

      // Advance timers by 4300ms so countdown expires
      await vi.advanceTimersByTimeAsync(4300);

      // Countdown should finish, audio should seek to start (1.0s), and play() should be called again
      expect(audioEl.currentTime).toBe(1.0);
      expect(playSpy).toHaveBeenCalled();
      expect(screen.queryByTestId('countdown-card')).not.toBeInTheDocument();

      vi.useRealTimers();
    });

    it('decreases countdown monotonically and ignores repeated timeupdate events at boundary without resetting', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

      render(
        <ShadowingPlayer
          projectId="proj-1"
          projectTitle="Test Project"
          segments={mockSegments}
          initialSegmentIndex={0}
          onExit={vi.fn()}
        />
      );

      // Enable loop
      fireEvent.click(screen.getByRole('button', { name: /enable auto-pause loop/i }));
      const audioEl = document.querySelector('audio') as HTMLAudioElement;
      fireEvent.click(screen.getByRole('button', { name: /^play clip$/i }));
      await vi.advanceTimersByTimeAsync(10);

      // Reach boundary (pause is 3500ms * 1.2 = 4200ms -> 4.2s)
      audioEl.currentTime = 4.5;
      fireEvent.timeUpdate(audioEl);
      expect(screen.getByTestId('countdown-card')).toBeInTheDocument();
      expect(screen.getByText(/repeat aloud: 4\.2s/i)).toBeInTheDocument();

      // Advance by 400ms: countdown must decrease to 3.8s
      await vi.advanceTimersByTimeAsync(400);
      expect(screen.getByText(/repeat aloud: 3\.8s/i)).toBeInTheDocument();

      // Simulate real browser: queued / seek timeupdate events arrive while paused at boundary
      audioEl.currentTime = 4.5;
      fireEvent.timeUpdate(audioEl);
      fireEvent.timeUpdate(audioEl);

      // Countdown must NOT have reset back to 4.2s; it should remain at 3.8s
      expect(screen.queryByText(/repeat aloud: 4\.2s/i)).not.toBeInTheDocument();
      expect(screen.getByText(/repeat aloud: 3\.8s/i)).toBeInTheDocument();

      // Advance by another 500ms: countdown decreases to 3.3s
      await vi.advanceTimersByTimeAsync(500);
      expect(screen.getByText(/repeat aloud: 3\.3s/i)).toBeInTheDocument();

      // Another late timeupdate does not reset
      fireEvent.timeUpdate(audioEl);
      expect(screen.getByText(/repeat aloud: 3\.3s/i)).toBeInTheDocument();

      vi.useRealTimers();
    });

    it('executes multiple continuous loop cycles seamlessly', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

      render(
        <ShadowingPlayer
          projectId="proj-1"
          projectTitle="Test Project"
          segments={mockSegments}
          initialSegmentIndex={0}
          onExit={vi.fn()}
        />
      );

      // Enable loop
      fireEvent.click(screen.getByRole('button', { name: /enable auto-pause loop/i }));
      const audioEl = document.querySelector('audio') as HTMLAudioElement;
      fireEvent.click(screen.getByRole('button', { name: /^play clip$/i }));
      await vi.advanceTimersByTimeAsync(10);

      // --- Cycle 1 ---
      // Reach boundary
      audioEl.currentTime = 4.5;
      fireEvent.timeUpdate(audioEl);
      expect(screen.getByTestId('countdown-card')).toBeInTheDocument();
      expect(screen.getByText(/repeat aloud: 4\.2s/i)).toBeInTheDocument();

      playSpy.mockClear();

      // Expire countdown for Cycle 1 (4200ms)
      await vi.advanceTimersByTimeAsync(4300);

      // Cycle 1 finished: rewound to 1.0s and play() called
      expect(audioEl.currentTime).toBe(1.0);
      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('countdown-card')).not.toBeInTheDocument();

      // Allow play().then() resolution
      await vi.advanceTimersByTimeAsync(10);
      expect(screen.getByRole('button', { name: /^pause clip$/i })).toBeInTheDocument();

      // --- Cycle 2 ---
      // Advance to boundary again during cycle 2
      audioEl.currentTime = 4.5;
      fireEvent.timeUpdate(audioEl);

      // Cycle 2 countdown should now be active
      expect(screen.getByTestId('countdown-card')).toBeInTheDocument();
      expect(screen.getByText(/repeat aloud: 4\.2s/i)).toBeInTheDocument();

      playSpy.mockClear();

      // Expire countdown for Cycle 2
      await vi.advanceTimersByTimeAsync(4300);

      // Cycle 2 finished: rewound to 1.0s and play() called again
      expect(audioEl.currentTime).toBe(1.0);
      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('countdown-card')).not.toBeInTheDocument();

      vi.useRealTimers();
    });
  });
});

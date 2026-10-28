import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { RecordingStudio, RecordingStudioHandle } from './RecordingStudio';
import * as client from '../api/client';

// Mock audio API client methods
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    getRecordings: vi.fn(),
    uploadRecording: vi.fn(),
    deleteRecording: vi.fn(),
    setActiveTake: vi.fn(),
    getRecordingAudioUrl: vi.fn((id: string) => `/api/recordings/${id}/audio`),
  };
});

// Mock media hardware
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
        data: new Blob(['recorded-audio-content'], { type: this.mimeType }),
      });
    }
    if (this.onstop) {
      this.onstop();
    }
  });
}

describe('RecordingStudio Component', () => {
  let originalMediaDevices: unknown;
  let originalMediaRecorder: unknown;
  let mockStream: MockMediaStream;

  const mockSegment: client.SegmentRead = {
    id: 'seg-100',
    project_id: 'proj-1',
    sequence_index: 0,
    start_time_ms: 1000,
    end_time_ms: 4000,
    duration_ms: 3000,
    text: 'Hallo Welt',
    raw_transcript: 'Hallo Welt',
    is_edited: false,
    recordings_count: 0,
    created_at: '2026-10-28T12:00:00Z',
    updated_at: '2026-10-28T12:00:00Z',
  };

  const sampleTake: client.RecordingRead = {
    id: 'rec-1',
    segment_id: 'seg-100',
    take_number: 1,
    audio_url: '/api/recordings/rec-1/audio',
    duration_ms: 2500,
    is_active: true,
    created_at: '2026-10-28T12:01:00Z',
  };

  beforeEach(() => {
    originalMediaDevices = navigator.mediaDevices;
    originalMediaRecorder = window.MediaRecorder;

    mockStream = new MockMediaStream();

    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(mockStream),
      },
      writable: true,
      configurable: true,
    });

    Object.defineProperty(window, 'MediaRecorder', {
      value: MockMediaRecorder,
      writable: true,
      configurable: true,
    });

    // Mock HTMLMediaElement audio playback
    window.HTMLMediaElement.prototype.play = vi.fn().mockImplementation(() => Promise.resolve());
    window.HTMLMediaElement.prototype.pause = vi.fn();

    // Mock Object URL
    window.URL.createObjectURL = vi.fn(() => 'blob:mock-review-url');
    window.URL.revokeObjectURL = vi.fn();

    // Default mock responses
    vi.mocked(client.getRecordings).mockResolvedValue([]);
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'MediaRecorder', {
      value: originalMediaRecorder,
      writable: true,
      configurable: true,
    });
    vi.clearAllMocks();
  });

  it('renders idle state with Record Your Voice button and empty saved takes message', async () => {
    const onStopMasterPlayback = vi.fn();
    const onRecordingCountChange = vi.fn();
    const onBusyStateChange = vi.fn();

    render(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={onStopMasterPlayback}
        onRecordingCountChange={onRecordingCountChange}
        onBusyStateChange={onBusyStateChange}
      />
    );

    expect(screen.getByRole('button', { name: /start recording your voice/i })).toBeInTheDocument();
    expect(screen.getByText('Your Vocal Practice')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('No saved takes for this clip yet.')).toBeInTheDocument();
    });

    // Initial busy state reported as false
    expect(onBusyStateChange).toHaveBeenCalledWith(false, false, false);
  });

  it('renders unsupported browser alert when MediaRecorder is unavailable', () => {
    Object.defineProperty(window, 'MediaRecorder', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    render(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={vi.fn()}
        onRecordingCountChange={vi.fn()}
        onBusyStateChange={vi.fn()}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/recording is not supported/i);
    expect(screen.getByRole('button', { name: /start recording your voice/i })).toBeDisabled();
  });

  it('renders microphone access denied alert when getUserMedia rejects with NotAllowedError', async () => {
    const notAllowedError = new Error('Permission denied');
    notAllowedError.name = 'NotAllowedError';

    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockRejectedValue(notAllowedError),
      },
      writable: true,
      configurable: true,
    });

    render(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={vi.fn()}
        onRecordingCountChange={vi.fn()}
        onBusyStateChange={vi.fn()}
      />
    );

    const recordBtn = screen.getByRole('button', { name: /start recording your voice/i });
    fireEvent.click(recordBtn);

    await waitFor(() => {
      expect(screen.getByText(/Microphone Access Denied/i)).toBeInTheDocument();
    });
  });

  it('starts recording on click, invokes onStopMasterPlayback, and updates busy state', async () => {
    const onStopMasterPlayback = vi.fn();
    const onBusyStateChange = vi.fn();

    render(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={onStopMasterPlayback}
        onRecordingCountChange={vi.fn()}
        onBusyStateChange={onBusyStateChange}
      />
    );

    const recordBtn = screen.getByRole('button', { name: /start recording your voice/i });
    fireEvent.click(recordBtn);

    await waitFor(() => {
      expect(screen.getByTestId('rec-active-box')).toBeInTheDocument();
    });

    expect(onStopMasterPlayback).toHaveBeenCalled();
    expect(screen.getByText('REC')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop recording and review/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pause recording/i })).toBeInTheDocument();
    expect(onBusyStateChange).toHaveBeenCalledWith(true, false, false);
  });

  it('pauses and resumes active recording', async () => {
    render(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={vi.fn()}
        onRecordingCountChange={vi.fn()}
        onBusyStateChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start recording your voice/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /pause recording/i })).toBeInTheDocument();
    });

    // Pause recording
    fireEvent.click(screen.getByRole('button', { name: /pause recording/i }));
    expect(screen.getByText('PAUSED')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume recording/i })).toBeInTheDocument();

    // Resume recording
    fireEvent.click(screen.getByRole('button', { name: /resume recording/i }));
    expect(screen.getByText('REC')).toBeInTheDocument();
  });

  it('cancels active recording on Cancel click and returns to idle', async () => {
    render(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={vi.fn()}
        onRecordingCountChange={vi.fn()}
        onBusyStateChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start recording your voice/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel and discard recording/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /cancel and discard recording/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start recording your voice/i })).toBeInTheDocument();
    });
  });

  it('stops recording, displays review state, and allows preview playback', async () => {
    const onStopMasterPlayback = vi.fn();

    render(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={onStopMasterPlayback}
        onRecordingCountChange={vi.fn()}
        onBusyStateChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start recording your voice/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stop recording and review/i })).toBeInTheDocument();
    });

    await new Promise((resolve) => setTimeout(resolve, 70));
    fireEvent.click(screen.getByRole('button', { name: /stop recording and review/i }));

    await waitFor(() => {
      expect(screen.getByTestId('rec-review-box')).toBeInTheDocument();
    });

    expect(screen.getByText('Take Complete')).toBeInTheDocument();
    expect(window.URL.createObjectURL).toHaveBeenCalled();

    // Toggle Preview Playback
    const previewBtn = screen.getByRole('button', { name: /play take preview/i });
    fireEvent.click(previewBtn);
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it('successfully saves take, invokes uploadRecording, and updates count', async () => {
    const onRecordingCountChange = vi.fn();
    vi.mocked(client.uploadRecording).mockResolvedValue(sampleTake);

    render(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={vi.fn()}
        onRecordingCountChange={onRecordingCountChange}
        onBusyStateChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start recording your voice/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stop recording and review/i })).toBeInTheDocument();
    });

    await new Promise((resolve) => setTimeout(resolve, 70));
    fireEvent.click(screen.getByRole('button', { name: /stop recording and review/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save vocal take/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /save vocal take/i }));

    await waitFor(() => {
      expect(client.uploadRecording).toHaveBeenCalledWith('seg-100', expect.any(Blob), expect.any(Number));
    });

    await waitFor(() => {
      expect(screen.getByText('Take #1')).toBeInTheDocument();
      expect(screen.getByText('Active Take')).toBeInTheDocument();
    });

    expect(onRecordingCountChange).toHaveBeenCalledWith(1);
    // Returns to idle mode after save
    expect(screen.getByRole('button', { name: /start recording your voice/i })).toBeInTheDocument();
  });

  it('handles upload failure by preserving recordedBlob and displaying retry banner', async () => {
    vi.mocked(client.uploadRecording).mockRejectedValue(new Error('Network error 500'));

    render(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={vi.fn()}
        onRecordingCountChange={vi.fn()}
        onBusyStateChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start recording your voice/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stop recording and review/i })).toBeInTheDocument();
    });

    await new Promise((resolve) => setTimeout(resolve, 70));
    fireEvent.click(screen.getByRole('button', { name: /stop recording and review/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save vocal take/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /save vocal take/i }));

    await waitFor(() => {
      expect(screen.getByText('Network error 500')).toBeInTheDocument();
    });

    // Review controls remain active to allow retry
    expect(screen.getByRole('button', { name: /save vocal take/i })).toBeInTheDocument();
  });

  it('renders saved takes list and toggles take playback', async () => {
    const onStopMasterPlayback = vi.fn();
    vi.mocked(client.getRecordings).mockResolvedValue([sampleTake]);

    render(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={onStopMasterPlayback}
        onRecordingCountChange={vi.fn()}
        onBusyStateChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Take #1')).toBeInTheDocument();
    });

    const playTakeBtn = screen.getByRole('button', { name: /play take #1/i });
    fireEvent.click(playTakeBtn);

    expect(onStopMasterPlayback).toHaveBeenCalled();
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it('designates active take when Set Active is clicked', async () => {
    const inactiveTake: client.RecordingRead = {
      ...sampleTake,
      id: 'rec-2',
      take_number: 2,
      is_active: false,
    };
    vi.mocked(client.getRecordings).mockResolvedValue([sampleTake, inactiveTake]);
    vi.mocked(client.setActiveTake).mockResolvedValue({ ...inactiveTake, is_active: true });

    render(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={vi.fn()}
        onRecordingCountChange={vi.fn()}
        onBusyStateChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Take #2')).toBeInTheDocument();
    });

    const setActiveBtn = screen.getByRole('button', { name: /designate take #2 as active/i });
    fireEvent.click(setActiveBtn);

    await waitFor(() => {
      expect(client.setActiveTake).toHaveBeenCalledWith('rec-2');
    });
  });

  it('shows inline confirmation before deleting a take and updates list', async () => {
    const onRecordingCountChange = vi.fn();
    vi.mocked(client.getRecordings)
      .mockResolvedValueOnce([sampleTake])
      .mockResolvedValueOnce([]); // After delete
    vi.mocked(client.deleteRecording).mockResolvedValue();

    render(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={vi.fn()}
        onRecordingCountChange={onRecordingCountChange}
        onBusyStateChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Take #1')).toBeInTheDocument();
    });

    const deleteBtn = screen.getByRole('button', { name: /delete take #1/i });
    fireEvent.click(deleteBtn);

    // Confirm button appears
    const confirmBtn = screen.getByRole('button', { name: /confirm delete take #1/i });
    expect(confirmBtn).toBeInTheDocument();

    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(client.deleteRecording).toHaveBeenCalledWith('rec-1');
      expect(client.getRecordings).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(screen.getByText('No saved takes for this clip yet.')).toBeInTheDocument();
    });
    expect(onRecordingCountChange).toHaveBeenCalledWith(0);
  });

  it('maintains in-memory session cache across segment prop changes without re-fetching', async () => {
    vi.mocked(client.getRecordings).mockResolvedValue([sampleTake]);

    const { rerender } = render(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={vi.fn()}
        onRecordingCountChange={vi.fn()}
        onBusyStateChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Take #1')).toBeInTheDocument();
    });
    expect(client.getRecordings).toHaveBeenCalledTimes(1);

    // Switch to another segment
    const segment2: client.SegmentRead = {
      ...mockSegment,
      id: 'seg-200',
    };
    rerender(
      <RecordingStudio
        segment={segment2}
        isMasterPlaying={false}
        onStopMasterPlayback={vi.fn()}
        onRecordingCountChange={vi.fn()}
        onBusyStateChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(client.getRecordings).toHaveBeenCalledTimes(2);
    });

    // Switch back to seg-100 — should use cache, no 3rd getRecordings call!
    rerender(
      <RecordingStudio
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={vi.fn()}
        onRecordingCountChange={vi.fn()}
        onBusyStateChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Take #1')).toBeInTheDocument();
    });
    expect(client.getRecordings).toHaveBeenCalledTimes(2);
  });

  it('exposes cancelAndDiscard via ref to cleanly abort an in-flight recording', async () => {
    const ref = createRef<RecordingStudioHandle>();

    render(
      <RecordingStudio
        ref={ref}
        segment={mockSegment}
        isMasterPlaying={false}
        onStopMasterPlayback={vi.fn()}
        onRecordingCountChange={vi.fn()}
        onBusyStateChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start recording your voice/i }));

    await waitFor(() => {
      expect(screen.getByTestId('rec-active-box')).toBeInTheDocument();
    });

    // Parent invokes cancelAndDiscard
    ref.current?.cancelAndDiscard();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start recording your voice/i })).toBeInTheDocument();
    });
  });
});

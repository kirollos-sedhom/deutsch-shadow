import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useAudioRecorder,
  getPreferredMimeType,
  stopMediaStream,
  formatAudioRecorderError,
} from './useAudioRecorder';

// Mock Web Audio / MediaStream hardware classes
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

  start = vi.fn((_timeslice?: number) => {
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
        data: new Blob(['audio-sample-data'], { type: this.mimeType }),
      });
    }
    if (this.onstop) {
      this.onstop();
    }
  });
}

describe('useAudioRecorder Hook', () => {
  let originalMediaDevices: unknown;
  let originalMediaRecorder: unknown;
  let mockStream: MockMediaStream;

  beforeEach(() => {
    vi.useFakeTimers();
    originalMediaDevices = navigator.mediaDevices;
    originalMediaRecorder = window.MediaRecorder;

    mockStream = new MockMediaStream();

    // Stub navigator.mediaDevices.getUserMedia
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(mockStream),
      },
      writable: true,
      configurable: true,
    });

    // Stub window.MediaRecorder
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = MockMediaRecorder;
    MockMediaRecorder.isTypeSupported.mockImplementation((mime: string) => mime.includes('webm'));
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();

    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      writable: true,
      configurable: true,
    });

    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = originalMediaRecorder;
  });

  describe('Helper functions', () => {
    it('getPreferredMimeType returns highest-priority supported candidate', () => {
      MockMediaRecorder.isTypeSupported.mockImplementation(
        (mime: string) => mime === 'audio/webm' || mime === 'audio/ogg'
      );
      expect(getPreferredMimeType()).toBe('audio/webm');
    });

    it('getPreferredMimeType falls back to mp4 when webm is unsupported (Safari emulation)', () => {
      MockMediaRecorder.isTypeSupported.mockImplementation(
        (mime: string) => mime === 'audio/mp4'
      );
      expect(getPreferredMimeType()).toBe('audio/mp4');
    });

    it('getPreferredMimeType returns empty string when no candidate is supported', () => {
      MockMediaRecorder.isTypeSupported.mockReturnValue(false);
      expect(getPreferredMimeType()).toBe('');
    });

    it('stopMediaStream stops all tracks safely', () => {
      const track1 = new MockMediaStreamTrack();
      const track2 = new MockMediaStreamTrack();
      const stream = new MockMediaStream([track1, track2]);

      stopMediaStream(stream as unknown as MediaStream);
      expect(track1.stop).toHaveBeenCalled();
      expect(track2.stop).toHaveBeenCalled();
    });

    it('formatAudioRecorderError translates DOMExceptions to friendly strings', () => {
      const notAllowed = new DOMException('Permission denied', 'NotAllowedError');
      expect(formatAudioRecorderError(notAllowed)).toContain('Microphone permission was denied');

      const notFound = new DOMException('Device not found', 'NotFoundError');
      expect(formatAudioRecorderError(notFound)).toContain('No microphone was found');

      const notReadable = new DOMException('Hardware busy', 'NotReadableError');
      expect(formatAudioRecorderError(notReadable)).toContain('Microphone is already in use');

      expect(formatAudioRecorderError(new Error('Custom hardware error'))).toBe('Custom hardware error');
    });
  });

  describe('Hook initialization', () => {
    it('initializes with default idle state and indicates support', () => {
      const { result } = renderHook(() => useAudioRecorder());

      expect(result.current.status).toBe('idle');
      expect(result.current.permission).toBe('prompt');
      expect(result.current.durationMs).toBe(0);
      expect(result.current.recordedBlob).toBeNull();
      expect(result.current.recordingResult).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isSupported).toBe(true);
    });

    it('flags isSupported as false when mediaDevices is missing', async () => {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: undefined,
        writable: true,
        configurable: true,
      });

      const { result } = renderHook(() => useAudioRecorder());
      expect(result.current.isSupported).toBe(false);

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.error).toContain('not supported in this browser');
      expect(result.current.status).toBe('idle');
    });
  });

  describe('Permission handling', () => {
    it('updates permission to denied when getUserMedia rejects with NotAllowedError', async () => {
      const permError = new DOMException('Access denied', 'NotAllowedError');
      (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(permError);

      const { result } = renderHook(() => useAudioRecorder());

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.permission).toBe('denied');
      expect(result.current.status).toBe('idle');
      expect(result.current.error).toContain('Microphone permission was denied');
    });

    it('handles device not found without crashing', async () => {
      const devError = new DOMException('No device', 'NotFoundError');
      (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(devError);

      const { result } = renderHook(() => useAudioRecorder());

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.error).toContain('No microphone was found');
    });
  });

  describe('Recording lifecycle: start, pause, resume, stop', () => {
    it('records audio, tracks duration, stops tracks, and preserves recordedBlob', async () => {
      const { result } = renderHook(() => useAudioRecorder());

      // 1. Start recording
      await act(async () => {
        await result.current.startRecording();
      });

      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      expect(result.current.status).toBe('recording');
      expect(result.current.permission).toBe('granted');
      expect(result.current.error).toBeNull();

      // 2. Advance timers by 500ms
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(result.current.durationMs).toBeGreaterThanOrEqual(400);

      // 3. Pause recording
      act(() => {
        result.current.pauseRecording();
      });
      expect(result.current.status).toBe('paused');
      const pausedDuration = result.current.durationMs;

      // Advance timers while paused - duration should not increase
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(result.current.durationMs).toBe(pausedDuration);

      // 4. Resume recording
      act(() => {
        result.current.resumeRecording();
      });
      expect(result.current.status).toBe('recording');

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.durationMs).toBeGreaterThan(pausedDuration);

      // 5. Stop recording
      let finalResult: unknown;
      await act(async () => {
        finalResult = await result.current.stopRecording();
      });

      expect(result.current.status).toBe('stopped');
      expect(result.current.recordedBlob).not.toBeNull();
      expect(result.current.recordingResult).not.toBeNull();
      expect(finalResult).toEqual(result.current.recordingResult);

      // Verify all microphone tracks were stopped on the hardware stream
      for (const track of mockStream.getTracks()) {
        expect(track.stop).toHaveBeenCalled();
      }

      // Verify blob is preserved for caller
      expect(result.current.recordedBlob?.size).toBeGreaterThan(0);
    });

    it('cancels recording, resets duration, discards chunks, and releases tracks', async () => {
      const { result } = renderHook(() => useAudioRecorder());

      await act(async () => {
        await result.current.startRecording();
      });

      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(result.current.status).toBe('recording');

      act(() => {
        result.current.cancelRecording();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.durationMs).toBe(0);
      expect(result.current.recordedBlob).toBeNull();
      expect(result.current.recordingResult).toBeNull();

      // Hardware tracks stopped
      for (const track of mockStream.getTracks()) {
        expect(track.stop).toHaveBeenCalled();
      }
    });

    it('resetRecording clears state and allows new recording session', async () => {
      const { result } = renderHook(() => useAudioRecorder());

      await act(async () => {
        await result.current.startRecording();
      });
      await act(async () => {
        await result.current.stopRecording();
      });

      expect(result.current.status).toBe('stopped');
      expect(result.current.recordedBlob).not.toBeNull();

      act(() => {
        result.current.resetRecording();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.durationMs).toBe(0);
      expect(result.current.recordedBlob).toBeNull();
    });
  });

  describe('Unmount and cleanup', () => {
    it('stops active tracks and clears timers when component unmounts', async () => {
      const { result, unmount } = renderHook(() => useAudioRecorder());

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.status).toBe('recording');

      unmount();

      // Ensure tracks stopped on unmount
      for (const track of mockStream.getTracks()) {
        expect(track.stop).toHaveBeenCalled();
      }
    });
  });
});

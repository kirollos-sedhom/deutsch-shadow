import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useAudioRecorder,
  getPreferredMimeType,
  stopMediaStream,
  formatAudioRecorderError,
  CANDIDATE_MIME_TYPES,
  AudioRecordingResult,
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

  describe('Helper functions and candidate MIME types', () => {
    it('raw audio/aac is not advertised as a preferred candidate', () => {
      expect(CANDIDATE_MIME_TYPES).not.toContain('audio/aac');
      expect(CANDIDATE_MIME_TYPES).toContain('audio/mp4');
      expect(CANDIDATE_MIME_TYPES).toContain('audio/webm');
    });

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

    it('initially empty recorder MIME type uses the actual chunk MIME type', async () => {
      MockMediaRecorder.isTypeSupported.mockReturnValue(false); // No preferred candidate supported

      class DynamicMimeRecorder extends MockMediaRecorder {
        constructor(stream: MockMediaStream, options?: { mimeType?: string }) {
          super(stream, options);
          this.mimeType = ''; // Initially empty from browser
        }
        override stop = vi.fn(() => {
          this.state = 'inactive';
          if (this.ondataavailable) {
            this.ondataavailable({
              data: new Blob(['dynamic-slice'], { type: 'audio/mp4' }),
            });
          }
          if (this.onstop) {
            this.onstop();
          }
        });
      }
      (window as unknown as { MediaRecorder: unknown }).MediaRecorder = DynamicMimeRecorder;

      const { result } = renderHook(() => useAudioRecorder());
      await act(async () => {
        await result.current.startRecording();
      });

      let stopRes: unknown = null;
      await act(async () => {
        stopRes = await result.current.stopRecording();
      });

      expect(stopRes).not.toBeNull();
      expect((stopRes as AudioRecordingResult).mimeType).toBe('audio/mp4');
      expect(result.current.recordedBlob?.type).toBe('audio/mp4');
    });
  });

  describe('Error handling, cleanup, and edge case resilience', () => {
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

    it('error event followed by stop event does not publish a blob or overwrite error', async () => {
      let recorderInstance: MockMediaRecorder | null = null;
      class ErrorMockRecorder extends MockMediaRecorder {
        constructor(stream: MockMediaStream, options?: { mimeType?: string }) {
          super(stream, options);
          recorderInstance = this;
        }
      }
      (window as unknown as { MediaRecorder: unknown }).MediaRecorder = ErrorMockRecorder;

      const { result } = renderHook(() => useAudioRecorder());
      await act(async () => {
        await result.current.startRecording();
      });
      expect(result.current.status).toBe('recording');

      // Trigger error event, followed by stop event as per W3C specification
      act(() => {
        if (recorderInstance?.onerror) {
          const errEvent = new Event('error');
          Object.defineProperty(errEvent, 'error', {
            value: new DOMException('Hardware busy', 'NotReadableError'),
          });
          recorderInstance.onerror(errEvent);
        }
      });

      // Now simulate queued stop event that browsers emit after error
      act(() => {
        if (recorderInstance?.onstop) {
          recorderInstance.onstop();
        }
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.recordedBlob).toBeNull();
      expect(result.current.recordingResult).toBeNull();
      expect(result.current.error).toContain('Microphone is already in use');
    });

    it('synchronous exception from recorder.stop() releases tracks and leaves hook recoverable', async () => {
      class ThrowStopRecorder extends MockMediaRecorder {
        override stop = vi.fn(() => {
          throw new DOMException('Failed to stop hardware', 'InvalidStateError');
        });
      }
      (window as unknown as { MediaRecorder: unknown }).MediaRecorder = ThrowStopRecorder;

      const { result } = renderHook(() => useAudioRecorder());
      await act(async () => {
        await result.current.startRecording();
      });

      let stopRes: unknown = 'initial';
      await act(async () => {
        stopRes = await result.current.stopRecording();
      });

      expect(stopRes).toBeNull();
      expect(result.current.status).toBe('idle');
      expect(result.current.error).toContain('Failed to stop hardware');

      // Verify hardware tracks were released
      for (const track of mockStream.getTracks()) {
        expect(track.stop).toHaveBeenCalled();
      }

      // Verify hook can start a new recording cleanly (recoverable)
      ThrowStopRecorder.prototype.stop = vi.fn();
      await act(async () => {
        await result.current.startRecording();
      });
      expect(result.current.status).toBe('recording');
      expect(result.current.error).toBeNull();

      act(() => {
        result.current.cancelRecording();
      });
    });

    it('pending stop promise resolves only once on failure', async () => {
      let recorderInstance: MockMediaRecorder | null = null;
      class ManualStopRecorder extends MockMediaRecorder {
        constructor(stream: MockMediaStream, options?: { mimeType?: string }) {
          super(stream, options);
          recorderInstance = this;
        }
        override stop = vi.fn(() => {
          // Do not invoke onstop to keep promise pending
        });
      }
      (window as unknown as { MediaRecorder: unknown }).MediaRecorder = ManualStopRecorder;

      const { result } = renderHook(() => useAudioRecorder());
      await act(async () => {
        await result.current.startRecording();
      });

      let resolveCount = 0;
      let stopResult: unknown = 'unresolved';
      let stopPromise: Promise<unknown>;

      act(() => {
        stopPromise = result.current.stopRecording().then((res) => {
          resolveCount++;
          stopResult = res;
        });
      });

      // Now trigger an error while stop promise is pending
      await act(async () => {
        if (recorderInstance?.onerror) {
          recorderInstance.onerror(new Event('error'));
        }
        await stopPromise;
      });

      expect(resolveCount).toBe(1);
      expect(stopResult).toBeNull();
    });

    it('late events after cancellation cannot restore discarded recording data', async () => {
      let recorderInstance: any = null;

      class CaptureListenerRecorder extends MockMediaRecorder {
        constructor(stream: MockMediaStream, options?: { mimeType?: string }) {
          super(stream, options);
          recorderInstance = this;
        }
        override stop = vi.fn();
      }
      (window as unknown as { MediaRecorder: unknown }).MediaRecorder = CaptureListenerRecorder;

      const { result } = renderHook(() => useAudioRecorder());
      await act(async () => {
        await result.current.startRecording();
      });

      // Capture active callbacks before cancel detaches them
      const capturedOnDataAvailable = recorderInstance?.ondataavailable;
      const capturedOnStop = recorderInstance?.onstop;

      act(() => {
        result.current.cancelRecording();
      });
      expect(result.current.status).toBe('idle');

      // Simulate late events dispatched after cancellation
      act(() => {
        if (capturedOnDataAvailable) {
          capturedOnDataAvailable({ data: new Blob(['late-chunk'], { type: 'audio/webm' }) });
        }
        if (capturedOnStop) {
          capturedOnStop();
        }
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.recordedBlob).toBeNull();
      expect(result.current.recordingResult).toBeNull();
    });
  });
});

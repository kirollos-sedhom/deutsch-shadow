/**
 * Deutsch Shadow — Audio Recorder Hook
 * Manages microphone capture, MediaRecorder lifecycle, audio MIME negotiation,
 * elapsed time calculation, and resource cleanup.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'stopped';
export type MicrophonePermission = 'prompt' | 'granted' | 'denied';

export interface AudioRecordingResult {
  blob: Blob;
  durationMs: number;
  mimeType: string;
}

export interface UseAudioRecorderState {
  status: RecordingStatus;
  permission: MicrophonePermission;
  durationMs: number;
  recordedBlob: Blob | null;
  recordingResult: AudioRecordingResult | null;
  error: string | null;
  isSupported: boolean;
  mimeType: string;
}

export interface UseAudioRecorderReturn extends UseAudioRecorderState {
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<AudioRecordingResult | null>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  cancelRecording: () => void;
  resetRecording: () => void;
}

export const CANDIDATE_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
];

/**
 * Probe supported recording MIME types across browsers (WebM for Chrome/Firefox, MP4 for Safari/iOS).
 */
export function getPreferredMimeType(): string {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
    return '';
  }
  if (typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  for (const candidate of CANDIDATE_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return '';
}

/**
 * Release all hardware tracks associated with a MediaStream to extinguish browser recording indicators.
 */
export function stopMediaStream(stream: MediaStream | null): void {
  if (!stream) return;
  try {
    const tracks = stream.getTracks();
    for (const track of tracks) {
      track.stop();
    }
  } catch {
    // Ignore errors when releasing tracks
  }
}

/**
 * Translate browser DOMExceptions into actionable, friendly error messages.
 */
export function formatAudioRecorderError(err: unknown): string {
  if (!err) return 'An unknown audio recording error occurred.';

  if (err instanceof Error) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'Microphone permission was denied. Please allow microphone access in your browser settings to record.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No microphone was found on this device. Please connect a microphone and try again.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Microphone is already in use by another application or cannot be accessed.';
      case 'OverconstrainedError':
        return 'Requested microphone audio constraints could not be satisfied.';
      case 'SecurityError':
        return 'Microphone access is blocked due to security restrictions.';
      case 'TypeError':
        return 'Microphone access failed. A secure context (HTTPS or localhost) is required.';
      default:
        return err.message || 'Failed to access microphone.';
    }
  }

  return String(err);
}

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [status, setStatus] = useState<RecordingStatus>('idle');
  const [permission, setPermission] = useState<MicrophonePermission>('prompt');
  const [durationMs, setDurationMs] = useState<number>(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordingResult, setRecordingResult] = useState<AudioRecordingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string>('');

  // Hardware references
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const activeMimeRef = useRef<string>('');

  // High-resolution timing
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const accumulatedDurationRef = useRef<number>(0);

  // Promise resolution for stopRecording()
  const stopResolverRef = useRef<((result: AudioRecordingResult | null) => void) | null>(null);

  const isSupported =
    typeof window !== 'undefined' &&
    Boolean(window.navigator?.mediaDevices?.getUserMedia) &&
    typeof window.MediaRecorder !== 'undefined';

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const resetRecording = useCallback(() => {
    clearTimer();
    accumulatedDurationRef.current = 0;
    setDurationMs(0);
    setRecordedBlob(null);
    setRecordingResult(null);
    setError(null);
    setStatus('idle');
  }, [clearTimer]);

  const cancelRecording = useCallback(() => {
    clearTimer();
    accumulatedDurationRef.current = 0;
    setDurationMs(0);
    chunksRef.current = [];

    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.onstop = null;
        recorderRef.current.ondataavailable = null;
        recorderRef.current.onerror = null;
        recorderRef.current.stop();
      } catch {
        // Ignore errors during cancel stop
      }
    }
    recorderRef.current = null;

    stopMediaStream(streamRef.current);
    streamRef.current = null;

    if (stopResolverRef.current) {
      stopResolverRef.current(null);
      stopResolverRef.current = null;
    }

    setRecordedBlob(null);
    setRecordingResult(null);
    setError(null);
    setStatus('idle');
  }, [clearTimer]);

  const startRecording = useCallback(async () => {
    if (!isSupported) {
      setError('Audio recording is not supported in this browser or environment.');
      return;
    }

    // Reset previous recording state and hardware
    cancelRecording();
    setError(null);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      setPermission('granted');
    } catch (err) {
      const formatted = formatAudioRecorderError(err);
      if (
        err instanceof Error &&
        (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      ) {
        setPermission('denied');
      }
      setError(formatted);
      return;
    }

    try {
      const preferredMime = getPreferredMimeType();
      const options: MediaRecorderOptions = preferredMime ? { mimeType: preferredMime } : {};
      const recorder = new MediaRecorder(stream, options);
      recorderRef.current = recorder;

      const chosenMime = recorder.mimeType || preferredMime || 'audio/webm';
      activeMimeRef.current = chosenMime;
      setMimeType(chosenMime);
      chunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        clearTimer();
        stopMediaStream(streamRef.current);
        streamRef.current = null;
        setError('MediaRecorder encountered an unexpected recording error.');
        setStatus('idle');
        if (stopResolverRef.current) {
          stopResolverRef.current(null);
          stopResolverRef.current = null;
        }
      };

      recorder.onstop = () => {
        clearTimer();
        stopMediaStream(streamRef.current);
        streamRef.current = null;

        const finalBlob = new Blob(chunksRef.current, { type: activeMimeRef.current });
        const finalDuration = Math.round(accumulatedDurationRef.current);

        const result: AudioRecordingResult = {
          blob: finalBlob,
          durationMs: finalDuration,
          mimeType: activeMimeRef.current,
        };

        setRecordedBlob(finalBlob);
        setRecordingResult(result);
        setDurationMs(finalDuration);
        setStatus('stopped');

        if (stopResolverRef.current) {
          stopResolverRef.current(result);
          stopResolverRef.current = null;
        }
      };

      // Request timeslices every 100ms
      recorder.start(100);
      setStatus('recording');

      // Monotonic timer tracking
      startTimeRef.current = performance.now();
      accumulatedDurationRef.current = 0;
      setDurationMs(0);

      timerRef.current = setInterval(() => {
        const elapsed =
          accumulatedDurationRef.current + (performance.now() - startTimeRef.current);
        setDurationMs(Math.round(elapsed));
      }, 50);
    } catch (err) {
      stopMediaStream(stream);
      streamRef.current = null;
      recorderRef.current = null;
      setError(formatAudioRecorderError(err));
      setStatus('idle');
    }
  }, [cancelRecording, clearTimer, isSupported]);

  const pauseRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      try {
        recorderRef.current.pause();
        clearTimer();
        accumulatedDurationRef.current += performance.now() - startTimeRef.current;
        setDurationMs(Math.round(accumulatedDurationRef.current));
        setStatus('paused');
      } catch (err) {
        setError(formatAudioRecorderError(err));
      }
    }
  }, [clearTimer]);

  const resumeRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === 'paused') {
      try {
        recorderRef.current.resume();
        startTimeRef.current = performance.now();
        setStatus('recording');

        timerRef.current = setInterval(() => {
          const elapsed =
            accumulatedDurationRef.current + (performance.now() - startTimeRef.current);
          setDurationMs(Math.round(elapsed));
        }, 50);
      } catch (err) {
        setError(formatAudioRecorderError(err));
      }
    }
  }, []);

  const stopRecording = useCallback((): Promise<AudioRecordingResult | null> => {
    if (
      !recorderRef.current ||
      (recorderRef.current.state !== 'recording' && recorderRef.current.state !== 'paused')
    ) {
      return Promise.resolve(recordingResult);
    }

    if (recorderRef.current.state === 'recording') {
      accumulatedDurationRef.current += performance.now() - startTimeRef.current;
    }
    clearTimer();

    return new Promise<AudioRecordingResult | null>((resolve) => {
      stopResolverRef.current = resolve;
      try {
        recorderRef.current?.stop();
      } catch (err) {
        stopResolverRef.current = null;
        setError(formatAudioRecorderError(err));
        resolve(null);
      }
    });
  }, [clearTimer, recordingResult]);

  // Teardown hardware resources on unmount
  useEffect(() => {
    return () => {
      clearTimer();
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try {
          recorderRef.current.onstop = null;
          recorderRef.current.ondataavailable = null;
          recorderRef.current.onerror = null;
          recorderRef.current.stop();
        } catch {
          // Ignore errors during unmount stop
        }
      }
      stopMediaStream(streamRef.current);
      if (stopResolverRef.current) {
        stopResolverRef.current(null);
        stopResolverRef.current = null;
      }
    };
  }, [clearTimer]);

  return {
    status,
    permission,
    durationMs,
    recordedBlob,
    recordingResult,
    error,
    isSupported,
    mimeType,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    cancelRecording,
    resetRecording,
  };
}

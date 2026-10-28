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
];

/**
 * Probe supported recording MIME types across browsers (WebM for Chrome/Firefox, MP4 for Safari/iOS).
 * Excludes raw ADTS audio/aac because it is not containerized and is rejected by the backend.
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
  const recordingResultRef = useRef<AudioRecordingResult | null>(null);
  const isAbortedRef = useRef<boolean>(false);

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
    recordingResultRef.current = null;
    setRecordingResult(null);
    setError(null);
    setStatus('idle');
  }, [clearTimer]);

  const cancelRecording = useCallback(() => {
    isAbortedRef.current = true;
    clearTimer();
    accumulatedDurationRef.current = 0;
    setDurationMs(0);
    chunksRef.current = [];

    // Detach all listeners prior to calling stop to discard late events
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
      const resolver = stopResolverRef.current;
      stopResolverRef.current = null;
      resolver(null);
    }

    setRecordedBlob(null);
    recordingResultRef.current = null;
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
    isAbortedRef.current = false;
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

      // Prefer recorder.mimeType if set, otherwise preferredMime (or empty until chunk arrives)
      const chosenMime = recorder.mimeType || preferredMime || '';
      activeMimeRef.current = chosenMime;
      setMimeType(chosenMime);
      chunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        // Discard data if recording was aborted or cancelled
        if (isAbortedRef.current || recorderRef.current !== recorder) {
          return;
        }

        if (event.data && event.data.size > 0) {
          // If recorder.mimeType was empty initially, derive active MIME from first chunk
          if (!activeMimeRef.current && event.data.type) {
            activeMimeRef.current = event.data.type;
            setMimeType(event.data.type);
          }
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event: Event) => {
        isAbortedRef.current = true;
        clearTimer();

        // 1. Detach onstop and ondataavailable immediately so subsequent stop/dataavailable
        // events cannot publish a partial recording or overwrite the error state.
        if (recorderRef.current) {
          recorderRef.current.onstop = null;
          recorderRef.current.ondataavailable = null;
          recorderRef.current.onerror = null;
        }
        recorderRef.current = null;

        // 2. Discard any collected partial chunks
        chunksRef.current = [];

        // 3. Stop all media hardware tracks
        stopMediaStream(streamRef.current);
        streamRef.current = null;

        // 4. Extract meaningful error message if available on event.error
        const eventError = (event as { error?: unknown })?.error;
        const errorMsg = eventError
          ? formatAudioRecorderError(eventError)
          : 'MediaRecorder encountered an unexpected recording error.';

        setError(errorMsg);
        setStatus('idle');

        // 5. Settle pending stop promise with null exactly once
        if (stopResolverRef.current) {
          const resolver = stopResolverRef.current;
          stopResolverRef.current = null;
          resolver(null);
        }
      };

      recorder.onstop = () => {
        // Discard event if recording was aborted, errored, or cancelled
        if (isAbortedRef.current || recorderRef.current !== recorder) {
          return;
        }

        clearTimer();
        stopMediaStream(streamRef.current);
        streamRef.current = null;

        // Derive resolved MIME from activeMimeRef or first chunk
        const resolvedMime =
          activeMimeRef.current ||
          (chunksRef.current.length > 0 && chunksRef.current[0].type ? chunksRef.current[0].type : '');

        const finalBlob = resolvedMime
          ? new Blob(chunksRef.current, { type: resolvedMime })
          : new Blob(chunksRef.current);
        const finalDuration = Math.round(accumulatedDurationRef.current);

        const result: AudioRecordingResult = {
          blob: finalBlob,
          durationMs: finalDuration,
          mimeType: resolvedMime,
        };

        recordingResultRef.current = result;
        setRecordedBlob(finalBlob);
        setRecordingResult(result);
        setDurationMs(finalDuration);
        setStatus('stopped');

        if (stopResolverRef.current) {
          const resolver = stopResolverRef.current;
          stopResolverRef.current = null;
          resolver(result);
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
      isAbortedRef.current = true;
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
      return Promise.resolve(recordingResultRef.current);
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
        isAbortedRef.current = true;
        if (recorderRef.current) {
          recorderRef.current.onstop = null;
          recorderRef.current.ondataavailable = null;
          recorderRef.current.onerror = null;
        }
        recorderRef.current = null;
        chunksRef.current = [];
        stopMediaStream(streamRef.current);
        streamRef.current = null;

        const resolver = stopResolverRef.current;
        stopResolverRef.current = null;

        setStatus('idle');
        setError(formatAudioRecorderError(err));

        if (resolver) {
          resolver(null);
        }
      }
    });
  }, [clearTimer]);

  // Teardown hardware resources on unmount
  useEffect(() => {
    return () => {
      isAbortedRef.current = true;
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
      recorderRef.current = null;
      stopMediaStream(streamRef.current);
      streamRef.current = null;
      chunksRef.current = [];

      if (stopResolverRef.current) {
        const resolver = stopResolverRef.current;
        stopResolverRef.current = null;
        resolver(null);
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

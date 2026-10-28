/**
 * Deutsch Shadow — Recording Studio Component
 * Encapsulates microphone recording, review before upload, saved takes management,
 * and audio mutual exclusion for the active German practice clip.
 */

import {
  useState,
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
} from 'react';
import {
  Mic,
  Square,
  Play,
  Pause,
  RotateCcw,
  Check,
  X,
  Trash2,
  Star,
  AlertCircle,
  Loader2,
  Volume2,
  Radio,
} from 'lucide-react';
import {
  RecordingRead,
  SegmentRead,
  getRecordings,
  uploadRecording,
  deleteRecording,
  setActiveTake,
  getRecordingAudioUrl,
} from '../api/client';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { formatDate } from '../utils/formatters';

export interface RecordingStudioHandle {
  cancelAndDiscard: () => void;
  isBusy: () => boolean;
  isUploading: () => boolean;
  isReviewPending: () => boolean;
}

export interface RecordingStudioProps {
  segment: SegmentRead;
  isMasterPlaying: boolean;
  onStopMasterPlayback: () => void;
  onRecordingCountChange: (newCount: number) => void;
  onBusyStateChange: (isBusy: boolean, isUploading: boolean, isReviewPending: boolean) => void;
}

export const RecordingStudio = forwardRef<RecordingStudioHandle, RecordingStudioProps>(
  (
    {
      segment,
      isMasterPlaying,
      onStopMasterPlayback,
      onRecordingCountChange,
      onBusyStateChange,
    },
    ref
  ) => {
    // 1. Audio recording hook
    const {
      status,
      permission,
      durationMs,
      recordedBlob,
      error: recorderError,
      isSupported,
      startRecording,
      stopRecording,
      pauseRecording,
      resumeRecording,
      cancelRecording,
      resetRecording,
    } = useAudioRecorder();

    // 2. Saved takes state and session cache
    const [savedTakes, setSavedTakes] = useState<RecordingRead[]>([]);
    const [takesLoading, setTakesLoading] = useState(false);
    const [takesError, setTakesError] = useState<string | null>(null);
    const recordingsCache = useRef<Record<string, RecordingRead[]>>({});

    // 3. Upload & Review state
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [reviewUrl, setReviewUrl] = useState<string | null>(null);
    const [isReviewPlaying, setIsReviewPlaying] = useState(false);

    // 4. Take Playback & Delete confirmation state
    const [playingTakeId, setPlayingTakeId] = useState<string | null>(null);
    const [deleteConfirmTakeId, setDeleteConfirmTakeId] = useState<string | null>(null);
    const [isDeletingTakeId, setIsDeletingTakeId] = useState<string | null>(null);
    const [activatingTakeId, setActivatingTakeId] = useState<string | null>(null);

    // Audio elements
    const reviewAudioRef = useRef<HTMLAudioElement | null>(null);
    const takeAudioRef = useRef<HTMLAudioElement | null>(null);

    // Derived busy indicators
    const isRecording = status === 'recording' || status === 'paused';
    const isReviewPending = status === 'stopped' && recordedBlob !== null;
    const isBusy = isRecording || isReviewPending || isUploading;

    const isBusyRef = useRef(false);
    const isUploadingRef = useRef(false);
    const isReviewPendingRef = useRef(false);

    isBusyRef.current = isBusy;
    isUploadingRef.current = isUploading;
    isReviewPendingRef.current = isReviewPending;

    // Report busy state up to ShadowingPlayer for reactive UI disabling
    useEffect(() => {
      onBusyStateChange(isBusy, isUploading, isReviewPending);
    }, [isBusy, isUploading, isReviewPending, onBusyStateChange]);

    // Handle master audio mutual exclusion
    useEffect(() => {
      if (isMasterPlaying) {
        if (reviewAudioRef.current && !reviewAudioRef.current.paused) {
          reviewAudioRef.current.pause();
          setIsReviewPlaying(false);
        }
        if (takeAudioRef.current && !takeAudioRef.current.paused) {
          takeAudioRef.current.pause();
          setPlayingTakeId(null);
        }
      }
    }, [isMasterPlaying]);

    // Manage Review Object URL with proper cleanup
    useEffect(() => {
      if (recordedBlob && status === 'stopped') {
        const url = URL.createObjectURL(recordedBlob);
        setReviewUrl(url);
        return () => {
          URL.revokeObjectURL(url);
          setReviewUrl(null);
          setIsReviewPlaying(false);
        };
      } else {
        setReviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
        setIsReviewPlaying(false);
      }
    }, [recordedBlob, status]);

    // Fetch or restore saved takes when segment changes
    useEffect(() => {
      let isMounted = true;
      const segmentId = segment.id;

      // Check in-memory session cache first
      if (recordingsCache.current[segmentId]) {
        setSavedTakes(recordingsCache.current[segmentId]);
        setTakesLoading(false);
        setTakesError(null);
        return;
      }

      if (segment.recordings_count > 0) {
        setTakesLoading(true);
      }
      setTakesError(null);

      getRecordings(segmentId)
        .then((takes) => {
          if (isMounted) {
            recordingsCache.current[segmentId] = takes;
            if (takes.length > 0) {
              setSavedTakes(takes);
            }
            if (takes.length !== segment.recordings_count) {
              onRecordingCountChange(takes.length);
            }
          }
        })
        .catch((err: unknown) => {
          if (isMounted) {
            setTakesError(err instanceof Error ? err.message : 'Failed to load saved takes');
          }
        })
        .finally(() => {
          if (isMounted && segment.recordings_count > 0) {
            setTakesLoading(false);
          }
        });

      return () => {
        isMounted = false;
        // Pause any playing audio on segment change
        if (reviewAudioRef.current) reviewAudioRef.current.pause();
        if (takeAudioRef.current) takeAudioRef.current.pause();
        setPlayingTakeId(null);
        setIsReviewPlaying(false);
      };
    }, [segment.id, segment.recordings_count, onRecordingCountChange]);

    // Imperative handle for parent to discard in-flight or unsaved take & query real-time busy state
    useImperativeHandle(
      ref,
      () => ({
        cancelAndDiscard: () => {
          cancelRecording();
          resetRecording();
          setUploadError(null);
          if (reviewAudioRef.current) {
            reviewAudioRef.current.pause();
          }
          if (takeAudioRef.current) {
            takeAudioRef.current.pause();
          }
          setPlayingTakeId(null);
          setIsReviewPlaying(false);
        },
        isBusy: () => isBusyRef.current,
        isUploading: () => isUploadingRef.current,
        isReviewPending: () => isReviewPendingRef.current,
      }),
      [cancelRecording, resetRecording]
    );

    // Recording Controls Handlers
    const handleStartRecording = async () => {
      onStopMasterPlayback();
      if (takeAudioRef.current) takeAudioRef.current.pause();
      setPlayingTakeId(null);
      setUploadError(null);
      await startRecording();
    };

    const handleStopRecording = async () => {
      await stopRecording();
    };

    const handleCancelRecording = () => {
      cancelRecording();
      setUploadError(null);
    };

    const handleDiscardReview = () => {
      resetRecording();
      setUploadError(null);
    };

    const handleRerecord = async () => {
      resetRecording();
      setUploadError(null);
      onStopMasterPlayback();
      await startRecording();
    };

    // Review Playback Handlers
    const handleToggleReviewPlayback = () => {
      if (!reviewAudioRef.current || !reviewUrl) return;
      const audio = reviewAudioRef.current;

      if (isReviewPlaying) {
        audio.pause();
        setIsReviewPlaying(false);
      } else {
        onStopMasterPlayback();
        if (takeAudioRef.current) {
          takeAudioRef.current.pause();
          setPlayingTakeId(null);
        }
        audio
          .play()
          .then(() => setIsReviewPlaying(true))
          .catch(() => setIsReviewPlaying(false));
      }
    };

    // Upload Handler
    const handleSaveTake = async () => {
      if (!recordedBlob) return;
      if (durationMs < 50 || recordedBlob.size === 0) {
        setUploadError('Recording is too short (minimum 50ms required).');
        return;
      }

      setIsUploading(true);
      setUploadError(null);

      try {
        const newTake = await uploadRecording(segment.id, recordedBlob, durationMs);

        // Update local list & cache (newly created take is automatically active)
        const updatedTakes = [
          ...savedTakes.map((t) => ({ ...t, is_active: false })),
          newTake,
        ];
        recordingsCache.current[segment.id] = updatedTakes;
        setSavedTakes(updatedTakes);
        onRecordingCountChange(updatedTakes.length);

        // Reset recorder state on success
        resetRecording();
      } catch (err: unknown) {
        // Preserve recordedBlob on failure so the learner can retry
        setUploadError(err instanceof Error ? err.message : 'Failed to save recording');
      } finally {
        setIsUploading(false);
      }
    };

    // Saved Take Playback
    const handleTogglePlayTake = (take: RecordingRead) => {
      if (!takeAudioRef.current) return;
      const audio = takeAudioRef.current;

      if (playingTakeId === take.id) {
        audio.pause();
        setPlayingTakeId(null);
      } else {
        onStopMasterPlayback();
        if (reviewAudioRef.current) {
          reviewAudioRef.current.pause();
          setIsReviewPlaying(false);
        }
        audio.src = getRecordingAudioUrl(take.id);
        audio
          .play()
          .then(() => setPlayingTakeId(take.id))
          .catch((err) => {
            console.error('Failed to play user take:', err);
            setPlayingTakeId(null);
          });
      }
    };

    // Set Active Take
    const handleSetActive = async (takeId: string) => {
      setActivatingTakeId(takeId);
      try {
        const updated = await setActiveTake(takeId);
        const updatedTakes = savedTakes.map((t) => ({
          ...t,
          is_active: t.id === updated.id,
        }));
        recordingsCache.current[segment.id] = updatedTakes;
        setSavedTakes(updatedTakes);
      } catch (err: unknown) {
        setTakesError(err instanceof Error ? err.message : 'Failed to designate active take');
      } finally {
        setActivatingTakeId(null);
      }
    };

    // Delete Take
    const handleDeleteTake = async (takeId: string) => {
      setIsDeletingTakeId(takeId);
      try {
        await deleteRecording(takeId);
        // Refresh fresh takes from server to capture automatic fallback active take promotion
        const freshTakes = await getRecordings(segment.id);
        recordingsCache.current[segment.id] = freshTakes;
        setSavedTakes(freshTakes);
        onRecordingCountChange(freshTakes.length);
        setDeleteConfirmTakeId(null);
      } catch (err: unknown) {
        setTakesError(err instanceof Error ? err.message : 'Failed to delete recording');
      } finally {
        setIsDeletingTakeId(null);
      }
    };

    return (
      <section className="recording-studio-section" aria-label="Microphone Recording Studio">
        {/* Hidden Audio Elements for Review & Saved Takes */}
        {reviewUrl && (
          <audio
            ref={reviewAudioRef}
            src={reviewUrl}
            onEnded={() => setIsReviewPlaying(false)}
            onPause={() => setIsReviewPlaying(false)}
            preload="auto"
          />
        )}
        <audio
          ref={takeAudioRef}
          onEnded={() => setPlayingTakeId(null)}
          onPause={() => setPlayingTakeId(null)}
          preload="none"
        />

        {/* Section Header */}
        <div className="recording-studio-header">
          <div className="recording-studio-title-group">
            <Mic size={16} className="recording-studio-icon" />
            <h3 className="recording-studio-title">Your Vocal Practice</h3>
          </div>
          <span className="recording-takes-count-badge">
            {savedTakes.length} {savedTakes.length === 1 ? 'take' : 'takes'}
          </span>
        </div>

        {/* Browser Support Check */}
        {!isSupported && (
          <div className="recording-alert recording-alert-warning" role="alert">
            <AlertCircle size={15} />
            <span>Audio recording is not supported in this browser or environment.</span>
          </div>
        )}

        {/* Permission Denied Warning */}
        {permission === 'denied' && (
          <div className="recording-alert recording-alert-danger" role="alert">
            <AlertCircle size={15} />
            <div>
              <strong>Microphone Access Denied</strong>
              <p>Please grant microphone permissions in your browser address bar to record your voice.</p>
            </div>
          </div>
        )}

        {/* Recorder Error Banner */}
        {recorderError && (
          <div className="recording-alert recording-alert-danger" role="alert">
            <AlertCircle size={15} />
            <span>{recorderError}</span>
          </div>
        )}

        {/* Upload Error Banner */}
        {uploadError && (
          <div className="recording-alert recording-alert-danger" role="alert">
            <AlertCircle size={15} />
            <div style={{ flex: 1 }}>
              <span>{uploadError}</span>
            </div>
          </div>
        )}

        {/* --- RECORDING VIEW CONTAINER --- */}
        <div className="recording-card">
          {/* STATE 1: IDLE */}
          {status === 'idle' && (
            <div className="rec-idle-box">
              <button
                className="btn btn-record-primary"
                onClick={handleStartRecording}
                disabled={!isSupported}
                aria-label="Start recording your voice"
              >
                <div className="rec-dot-icon" />
                <Mic size={18} />
                <span>Record Your Voice</span>
              </button>
              <p className="rec-hint">Listen to the German audio, then record yourself shadowing it.</p>
            </div>
          )}

          {/* STATE 2: RECORDING OR PAUSED */}
          {(status === 'recording' || status === 'paused') && (
            <div className="rec-active-box" data-testid="rec-active-box">
              <div className="rec-status-row">
                <div className="rec-indicator-group">
                  <span className={`rec-pulsing-badge ${status === 'paused' ? 'paused' : ''}`}>
                    <Radio size={12} className="spin-slow" />
                    <span>{status === 'paused' ? 'PAUSED' : 'REC'}</span>
                  </span>
                  <span className="rec-timer-display" data-testid="rec-timer-display">
                    {(durationMs / 1000).toFixed(1)}s
                  </span>
                </div>
              </div>

              <div className="rec-controls-row">
                {status === 'recording' ? (
                  <button
                    className="btn btn-secondary btn-sm rec-btn"
                    onClick={pauseRecording}
                    aria-label="Pause recording"
                  >
                    <Pause size={14} />
                    <span>Pause</span>
                  </button>
                ) : (
                  <button
                    className="btn btn-secondary btn-sm rec-btn"
                    onClick={resumeRecording}
                    aria-label="Resume recording"
                  >
                    <Play size={14} />
                    <span>Resume</span>
                  </button>
                )}

                <button
                  className="btn btn-primary btn-sm rec-btn rec-btn-stop"
                  onClick={handleStopRecording}
                  aria-label="Stop recording and review"
                >
                  <Square size={14} />
                  <span>Stop &amp; Review</span>
                </button>

                <button
                  className="btn btn-secondary btn-sm rec-btn rec-btn-cancel"
                  onClick={handleCancelRecording}
                  aria-label="Cancel and discard recording"
                >
                  <X size={14} />
                  <span>Cancel</span>
                </button>
              </div>
            </div>
          )}

          {/* STATE 3: REVIEW BEFORE SAVE */}
          {isReviewPending && (
            <div className="rec-review-box" data-testid="rec-review-box">
              <div className="rec-review-header">
                <div className="rec-review-meta">
                  <span className="badge badge-success">Take Complete</span>
                  <span className="rec-review-duration">Duration: {(durationMs / 1000).toFixed(1)}s</span>
                </div>

                <button
                  className="btn btn-secondary btn-sm rec-preview-play-btn"
                  onClick={handleToggleReviewPlayback}
                  aria-label={isReviewPlaying ? 'Pause take preview' : 'Play take preview'}
                >
                  {isReviewPlaying ? <Pause size={14} /> : <Play size={14} />}
                  <span>{isReviewPlaying ? 'Pause Preview' : 'Listen Preview'}</span>
                </button>
              </div>

              <div className="rec-review-actions-row">
                <button
                  className="btn btn-primary btn-sm rec-action-btn"
                  onClick={handleSaveTake}
                  disabled={isUploading}
                  aria-label="Save vocal take"
                >
                  {isUploading ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                  <span>{isUploading ? 'Saving Take...' : 'Save Take'}</span>
                </button>

                <button
                  className="btn btn-secondary btn-sm rec-action-btn"
                  onClick={handleRerecord}
                  disabled={isUploading}
                  aria-label="Re-record take"
                >
                  <RotateCcw size={14} />
                  <span>Re-record</span>
                </button>

                <button
                  className="btn btn-secondary btn-sm rec-action-btn"
                  onClick={handleDiscardReview}
                  disabled={isUploading}
                  aria-label="Discard take"
                >
                  <Trash2 size={14} />
                  <span>Discard</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* --- SAVED TAKES LIST --- */}
        <div className="saved-takes-container">
          <div className="saved-takes-header">
            <h4 className="saved-takes-title">Saved Takes</h4>
            {takesLoading && <Loader2 size={13} className="spin" />}
          </div>

          {takesError && (
            <div className="recording-alert recording-alert-danger" role="alert">
              <AlertCircle size={14} />
              <span>{takesError}</span>
            </div>
          )}

          {!takesLoading && savedTakes.length === 0 && (
            <div className="saved-takes-empty">
              <p>No saved takes for this clip yet.</p>
            </div>
          )}

          {savedTakes.length > 0 && (
            <div className="saved-takes-list" role="list" aria-label="Saved vocal takes">
              {savedTakes.map((take) => {
                const isPlayingThis = playingTakeId === take.id;
                const isConfirmingDelete = deleteConfirmTakeId === take.id;
                const isDeletingThis = isDeletingTakeId === take.id;
                const isActivatingThis = activatingTakeId === take.id;

                return (
                  <div
                    key={take.id}
                    className={`saved-take-card ${take.is_active ? 'active-take' : ''}`}
                    role="listitem"
                    data-testid={`saved-take-${take.id}`}
                  >
                    <div className="saved-take-info">
                      <div className="saved-take-title-row">
                        <span className="saved-take-label">Take #{take.take_number}</span>
                        {take.is_active && (
                          <span className="badge badge-active-take" title="Active take for shadowing comparison">
                            <Star size={10} fill="currentColor" />
                            <span>Active Take</span>
                          </span>
                        )}
                      </div>

                      <div className="saved-take-meta-row">
                        <span>{(take.duration_ms / 1000).toFixed(1)}s</span>
                        <span>•</span>
                        <span>{formatDate(take.created_at)}</span>
                      </div>
                    </div>

                    <div className="saved-take-actions">
                      {/* Play/Pause Take Button */}
                      <button
                        className="btn btn-secondary btn-sm take-action-btn"
                        onClick={() => handleTogglePlayTake(take)}
                        aria-label={isPlayingThis ? `Pause Take #${take.take_number}` : `Play Take #${take.take_number}`}
                        title={isPlayingThis ? 'Pause take' : 'Play take'}
                      >
                        {isPlayingThis ? <Pause size={14} /> : <Volume2 size={14} />}
                      </button>

                      {/* Set Active Button */}
                      {!take.is_active && (
                        <button
                          className="btn btn-secondary btn-sm take-action-btn"
                          onClick={() => handleSetActive(take.id)}
                          disabled={isActivatingThis}
                          aria-label={`Designate Take #${take.take_number} as active`}
                          title="Set as active take"
                        >
                          {isActivatingThis ? <Loader2 size={12} className="spin" /> : <Star size={12} />}
                          <span>Set Active</span>
                        </button>
                      )}

                      {/* Inline Delete Confirmation */}
                      {isConfirmingDelete ? (
                        <div className="take-delete-confirm-group">
                          <button
                            className="btn btn-danger btn-sm take-confirm-btn"
                            onClick={() => handleDeleteTake(take.id)}
                            disabled={isDeletingThis}
                            aria-label={`Confirm delete Take #${take.take_number}`}
                          >
                            {isDeletingThis ? <Loader2 size={12} className="spin" /> : <span>Delete</span>}
                          </button>
                          <button
                            className="btn btn-secondary btn-sm take-confirm-btn"
                            onClick={() => setDeleteConfirmTakeId(null)}
                            disabled={isDeletingThis}
                            aria-label="Cancel deletion"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ) : (
                        <button
                          className="btn btn-secondary btn-sm take-action-btn text-danger"
                          onClick={() => setDeleteConfirmTakeId(take.id)}
                          aria-label={`Delete Take #${take.take_number}`}
                          title="Delete take"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    );
  }
);

RecordingStudio.displayName = 'RecordingStudio';

import React, { useState, useEffect, useRef } from 'react';
import { Upload, X, FileAudio, FileVideo, AlertCircle, Loader2 } from 'lucide-react';
import { WhisperModelTier } from '../api/client';

interface ImportModalProps {
  isOpen: boolean;
  models: WhisperModelTier[];
  recommendedModel: string;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (file: File, title: string, model: string, signal?: AbortSignal) => Promise<void>;
  isCloudMode?: boolean;
}

const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.mp4', '.aac', '.ogg', '.flac', '.webm', '.mkv'];

export const ImportModal: React.FC<ImportModalProps> = ({
  isOpen,
  models,
  recommendedModel,
  isSubmitting,
  onClose,
  onSubmit,
  isCloudMode = false,
}) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [customTitle, setCustomTitle] = useState('');
  const [selectedModel, setSelectedModel] = useState<string>(
    isCloudMode ? 'tiny' : recommendedModel || 'base'
  );
  const [isDragging, setIsDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (isCloudMode) {
      setSelectedModel('tiny');
    } else if (recommendedModel) {
      setSelectedModel(recommendedModel);
    }
  }, [isCloudMode, recommendedModel]);

  if (!isOpen) return null;

  const handleFileChange = (file: File | null) => {
    if (!file) return;
    setLocalError(null);

    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      setLocalError(`Unsupported format "${ext}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
      return;
    }

    setSelectedFile(file);
    if (!customTitle) {
      const nameWithoutExt = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
      setCustomTitle(nameWithoutExt);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileChange(e.dataTransfer.files[0]);
    }
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setLocalError(null);
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setLocalError('Please select an audio or video file to import.');
      return;
    }

    setLocalError(null);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      await onSubmit(selectedFile, customTitle, selectedModel, controller.signal);
      // Reset form on success
      setSelectedFile(null);
      setCustomTitle('');
      abortControllerRef.current = null;
      onClose();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Upload cancelled by user
        return;
      }
      setLocalError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      abortControllerRef.current = null;
    }
  };

  const isVideo = selectedFile?.name.match(/\.(mp4|webm|mkv)$/i);

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Import German Media</h3>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleCancel}
            aria-label="Close modal"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {localError && (
              <div className="alert-banner alert-error" role="alert">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <AlertCircle size={16} />
                  <span>{localError}</span>
                </div>
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Audio / Video File</label>
              <div
                className={`dropzone ${isDragging ? 'active' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                tabIndex={0}
                role="button"
                aria-label="Upload file area"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
                }}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  style={{ display: 'none' }}
                  accept={SUPPORTED_EXTENSIONS.join(',')}
                  onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
                />

                {selectedFile ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                    {isVideo ? <FileVideo size={36} color="var(--primary)" /> : <FileAudio size={36} color="var(--primary)" />}
                    <div style={{ fontWeight: 600, fontSize: '13px', wordBreak: 'break-all' }}>{selectedFile.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB • Tap to replace
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                    <Upload size={28} color="var(--text-muted)" />
                    <div style={{ fontWeight: 500, fontSize: '13px' }}>
                      Choose a file or drag here
                    </div>
                    <div className="form-hint">
                      MP3, WAV, M4A, MP4, AAC, OGG, FLAC, WEBM, MKV
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="project-title">
                Project Title (optional)
              </label>
              <input
                id="project-title"
                type="text"
                className="form-input"
                placeholder="e.g. Tagesschau 100 Sekunden"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                disabled={isSubmitting}
              />
              <div className="form-hint">Defaults to the media filename if left empty.</div>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="whisper-model">
                Whisper Model Tier
              </label>
              <select
                id="whisper-model"
                className="form-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isSubmitting || isCloudMode}
              >
                {models.length > 0 ? (
                  models.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name.toUpperCase()} ({m.size_mb} MB) {m.name === recommendedModel ? '— Recommended' : ''}
                    </option>
                  ))
                ) : isCloudMode ? (
                  <option value="tiny">TINY (75 MB) — Recommended</option>
                ) : (
                  <>
                    <option value="tiny">TINY (75 MB)</option>
                    <option value="base">BASE (145 MB) — Recommended</option>
                    <option value="small">SMALL (480 MB)</option>
                    <option value="medium">MEDIUM (1500 MB)</option>
                  </>
                )}
              </select>
              <div className="form-hint">
                {isCloudMode
                  ? 'Inference runs on the cloud server using faster-whisper (tiny) with int8 CPU quantization.'
                  : 'Inference runs locally using faster-whisper with int8 CPU quantization.'}
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!selectedFile || isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={14} className="spin" />
                  <span>Uploading File...</span>
                </>
              ) : (
                <>
                  <Upload size={14} />
                  <span>Start Import</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

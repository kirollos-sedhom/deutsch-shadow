import React, { useState, useRef } from 'react';
import { Upload, X, FileAudio, FileVideo, AlertCircle, Loader2 } from 'lucide-react';
import { WhisperModelTier } from '../api/client';

interface ImportModalProps {
  isOpen: boolean;
  models: WhisperModelTier[];
  recommendedModel: string;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (file: File, title: string, model: string) => Promise<void>;
}

const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.mp4', '.aac', '.ogg', '.flac', '.webm', '.mkv'];

export const ImportModal: React.FC<ImportModalProps> = ({
  isOpen,
  models,
  recommendedModel,
  isSubmitting,
  onClose,
  onSubmit,
}) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [customTitle, setCustomTitle] = useState('');
  const [selectedModel, setSelectedModel] = useState<string>(recommendedModel || 'base');
  const [isDragging, setIsDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      // Default title without extension
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setLocalError('Please select an audio or video file to import.');
      return;
    }

    try {
      await onSubmit(selectedFile, customTitle, selectedModel);
      // reset form
      setSelectedFile(null);
      setCustomTitle('');
      onClose();
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : 'Import failed');
    }
  };

  const isVideo = selectedFile?.name.match(/\.(mp4|webm|mkv)$/i);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Import German Media</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={isSubmitting}>
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {localError && (
              <div className="alert-banner alert-error">
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
                    <div style={{ fontWeight: 600, fontSize: '14px' }}>{selectedFile.name}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB • Click or drop another file to replace
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                    <Upload size={32} color="var(--text-muted)" />
                    <div style={{ fontWeight: 500, fontSize: '13px' }}>
                      Click to choose a file or drag and drop here
                    </div>
                    <div className="form-hint">
                      Supported formats: MP3, WAV, M4A, MP4, AAC, OGG, FLAC, WEBM, MKV
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
                Whisper Transcription Model
              </label>
              <select
                id="whisper-model"
                className="form-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isSubmitting}
              >
                {models.length > 0 ? (
                  models.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name.toUpperCase()} ({m.size_mb} MB) — {m.description}
                      {m.name === recommendedModel ? ' [Recommended]' : ''}
                    </option>
                  ))
                ) : (
                  <>
                    <option value="tiny">TINY (75 MB) — Fastest, lowest memory</option>
                    <option value="base">BASE (145 MB) — Balanced for German [Recommended]</option>
                    <option value="small">SMALL (480 MB) — Higher accuracy</option>
                    <option value="medium">MEDIUM (1500 MB) — Very high accuracy</option>
                  </>
                )}
              </select>
              <div className="form-hint">
                Inference runs locally using faster-whisper with int8 CPU quantization.
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
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
                  <span>Importing & Processing...</span>
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

/**
 * Deutsch Shadow — Typed REST API Client
 * Fully aligned with FastAPI backend Pydantic schemas.
 */

export interface ProjectSettingsRead {
  playback_speed: number;
  auto_pause_multiplier: number;
  blind_mode_default: boolean;
}

export interface ProjectSummary {
  id: string;
  title: string;
  original_filename: string;
  media_type: string;
  duration_seconds: number;
  whisper_model: string;
  status: 'pending' | 'processing' | 'ready' | 'failed' | string;
  error_message?: string | null;
  segments_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectDetail {
  id: string;
  title: string;
  original_filename: string;
  media_type: string;
  source_file_path?: string | null;
  master_audio_path?: string | null;
  duration_seconds: number;
  whisper_model: string;
  status: 'pending' | 'processing' | 'ready' | 'failed' | string;
  error_message?: string | null;
  segments_count: number;
  settings?: ProjectSettingsRead | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectImportResponse {
  project_id: string;
  title: string;
  status: string;
  message: string;
}

export interface SegmentRead {
  id: string;
  project_id: string;
  sequence_index: number;
  start_time_ms: number;
  end_time_ms: number;
  duration_ms: number;
  text: string;
  raw_transcript: string;
  is_edited: boolean;
  recordings_count: number;
  created_at: string;
  updated_at: string;
}

export interface SystemCapabilities {
  cpu_physical_cores: number;
  cpu_logical_cores: number;
  ram_total_gb: number;
  cuda_available: boolean;
  cuda_device_name?: string | null;
  ffmpeg_available: boolean;
  ffmpeg_path?: string | null;
  ffmpeg_version?: string | null;
  recommended_model: string;
}

export interface WhisperModelTier {
  name: string;
  size_mb: number;
  description: string;
  is_downloaded: boolean;
  is_recommended: boolean;
}

const BASE_URL = '/api';

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let errorDetail = `Request failed with status ${res.status}`;
    try {
      const data = await res.json();
      if (data && data.detail) {
        errorDetail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
      }
    } catch {
      // response was not JSON
    }
    throw new Error(errorDetail);
  }

  if (res.status === 204) {
    return {} as T;
  }

  return res.json();
}

export async function getProjects(): Promise<ProjectSummary[]> {
  const res = await fetch(`${BASE_URL}/projects`);
  return handleResponse<ProjectSummary[]>(res);
}

export async function getProject(id: string): Promise<ProjectDetail> {
  const res = await fetch(`${BASE_URL}/projects/${encodeURIComponent(id)}`);
  return handleResponse<ProjectDetail>(res);
}

export async function importProject(
  file: File,
  title?: string,
  whisperModel: string = 'base',
  signal?: AbortSignal
): Promise<ProjectImportResponse> {
  const formData = new FormData();
  formData.append('file', file);
  if (title && title.trim()) {
    formData.append('title', title.trim());
  }
  formData.append('whisper_model', whisperModel);
  formData.append('auto_process', 'true');

  const res = await fetch(`${BASE_URL}/projects/import`, {
    method: 'POST',
    body: formData,
    signal,
  });
  return handleResponse<ProjectImportResponse>(res);
}

export async function processProject(id: string): Promise<ProjectDetail> {
  const res = await fetch(`${BASE_URL}/projects/${encodeURIComponent(id)}/process`, {
    method: 'POST',
  });
  return handleResponse<ProjectDetail>(res);
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await handleResponse<void>(res);
}

export async function getProjectSegments(id: string): Promise<SegmentRead[]> {
  const res = await fetch(`${BASE_URL}/projects/${encodeURIComponent(id)}/segments`);
  return handleResponse<SegmentRead[]>(res);
}

export async function getSystemCapabilities(): Promise<SystemCapabilities> {
  const res = await fetch(`${BASE_URL}/system/capabilities`);
  return handleResponse<SystemCapabilities>(res);
}

export async function getWhisperModels(): Promise<WhisperModelTier[]> {
  const res = await fetch(`${BASE_URL}/system/models`);
  return handleResponse<WhisperModelTier[]>(res);
}

export function getMasterAudioUrl(id: string): string {
  return `${BASE_URL}/media/${encodeURIComponent(id)}/master`;
}

export interface SegmentUpdatePayload {
  text?: string;
  start_time_ms?: number;
  end_time_ms?: number;
}

export async function updateSegment(
  segmentId: string,
  payload: SegmentUpdatePayload
): Promise<SegmentRead> {
  const res = await fetch(`${BASE_URL}/segments/${encodeURIComponent(segmentId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return handleResponse<SegmentRead>(res);
}

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
  whisper_model?: string;
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

export interface RecordingRead {
  id: string;
  segment_id: string;
  take_number: number;
  duration_ms: number;
  is_active: boolean;
  created_at: string;
  audio_url: string;
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

export interface AuthStatusResponse {
  auth_required: boolean;
  authenticated: boolean;
}

export interface AuthActionResponse {
  success: boolean;
  message: string;
}

const BASE_URL = '/api';

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export function getUnauthorizedHandler(): UnauthorizedHandler | null {
  return unauthorizedHandler;
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method || 'GET').toUpperCase();
  const headers = new Headers(init?.headers);

  // Attach X-Requested-With: Fetch on state-changing methods for CSRF protection
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (!headers.has('X-Requested-With')) {
      headers.set('X-Requested-With', 'Fetch');
    }
  }

  const response = await fetch(input, {
    ...init,
    headers,
    credentials: 'include',
  });

  // Intercept 401 Unauthorized for protected endpoints
  if (
    response.status === 401 &&
    !input.endsWith('/auth/login') &&
    !input.endsWith('/auth/status')
  ) {
    if (unauthorizedHandler) {
      unauthorizedHandler();
    }
  }

  return response;
}

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

export async function getAuthStatus(): Promise<AuthStatusResponse> {
  const res = await apiFetch(`${BASE_URL}/auth/status`);
  return handleResponse<AuthStatusResponse>(res);
}

export async function login(password: string): Promise<AuthActionResponse> {
  const res = await apiFetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });
  return handleResponse<AuthActionResponse>(res);
}

export async function logout(): Promise<AuthActionResponse> {
  const res = await apiFetch(`${BASE_URL}/auth/logout`, {
    method: 'POST',
  });
  return handleResponse<AuthActionResponse>(res);
}

export async function getProjects(): Promise<ProjectSummary[]> {
  const res = await apiFetch(`${BASE_URL}/projects`);
  return handleResponse<ProjectSummary[]>(res);
}

export async function getProject(id: string): Promise<ProjectDetail> {
  const res = await apiFetch(`${BASE_URL}/projects/${encodeURIComponent(id)}`);
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

  const res = await apiFetch(`${BASE_URL}/projects/import`, {
    method: 'POST',
    body: formData,
    signal,
  });
  return handleResponse<ProjectImportResponse>(res);
}

export async function processProject(id: string): Promise<ProjectDetail> {
  const res = await apiFetch(`${BASE_URL}/projects/${encodeURIComponent(id)}/process`, {
    method: 'POST',
  });
  return handleResponse<ProjectDetail>(res);
}

export async function deleteProject(id: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await handleResponse<void>(res);
}

export async function getProjectSegments(id: string): Promise<SegmentRead[]> {
  const res = await apiFetch(`${BASE_URL}/projects/${encodeURIComponent(id)}/segments`);
  return handleResponse<SegmentRead[]>(res);
}

export async function getSystemCapabilities(): Promise<SystemCapabilities> {
  const res = await apiFetch(`${BASE_URL}/system/capabilities`);
  return handleResponse<SystemCapabilities>(res);
}

export async function getWhisperModels(): Promise<WhisperModelTier[]> {
  const res = await apiFetch(`${BASE_URL}/system/models`);
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
  const res = await apiFetch(`${BASE_URL}/segments/${encodeURIComponent(segmentId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return handleResponse<SegmentRead>(res);
}

export function getRecordingAudioUrl(recordingId: string): string {
  return `${BASE_URL}/recordings/${encodeURIComponent(recordingId)}/audio`;
}

export async function getRecordings(segmentId: string): Promise<RecordingRead[]> {
  const res = await apiFetch(`${BASE_URL}/segments/${encodeURIComponent(segmentId)}/recordings`);
  return handleResponse<RecordingRead[]>(res);
}

export function getAudioExtensionFromMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('mp4') || normalized.includes('m4a')) return 'm4a';
  return 'webm';
}

export async function uploadRecording(
  segmentId: string,
  audioBlob: Blob,
  durationMs?: number,
  signal?: AbortSignal
): Promise<RecordingRead> {
  const formData = new FormData();
  const ext = getAudioExtensionFromMime(audioBlob.type);
  const filename = `take_${Date.now()}.${ext}`;
  const file =
    typeof File !== 'undefined' && !(audioBlob instanceof File)
      ? new File([audioBlob], filename, { type: audioBlob.type })
      : audioBlob;

  formData.append('file', file, filename);
  if (durationMs !== undefined && durationMs > 0) {
    formData.append('duration_ms', Math.round(durationMs).toString());
  }

  const res = await apiFetch(`${BASE_URL}/segments/${encodeURIComponent(segmentId)}/recordings`, {
    method: 'POST',
    body: formData,
    signal,
  });
  return handleResponse<RecordingRead>(res);
}

export async function setActiveTake(recordingId: string): Promise<RecordingRead> {
  const res = await apiFetch(`${BASE_URL}/recordings/${encodeURIComponent(recordingId)}/active`, {
    method: 'PATCH',
  });
  return handleResponse<RecordingRead>(res);
}

export async function deleteRecording(recordingId: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/recordings/${encodeURIComponent(recordingId)}`, {
    method: 'DELETE',
  });
  await handleResponse<void>(res);
}

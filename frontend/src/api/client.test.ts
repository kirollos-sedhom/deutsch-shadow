import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getRecordings,
  uploadRecording,
  setActiveTake,
  deleteRecording,
  getRecordingAudioUrl,
  getAudioExtensionFromMime,
  getAuthStatus,
  login,
  logout,
  apiFetch,
  setUnauthorizedHandler,
  RecordingRead,
  AuthStatusResponse,
  AuthActionResponse,
} from './client';

describe('Recording API Client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setUnauthorizedHandler(null);
  });

  describe('getRecordingAudioUrl', () => {
    it('constructs the correct streaming audio endpoint URL', () => {
      const url = getRecordingAudioUrl('rec-123/special');
      expect(url).toBe('/api/recordings/rec-123%2Fspecial/audio');
    });
  });

  describe('getAudioExtensionFromMime', () => {
    it('maps webm variants to webm', () => {
      expect(getAudioExtensionFromMime('audio/webm')).toBe('webm');
      expect(getAudioExtensionFromMime('audio/webm;codecs=opus')).toBe('webm');
    });

    it('maps wav to wav', () => {
      expect(getAudioExtensionFromMime('audio/wav')).toBe('wav');
      expect(getAudioExtensionFromMime('audio/x-wav')).toBe('wav');
    });

    it('maps ogg to ogg', () => {
      expect(getAudioExtensionFromMime('audio/ogg')).toBe('ogg');
      expect(getAudioExtensionFromMime('audio/ogg;codecs=opus')).toBe('ogg');
    });

    it('maps mp4 and m4a variants to m4a', () => {
      expect(getAudioExtensionFromMime('audio/mp4')).toBe('m4a');
      expect(getAudioExtensionFromMime('audio/m4a')).toBe('m4a');
    });

    it('defaults to webm for unrecognized or empty mime types', () => {
      expect(getAudioExtensionFromMime('')).toBe('webm');
      expect(getAudioExtensionFromMime('application/octet-stream')).toBe('webm');
    });
  });

  describe('getRecordings', () => {
    it('fetches list of recordings for a segment with credentials included', async () => {
      const mockRecordings: RecordingRead[] = [
        {
          id: 'rec-1',
          segment_id: 'seg-100',
          take_number: 1,
          duration_ms: 1250,
          is_active: true,
          created_at: '2026-10-28T12:00:00Z',
          audio_url: '/api/recordings/rec-1/audio',
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockRecordings,
      });

      const res = await getRecordings('seg-100');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/segments/seg-100/recordings',
        expect.objectContaining({
          credentials: 'include',
        })
      );
      expect(res).toEqual(mockRecordings);
    });

    it('throws error when server responds with an error payload', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ detail: "Segment 'seg-404' not found" }),
      });

      await expect(getRecordings('seg-404')).rejects.toThrow("Segment 'seg-404' not found");
    });
  });

  describe('uploadRecording', () => {
    it('sends multipart form data with file and duration_ms, and includes CSRF header', async () => {
      const mockResult: RecordingRead = {
        id: 'rec-new',
        segment_id: 'seg-100',
        take_number: 2,
        duration_ms: 2400,
        is_active: true,
        created_at: '2026-10-28T12:05:00Z',
        audio_url: '/api/recordings/rec-new/audio',
      };

      let capturedBody: FormData | undefined;
      let capturedHeaders: Headers | undefined;
      globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = options.body;
        capturedHeaders = options.headers;
        return {
          ok: true,
          status: 201,
          json: async () => mockResult,
        };
      });

      const blob = new Blob(['dummy audio content'], { type: 'audio/webm' });
      const result = await uploadRecording('seg-100', blob, 2400);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/segments/seg-100/recordings',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          body: expect.any(FormData),
        })
      );
      expect(result).toEqual(mockResult);

      expect(capturedBody).toBeDefined();
      expect(capturedBody?.has('file')).toBe(true);
      expect(capturedBody?.get('duration_ms')).toBe('2400');
      expect(capturedHeaders?.get('X-Requested-With')).toBe('Fetch');
    });

    it('omits duration_ms when not provided', async () => {
      let capturedBody: FormData | undefined;
      globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = options.body;
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 'rec-1' }),
        };
      });

      const blob = new Blob(['test audio'], { type: 'audio/wav' });
      await uploadRecording('seg-100', blob);

      expect(capturedBody?.get('duration_ms')).toBeNull();
      const fileEntry = capturedBody?.get('file') as File;
      expect(fileEntry.name).toMatch(/\.wav$/);
    });

    it('propagates server error details without losing the original error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ detail: 'Uploaded audio file is empty (0 bytes)' }),
      });

      const blob = new Blob([], { type: 'audio/webm' });
      await expect(uploadRecording('seg-100', blob)).rejects.toThrow(
        'Uploaded audio file is empty (0 bytes)'
      );
    });
  });

  describe('setActiveTake', () => {
    it('sends PATCH request to activate take with credentials and CSRF header', async () => {
      const mockResult: RecordingRead = {
        id: 'rec-1',
        segment_id: 'seg-100',
        take_number: 1,
        duration_ms: 1200,
        is_active: true,
        created_at: '2026-10-28T12:00:00Z',
        audio_url: '/api/recordings/rec-1/audio',
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResult,
      });

      const res = await setActiveTake('rec-1');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/recordings/rec-1/active',
        expect.objectContaining({
          method: 'PATCH',
          credentials: 'include',
        })
      );
      const callOptions = (globalThis.fetch as any).mock.calls[0][1];
      expect(callOptions.headers.get('X-Requested-With')).toBe('Fetch');
      expect(res).toEqual(mockResult);
    });
  });

  describe('deleteRecording', () => {
    it('sends DELETE request with CSRF header and handles 204 No Content', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      });

      await expect(deleteRecording('rec-1')).resolves.toBeUndefined();
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/recordings/rec-1',
        expect.objectContaining({
          method: 'DELETE',
          credentials: 'include',
        })
      );
      const callOptions = (globalThis.fetch as any).mock.calls[0][1];
      expect(callOptions.headers.get('X-Requested-With')).toBe('Fetch');
    });

    it('throws error when delete fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ detail: "Recording 'rec-404' not found" }),
      });

      await expect(deleteRecording('rec-404')).rejects.toThrow("Recording 'rec-404' not found");
    });
  });

  describe('Authentication & Session Handling', () => {
    describe('getAuthStatus', () => {
      it('fetches auth status from /api/auth/status', async () => {
        const mockStatus: AuthStatusResponse = {
          auth_required: true,
          authenticated: false,
        };

        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => mockStatus,
        });

        const res = await getAuthStatus();
        expect(globalThis.fetch).toHaveBeenCalledWith(
          '/api/auth/status',
          expect.objectContaining({
            credentials: 'include',
          })
        );
        expect(res).toEqual(mockStatus);
      });
    });

    describe('login', () => {
      it('posts password JSON with credentials and CSRF header', async () => {
        const mockResponse: AuthActionResponse = {
          success: true,
          message: 'Authenticated',
        };

        let capturedHeaders: Headers | undefined;
        let capturedBody: string | undefined;

        globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
          capturedHeaders = options.headers;
          capturedBody = options.body;
          return {
            ok: true,
            status: 200,
            json: async () => mockResponse,
          };
        });

        const res = await login('geheimnis123');

        expect(globalThis.fetch).toHaveBeenCalledWith(
          '/api/auth/login',
          expect.objectContaining({
            method: 'POST',
            credentials: 'include',
          })
        );
        expect(capturedHeaders?.get('X-Requested-With')).toBe('Fetch');
        expect(capturedHeaders?.get('Content-Type')).toBe('application/json');
        expect(JSON.parse(capturedBody || '{}')).toEqual({ password: 'geheimnis123' });
        expect(res).toEqual(mockResponse);
      });

      it('preserves leading and trailing spaces in submitted password payload unchanged', async () => {
        let capturedBody: string | undefined;
        globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
          capturedBody = options.body;
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, message: 'Authenticated' }),
          };
        });

        const rawPassword = '   leading and trailing spaces   ';
        await login(rawPassword);

        expect(JSON.parse(capturedBody || '{}')).toEqual({ password: rawPassword });
      });

      it('propagates 401 invalid credentials error from backend', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: async () => ({ detail: 'Invalid authentication credentials' }),
        });

        await expect(login('wrong_password')).rejects.toThrow(
          'Invalid authentication credentials'
        );
      });

      it('propagates 429 rate limit error message', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          json: async () => ({ detail: 'Too many failed attempts. Try again in 60 seconds.' }),
        });

        await expect(login('wrong_password')).rejects.toThrow(
          'Too many failed attempts. Try again in 60 seconds.'
        );
      });
    });

    describe('logout', () => {
      it('sends POST to /api/auth/logout with CSRF header', async () => {
        const mockResponse: AuthActionResponse = {
          success: true,
          message: 'Logged out',
        };

        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => mockResponse,
        });

        const res = await logout();
        expect(globalThis.fetch).toHaveBeenCalledWith(
          '/api/auth/logout',
          expect.objectContaining({
            method: 'POST',
            credentials: 'include',
          })
        );
        const callOptions = (globalThis.fetch as any).mock.calls[0][1];
        expect(callOptions.headers.get('X-Requested-With')).toBe('Fetch');
        expect(res).toEqual(mockResponse);
      });
    });

    describe('apiFetch & Unauthorized Interception', () => {
      it('triggers unauthorized handler when a protected endpoint returns 401', async () => {
        const onUnauthorized = vi.fn();
        setUnauthorizedHandler(onUnauthorized);

        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: async () => ({ detail: 'Authentication required' }),
        });

        await apiFetch('/api/projects');

        expect(onUnauthorized).toHaveBeenCalledTimes(1);
      });

      it('does NOT trigger unauthorized handler when /api/auth/login returns 401', async () => {
        const onUnauthorized = vi.fn();
        setUnauthorizedHandler(onUnauthorized);

        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: async () => ({ detail: 'Invalid authentication credentials' }),
        });

        await apiFetch('/api/auth/login', { method: 'POST' });

        expect(onUnauthorized).not.toHaveBeenCalled();
      });

      it('does NOT trigger unauthorized handler when /api/auth/status returns 401', async () => {
        const onUnauthorized = vi.fn();
        setUnauthorizedHandler(onUnauthorized);

        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: async () => ({ detail: 'Not authenticated' }),
        });

        await apiFetch('/api/auth/status');

        expect(onUnauthorized).not.toHaveBeenCalled();
      });

      it('does NOT add X-Requested-With on safe GET requests', async () => {
        let capturedHeaders: Headers | undefined;
        globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
          capturedHeaders = options.headers;
          return { ok: true, status: 200 };
        });

        await apiFetch('/api/projects');

        expect(capturedHeaders?.get('X-Requested-With')).toBeNull();
      });
    });
  });
});

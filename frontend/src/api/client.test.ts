import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getRecordings,
  uploadRecording,
  setActiveTake,
  deleteRecording,
  getRecordingAudioUrl,
  getAudioExtensionFromMime,
  RecordingRead,
} from './client';

describe('Recording API Client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
    it('fetches list of recordings for a segment', async () => {
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
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/segments/seg-100/recordings');
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
    it('sends multipart form data with file and duration_ms', async () => {
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
      globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = options.body;
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
          body: expect.any(FormData),
        })
      );
      expect(result).toEqual(mockResult);

      expect(capturedBody).toBeDefined();
      expect(capturedBody?.has('file')).toBe(true);
      expect(capturedBody?.get('duration_ms')).toBe('2400');
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
    it('sends PATCH request to activate take', async () => {
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
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/recordings/rec-1/active', {
        method: 'PATCH',
      });
      expect(res).toEqual(mockResult);
    });
  });

  describe('deleteRecording', () => {
    it('sends DELETE request and handles 204 No Content', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      });

      await expect(deleteRecording('rec-1')).resolves.toBeUndefined();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/recordings/rec-1', {
        method: 'DELETE',
      });
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
});

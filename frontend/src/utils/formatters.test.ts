import { describe, it, expect } from 'vitest';
import { formatDuration, formatMs } from './formatters';

describe('formatDuration', () => {
  it('formats standard seconds to mm:ss', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(45)).toBe('00:45');
    expect(formatDuration(65)).toBe('01:05');
    expect(formatDuration(3600)).toBe('60:00');
  });

  it('handles negative or NaN inputs safely', () => {
    expect(formatDuration(-10)).toBe('00:00');
    expect(formatDuration(NaN)).toBe('00:00');
  });
});

describe('formatMs', () => {
  it('formats milliseconds to mm:ss.mmm', () => {
    expect(formatMs(0)).toBe('00:00.000');
    expect(formatMs(1250)).toBe('00:01.250');
    expect(formatMs(61500)).toBe('01:01.500');
  });

  it('handles invalid inputs gracefully', () => {
    expect(formatMs(-50)).toBe('00:00.000');
    expect(formatMs(NaN)).toBe('00:00.000');
  });
});

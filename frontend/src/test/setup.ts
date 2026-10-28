import '@testing-library/jest-dom/vitest';

// Stub HTMLMediaElement playback methods in test environment
if (typeof window !== 'undefined' && window.HTMLMediaElement) {
  window.HTMLMediaElement.prototype.play = window.HTMLMediaElement.prototype.play || (async () => {});
  window.HTMLMediaElement.prototype.pause = window.HTMLMediaElement.prototype.pause || (() => {});
}

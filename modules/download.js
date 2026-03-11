// ── download.js ───────────────────────────────────────────────
// Handles downloading tracks as Blobs and persisting to IndexedDB.
// Also manages download UI state (progress, done, error).
//
// Flow:
//   1. fetchMp3Url(track)  — resolve track page → get MP3 URL
//   2. fetchBlob(mp3Url)   — download binary with progress
//   3. Offline.save(track, blob) — persist to IndexedDB

import { fetchPage, parseMp3 } from './parser.js';
import { Offline } from './storage.js';

// Active downloads: Map<trackUrl, AbortController>
const active = new Map();

export const Download = {
  isDownloading(url) { return active.has(url); },

  async start(track, { onProgress, onDone, onError } = {}) {
    if (active.has(track.url)) return; // already in progress

    const ctrl = new AbortController();
    active.set(track.url, ctrl);

    try {
      // Step 1: get MP3 URL (use cached if already played)
      let mp3Url = track.mp3Url;
      if (!mp3Url) {
        onProgress?.({ phase: 'resolving', percent: 0 });
        const html = await fetchPage(track.url);
        mp3Url = parseMp3(html);
        if (!mp3Url) throw new Error('MP3-ссылка не найдена');
        track.mp3Url = mp3Url;
      }

      // Step 2: fetch binary with progress
      onProgress?.({ phase: 'downloading', percent: 0 });
      const blob = await fetchBlobWithProgress(mp3Url, ctrl.signal, (pct) => {
        onProgress?.({ phase: 'downloading', percent: pct });
      });

      // Step 3: persist
      onProgress?.({ phase: 'saving', percent: 100 });
      await Offline.save(track, blob);

      active.delete(track.url);
      onDone?.();
    } catch (e) {
      active.delete(track.url);
      if (e.name === 'AbortError') return; // user cancelled — silent
      onError?.(e.message);
    }
  },

  cancel(url) {
    const ctrl = active.get(url);
    if (ctrl) {
      ctrl.abort();
      active.delete(url);
    }
  },
};

// ── Fetch binary with streaming progress ──────────────────────
async function fetchBlobWithProgress(url, signal, onPercent) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentLength = res.headers.get('Content-Length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onPercent(Math.round((received / total) * 100));
  }

  const all = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }

  return new Blob([all], { type: 'audio/mpeg' });
}

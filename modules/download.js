// ── download.js ───────────────────────────────────────────────
// Скачивание треков через прокси → IndexedDB (офлайн воспроизведение).
// Работает везде где доступны прокси (в т.ч. через VPN).

import { fetchPage, parseMp3 } from './parser.js';
import { Offline } from './storage.js';

const PROXIES = [
  'https://functions.yandexcloud.net/d4ebfvpcafvdghfva6fs?url=',
  'https://silent-boat-5c96.chatgptnik.workers.dev/?url=',
];

const active = new Map();

export const Download = {
  isDownloading(url) { return active.has(url); },

  async start(track, { onProgress, onDone, onError } = {}) {
    if (active.has(track.url)) return;

    const ctrl = new AbortController();
    active.set(track.url, ctrl);

    try {
      // Шаг 1: получаем MP3 URL
      let mp3Url = track.mp3Url;
      if (!mp3Url) {
        onProgress?.({ phase: 'resolving', percent: 0 });
        const html = await fetchPage(track.url);
        mp3Url = parseMp3(html);
        if (!mp3Url) throw new Error('MP3-ссылка не найдена');
        track.mp3Url = mp3Url;
      }

      // Шаг 2: качаем через прокси с fallback
      onProgress?.({ phase: 'downloading', percent: 0 });
      const blob = await fetchBlobWithFallback(mp3Url, ctrl.signal, pct => {
        onProgress?.({ phase: 'downloading', percent: pct });
      });

      // Шаг 3: сохраняем в IndexedDB
      onProgress?.({ phase: 'saving', percent: 100 });
      await Offline.save(track, blob);

      active.delete(track.url);
      onDone?.();
    } catch (e) {
      active.delete(track.url);
      if (e.name === 'AbortError') return;
      onError?.(e.message);
    }
  },

  cancel(url) {
    const ctrl = active.get(url);
    if (ctrl) { ctrl.abort(); active.delete(url); }
  },
};

// ── Перебираем прокси по очереди ──────────────────────────────
async function fetchBlobWithFallback(mp3Url, signal, onPercent) {
  let lastError;
  for (const proxy of PROXIES) {
    try {
      const blob = await fetchBlobViaProxy(proxy, mp3Url, signal, onPercent);
      return blob;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastError = e;
      console.warn('[download] proxy failed (' + proxy + '):', e.message);
    }
  }
  throw new Error('Все прокси недоступны: ' + (lastError?.message || ''));
}

// ── Fetch через прокси с прогрессом ───────────────────────────
async function fetchBlobViaProxy(proxy, mp3Url, signal, onPercent) {
  const res = await fetch(proxy + encodeURIComponent(mp3Url), { signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);

  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    const txt = await res.text();
    throw new Error(txt.slice(0, 120));
  }

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
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new Blob([all], { type: 'audio/mpeg' });
}

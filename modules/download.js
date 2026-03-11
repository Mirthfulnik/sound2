// ── download.js ───────────────────────────────────────────────
// Fetch MP3 через прокси (обход CORS Safari), сохраняем в IndexedDB.

import { fetchPage, parseMp3 } from './parser.js';
import { Offline } from './storage.js';

// Те же прокси что в parser.js — гарантируют работу в Safari
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
      // Шаг 1: получаем MP3 URL (кешируем если уже играл)
      let mp3Url = track.mp3Url;
      if (!mp3Url) {
        onProgress?.({ phase: 'resolving', percent: 0 });
        const html = await fetchPage(track.url);
        mp3Url = parseMp3(html);
        if (!mp3Url) throw new Error('MP3-ссылка не найдена');
        track.mp3Url = mp3Url;
      }

      // Шаг 2: качаем бинарник через прокси (Safari CORS fix)
      onProgress?.({ phase: 'downloading', percent: 0 });
      const blob = await fetchBlobViaProxy(mp3Url, ctrl.signal, pct => {
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

// ── Fetch через прокси с прогрессом ───────────────────────────
async function fetchBlobViaProxy(mp3Url, signal, onPercent) {
  const encoded = encodeURIComponent(mp3Url);
  let lastError;

  for (const proxy of PROXIES) {
    try {
      const res = await fetch(proxy + encoded, { signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);

      // Прокси возвращает текст — проверяем что это не JSON-ошибка
      const contentType = res.headers.get('Content-Type') || '';
      if (contentType.includes('application/json')) {
        const txt = await res.text();
        throw new Error('Proxy error: ' + txt);
      }

      // Читаем с прогрессом
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

    } catch (e) {
      if (e.name === 'AbortError') throw e; // пробрасываем отмену сразу
      lastError = e;
      console.warn('[download] proxy failed (' + proxy + '):', e.message);
    }
  }

  throw new Error('Все прокси недоступны: ' + lastError?.message);
}

// ── download.js ───────────────────────────────────────────────
// Стратегия скачивания:
// 1. Ищем трек на hitmotop по "artist title" → прямая MP3-ссылка
//    на ru.hitmotop.com/get/music/... (отдаёт с CORS, работает без прокси)
// 2. Если hitmotop не нашёл — fallback на прокси → sunproxy.net (оригинал)

import { fetchPage, parseMp3 } from './parser.js';
import { Offline } from './storage.js';

const PROXIES = [
  'https://functions.yandexcloud.net/d4ebfvpcafvdghfva6fs?url=',
  'https://silent-boat-5c96.chatgptnik.workers.dev/?url=',
];

// hitmotop: поиск и прямая ссылка на MP3
const HITMO_SEARCH = 'https://rus.hitmotop.com/search?q=';

const active = new Map();

export const Download = {
  isDownloading(url) { return active.has(url); },

  async start(track, { onProgress, onDone, onError } = {}) {
    if (active.has(track.url)) return;

    const ctrl = new AbortController();
    active.set(track.url, ctrl);

    try {
      onProgress?.({ phase: 'resolving', percent: 0 });

      // Шаг 1: пробуем найти прямую ссылку на hitmotop
      let mp3Url = null;
      try {
        mp3Url = await findOnHitmotop(track, ctrl.signal);
        if (mp3Url) console.log('[download] hitmotop MP3:', mp3Url);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        console.warn('[download] hitmotop search failed:', e.message);
      }

      // Шаг 2: если hitmotop не нашёл — берём оригинальный MP3 через прокси
      if (!mp3Url) {
        console.log('[download] fallback to original source via proxy');
        if (!track.mp3Url) {
          const html = await fetchPage(track.url);
          mp3Url = parseMp3(html);
          if (!mp3Url) throw new Error('MP3-ссылка не найдена');
          track.mp3Url = mp3Url;
        } else {
          mp3Url = track.mp3Url;
        }
      }

      // Шаг 3: скачиваем
      onProgress?.({ phase: 'downloading', percent: 0 });
      const blob = await fetchBlobAuto(mp3Url, ctrl.signal, pct => {
        onProgress?.({ phase: 'downloading', percent: pct });
      });

      // Шаг 4: сохраняем
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

// ── Поиск трека на hitmotop, возвращает прямую MP3-ссылку ─────
async function findOnHitmotop(track, signal) {
  const query = [track.artist, track.title].filter(Boolean).join(' ');
  const searchUrl = HITMO_SEARCH + encodeURIComponent(query);

  let html = null;
  for (const proxy of PROXIES) {
    try {
      const res = await fetch(proxy + encodeURIComponent(searchUrl), { signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      // Принимаем только страницы с реальными результатами поиска
      if (text.includes('p-track-download-btn')) {
        html = text;
        console.log('[hitmo] search results found');
        break;
      } else {
        console.warn('[hitmo] no results in response (got main page or empty results)');
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn('[hitmo] proxy failed:', e.message);
    }
  }

  if (!html) return null;

  // Ссылка в href атрибуте тега с классом p-track-download-btn
  // Формат: https://rus.hitmotop.com/get/music/YYYYMMDD/Artist_-_Title_ID.mp3
  const mp3Pattern = /href="(https?:\/\/(?:rus|ru)\.hitmotop\.com\/get\/music\/[^"]+\.mp3)"/gi;
  const matches = [...html.matchAll(mp3Pattern)];
  if (!matches.length) return null;

  console.log('[hitmo] found MP3:', matches[0][1]);
  return matches[0][1];
}

// ── Всегда качаем через прокси (hitmotop и sunproxy.net оба без CORS) ──
async function fetchBlobAuto(mp3Url, signal, onPercent) {
  return await fetchBlobViaProxies(mp3Url, signal, onPercent);
}

async function fetchBlobViaProxies(mp3Url, signal, onPercent) {
  let lastError;
  for (const proxy of PROXIES) {
    try {
      return await fetchBlobViaProxy(proxy, mp3Url, signal, onPercent);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastError = e;
      console.warn('[download] proxy failed:', e.message);
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

  return await readBlobFromResponse(res, onPercent);
}

// ── Читаем Response как Blob с прогрессом ─────────────────────
async function readBlobFromResponse(res, onPercent) {
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

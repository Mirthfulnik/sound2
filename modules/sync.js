// ── sync.js ───────────────────────────────────────────────────
// Синхронизация лайков и офлайн-треков с Yandex Object Storage.
// Работает только если пользователь авторизован через Telegram.

import { Auth } from './auth.js';

// URL функции синхронизации (замените после деплоя)
const SYNC_URL = 'https://silent-boat-5c96.chatgptnik.workers.dev';

// Задержка перед отправкой (debounce) — чтобы не слать запрос на каждый лайк
const DEBOUNCE_MS = 2000;
const timers = {};

export const Sync = {
  // Загрузить данные с сервера при старте
  async pull() {
    if (!Auth.isLoggedIn()) return null;
    try {
      const [liked, offline] = await Promise.all([
        apiFetch('GET', '/sync/liked'),
        apiFetch('GET', '/sync/offline'),
      ]);
      return { liked: liked?.data || [], offline: offline?.data || [] };
    } catch (e) {
      console.warn('[sync] pull failed:', e.message);
      return null;
    }
  },

  // Сохранить лайкнутые треки (с debounce)
  pushLiked(tracks) {
    if (!Auth.isLoggedIn()) return;
    debounce('liked', () => apiFetch('POST', '/sync/liked', tracks));
  },

  // Сохранить метаданные офлайн-треков (без blob — только мета)
  pushOffline(tracks) {
    if (!Auth.isLoggedIn()) return;
    // Сохраняем только метаданные (без blob)
    const meta = tracks.map(({ url, title, artist, duration, durationSec, genre }) =>
      ({ url, title, artist, duration, durationSec, genre })
    );
    debounce('offline', () => apiFetch('POST', '/sync/offline', meta));
  },
};

// ── Внутренние утилиты ────────────────────────────────────────
async function apiFetch(method, path, body) {
  const token = Auth.token;
  if (!token) return null;

  const res = await fetch(SYNC_URL + path, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function debounce(key, fn) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, DEBOUNCE_MS);
}

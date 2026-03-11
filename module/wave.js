// ── wave.js ───────────────────────────────────────────────────
// "Моя волна" — autoradio engine.
// Loads tracks by genre, applies filters, feeds Player with infinite queue.
//
// Available filters (based on what skysound7 actually provides):
//   genre      — one of GENRES from parser.js
//   mood       — derived from track duration:
//                  'energetic' = < 3 min (uptempo / short)
//                  'calm'      = > 4 min (long / slow)
//                  'all'       = no filter
//   skipPlayed — skip tracks already in History

import { loadGenrePage, GENRES } from './parser.js';
import { Player } from './player.js';
import { WaveSettings, History } from './storage.js';

let waveActive   = false;
let waveSettings = {};
let waveQueue    = [];
let waveCursor   = 0;

// ── Public API ────────────────────────────────────────────────
export const Wave = {
  isActive() { return waveActive; },

  async start(settings) {
    waveSettings = { ...WaveSettings.defaults, ...settings };
    WaveSettings.save(waveSettings);
    waveActive = true;
    waveQueue  = [];
    waveCursor = 0;

    emit('wave:loading');
    try {
      await refillQueue();
      if (!waveQueue.length) throw new Error('Нет треков по выбранным фильтрам');
      await Player.setQueue(waveQueue, 0);
      emit('wave:started', { track: waveQueue[0], settings: waveSettings });
    } catch (e) {
      waveActive = false;
      emit('wave:error', { message: e.message });
    }
  },

  stop() {
    waveActive = false;
    if (Player.isPlaying) Player.togglePlay();
    emit('wave:stopped');
  },

  getSettings() {
    return WaveSettings.get();
  },

  getGenres() {
    return GENRES;
  },
};

// ── Auto-advance: when player moves to next track, refill if needed ──
document.addEventListener('player:track-changed', async ({ detail }) => {
  if (!waveActive) return;
  waveCursor++;

  // Refill when within 3 tracks of end
  if (waveCursor >= waveQueue.length - 3) {
    try {
      await refillQueue();
      Player.appendToQueue(waveQueue.slice(waveCursor));
    } catch { /* network error — queue runs dry gracefully */ }
  }
});

// ── Internal ──────────────────────────────────────────────────
async function refillQueue() {
  const { genre, mood, skipPlayed } = waveSettings;

  // Load tracks from genre page (or main page for "all")
  const raw = await loadGenrePage(genre);

  // Apply mood filter
  let filtered = applyMoodFilter(raw, mood);

  // Skip already played if requested
  if (skipPlayed) {
    filtered = filtered.filter(t => !History.has(t.url));
  }

  // Shuffle for variety
  const shuffled = shuffle(filtered);

  // Append new tracks (avoid duplicates already in queue)
  const existingUrls = new Set(waveQueue.map(t => t.url));
  const fresh = shuffled.filter(t => !existingUrls.has(t.url));

  if (!fresh.length && filtered.length > 0) {
    // All tracks have been played — reset and allow repeats
    waveQueue.push(...shuffled);
  } else {
    waveQueue.push(...fresh);
  }
}

function applyMoodFilter(tracks, mood) {
  if (mood === 'energetic') {
    // Short tracks (< 180 sec) tend to be uptempo
    return tracks.filter(t => t.durationSec > 0 && t.durationSec < 180);
  }
  if (mood === 'calm') {
    // Long tracks (> 240 sec)
    return tracks.filter(t => t.durationSec > 240);
  }
  return tracks; // 'all'
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function emit(name, detail = {}) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

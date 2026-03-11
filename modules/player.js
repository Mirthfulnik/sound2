// ── player.js ─────────────────────────────────────────────────
// Manages the audio element, queue, and playback state.
// Emits custom DOM events so UI modules can react without tight coupling.
//
// Events dispatched on document:
//   player:track-changed  → { track, index }
//   player:state-changed  → { playing }
//   player:progress       → { currentTime, duration, percent }
//   player:error          → { message }

import { parseMp3, fetchPage } from './parser.js';
import { History, Offline } from './storage.js';

const audio = new Audio();
audio.preload = 'auto';

let queue      = [];   // Track[]
let queueIndex = -1;
let shuffle    = false;
let repeat     = false;
let loading    = false;

// ── Public API ────────────────────────────────────────────────
export const Player = {
  get currentTrack() { return queue[queueIndex] || null; },
  get isPlaying()    { return !audio.paused; },
  get isShuffle()    { return shuffle; },
  get isRepeat()     { return repeat; },
  get queueLength()  { return queue.length; },

  setQueue(tracks, startIndex = 0) {
    queue = tracks;
    queueIndex = startIndex;
    return this.playIndex(startIndex);
  },

  async playIndex(index) {
    if (index < 0 || index >= queue.length) return;
    queueIndex = index;
    const track = queue[queueIndex];
    loading = true;
    emit('player:track-changed', { track, index });

    try {
      // Check offline storage first
      const offlineEntry = await Offline.get(track.url);
      let src;
      if (offlineEntry?.blob) {
        src = URL.createObjectURL(offlineEntry.blob);
      } else {
        const html = await fetchPage(track.url);
        const mp3  = parseMp3(html);
        if (!mp3) throw new Error('MP3-ссылка не найдена на странице трека');
        track.mp3Url = mp3; // cache for download button
        src = mp3;
      }

      audio.src = src;
      await audio.play();
      History.add(track.url);
      emit('player:state-changed', { playing: true });
    } catch (e) {
      emit('player:error', { message: e.message });
    } finally {
      loading = false;
    }
  },

  togglePlay() {
    if (!audio.src) return;
    if (audio.paused) {
      audio.play().then(() => emit('player:state-changed', { playing: true }));
    } else {
      audio.pause();
      emit('player:state-changed', { playing: false });
    }
  },

  prev() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (queueIndex > 0) this.playIndex(queueIndex - 1);
  },

  next() { playNext(); },

  seek(percent) {
    if (!audio.duration) return;
    audio.currentTime = (percent / 100) * audio.duration;
  },

  setVolume(v) { audio.volume = Math.max(0, Math.min(1, v)); },
  getVolume()  { return audio.volume; },

  toggleShuffle() { shuffle = !shuffle; return shuffle; },
  toggleRepeat()  { repeat  = !repeat;  return repeat; },

  // Replace current queue without changing playback
  appendToQueue(tracks) { queue = queue.concat(tracks); },

  isLoading() { return loading; },
};

// ── Internal playback logic ───────────────────────────────────
function playNext() {
  if (!queue.length) return;
  let next;
  if (shuffle) {
    next = Math.floor(Math.random() * queue.length);
  } else if (queueIndex < queue.length - 1) {
    next = queueIndex + 1;
  } else if (repeat) {
    next = 0;
  } else {
    return; // end of queue
  }
  Player.playIndex(next);
}

// ── Audio event listeners ─────────────────────────────────────
audio.addEventListener('ended', () => {
  if (repeat) {
    audio.currentTime = 0;
    audio.play();
  } else {
    playNext();
  }
});

audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  emit('player:progress', {
    currentTime: audio.currentTime,
    duration:    audio.duration,
    percent:     (audio.currentTime / audio.duration) * 100,
  });
});

audio.addEventListener('loadedmetadata', () => {
  emit('player:progress', {
    currentTime: 0,
    duration:    audio.duration,
    percent:     0,
  });
});

audio.addEventListener('pause', () => emit('player:state-changed', { playing: false }));
audio.addEventListener('play',  () => emit('player:state-changed', { playing: true }));

// ── Helper ────────────────────────────────────────────────────
function emit(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

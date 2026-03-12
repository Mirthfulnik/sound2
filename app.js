// ── app.js ────────────────────────────────────────────────────
// Entry point. Wires modules together, handles screen logic. 

import { Player }   from './modules/player.js';
import { Wave }     from './modules/wave.js';
import { Liked, Offline } from './modules/storage.js';
import { Download } from './modules/download.js';
import { Auth, openTelegramLogin } from './modules/auth.js';
import { Sync } from './modules/sync.js';
import { search, loadGenrePage, GENRES } from './modules/parser.js';
import {
  initNav, renderTrackList, updateLikeButton, updateDownloadButton,
  markPlayingTrack, updatePlayerBar, setWaveState, updateWaveNowPlaying,
  loadingHTML, emptyHTML, showToast, showConfirm, formatTime,
  downloadIconSVG, downloadedIconSVG,
} from './modules/ui.js';

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // ── VPN Banner ───────────────────────────────────────────────
  const _banner = document.getElementById('vpnBanner');
  const _closeBtn = document.getElementById('vpnBannerClose');
  if (_banner && _closeBtn) {
    if (sessionStorage.getItem('vpn_banner_dismissed')) {
      _banner.classList.add('hidden');
    } else {
      document.body.classList.add('vpn-banner-visible');
    }
    _closeBtn.addEventListener('click', () => {
      _banner.classList.add('hidden');
      document.body.classList.remove('vpn-banner-visible');
      sessionStorage.setItem('vpn_banner_dismissed', '1');
    });
  }

  // Инициализация авторизации
  await Auth.init();
  updateAuthUI();

  // Если уже авторизован — двусторонняя синхронизация
  if (Auth.isLoggedIn()) {
    syncBothWays();
  }

  // Слушаем события авторизации
  window.addEventListener('auth:login', async (e) => {
    updateAuthUI();
    showToast('✓ Вы вошли как ' + (e.detail.name || e.detail.username), 'success');
    await syncBothWays();
  });
  window.addEventListener('auth:logout', () => {
    updateAuthUI();
    showToast('Вы вышли из аккаунта');
  });
  window.addEventListener('auth:error', (e) => {
    showToast('Ошибка авторизации: ' + e.detail, 'error');
  });

  initNav();
  initWaveScreen();
  initSearchScreen();
  initFavoritesScreen();
  initPlayerBar();
  initPlayerEvents();
  restoreVolume();
  await handleDeepLink();
});

// ════════════════════════════════════════════════════════════════
// DEEP LINK — ?track=<encoded_track_page_url>
// ════════════════════════════════════════════════════════════════
async function handleDeepLink() {
  const params = new URLSearchParams(location.search);
  const trackUrl = params.get('track');
  if (!trackUrl) return;

  showToast('Загружаем трек по ссылке…');

  try {
    const decoded = decodeURIComponent(trackUrl);
    const slugMatch = decoded.match(/\/t\/[^-]+-(.+?)\/?$/);
    const subMatch  = decoded.match(/https?:\/\/([^.]+)\.skysound7/);
    const title  = slugMatch ? decodeURIComponent(slugMatch[1]).replace(/-/g, ' ') : 'Трек';
    const artist = subMatch  ? subMatch[1] : '—';

    const track = { url: decoded, title, artist, duration: '' };
    Player.setQueue([track], 0);
    history.replaceState(null, '', location.pathname);
  } catch (e) {
    showToast('Не удалось загрузить трек из ссылки', 'error');
  }
}

// ════════════════════════════════════════════════════════════════
// SCREEN 1 — МОЯ ВОЛНА
// ════════════════════════════════════════════════════════════════
function initWaveScreen() {
  const settings = Wave.getSettings();

  const genreSelect = document.getElementById('waveGenre');
  GENRES.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.value;
    opt.textContent = g.label;
    if (g.value === settings.genre) opt.selected = true;
    genreSelect.appendChild(opt);
  });

  document.getElementById('waveMood').value        = settings.mood;
  document.getElementById('waveSkipPlayed').checked = settings.skipPlayed;

  document.getElementById('wavePlayBtn').addEventListener('click', async () => {
    if (Wave.isActive()) {
      Wave.stop();
      setWaveState('idle');
      return;
    }

    const currentSettings = {
      genre:      genreSelect.value,
      mood:       document.getElementById('waveMood').value,
      skipPlayed: document.getElementById('waveSkipPlayed').checked,
    };

    setWaveState('loading');
    await Wave.start(currentSettings);
  });

  document.addEventListener('wave:started', ({ detail }) => {
    setWaveState('playing');
    updateWaveNowPlaying(detail.track);
    showToast('Волна запущена', 'success');
  });

  document.addEventListener('wave:error', ({ detail }) => {
    setWaveState('idle');
    showToast('Ошибка: ' + detail.message, 'error');
  });

  document.addEventListener('wave:stopped', () => setWaveState('idle'));
}

// ════════════════════════════════════════════════════════════════
// SCREEN 2 — ПОИСК
// ════════════════════════════════════════════════════════════════
function initSearchScreen() {
  const input   = document.getElementById('searchInput');
  const btn     = document.getElementById('searchBtn');
  const results = document.getElementById('searchResults');

  document.querySelectorAll('.genre-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      document.querySelectorAll('.genre-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      results.innerHTML = loadingHTML();
      try {
        const tracks = await loadGenrePage(tab.dataset.genre);
        renderSearchResults(tracks, results);
      } catch (e) {
        results.innerHTML = emptyHTML('Ошибка загрузки: ' + e.message);
      }
    });
  });

  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) return;
    results.innerHTML = loadingHTML('Поиск...');
    document.querySelectorAll('.genre-tab').forEach(t => t.classList.remove('active'));
    try {
      const tracks = await search(q);
      if (!tracks.length) {
        results.innerHTML = emptyHTML('По запросу «' + q + '» ничего не найдено');
        return;
      }
      renderSearchResults(tracks, results);
    } catch (e) {
      results.innerHTML = emptyHTML('Ошибка поиска: ' + e.message);
    }
  };

  btn.addEventListener('click', doSearch);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
}

function renderSearchResults(tracks, container) {
  renderTrackList(container, tracks, makeTrackHandlers(tracks));
}

// ════════════════════════════════════════════════════════════════
// SCREEN 3 — ИЗБРАННОЕ
// ════════════════════════════════════════════════════════════════
function initFavoritesScreen() {
  refreshFavorites();
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view === 'favorites') {
        refreshFavorites();
        // Сбросить поиск при переходе на экран
        const inp = document.getElementById('favSearchInput');
        if (inp) inp.value = '';
      }
    });
  });

  // Поиск по избранному
  const favSearch = document.getElementById('favSearchInput');
  if (favSearch) {
    favSearch.addEventListener('input', () => {
      const q = favSearch.value.trim().toLowerCase();
      const tracks = Liked.getAll();
      const filtered = q
        ? tracks.filter(t =>
            (t.title  || '').toLowerCase().includes(q) ||
            (t.artist || '').toLowerCase().includes(q)
          )
        : tracks;
      renderFavoritesList(filtered);
    });
  }
}

function refreshFavorites() {
  // Сбросить фильтр при обновлении
  const inp = document.getElementById('favSearchInput');
  const q   = inp ? inp.value.trim().toLowerCase() : '';
  const all = Liked.getAll();
  const tracks = q
    ? all.filter(t =>
        (t.title  || '').toLowerCase().includes(q) ||
        (t.artist || '').toLowerCase().includes(q)
      )
    : all;
  renderFavoritesList(tracks, all.length);
}

function renderFavoritesList(tracks, totalCount) {
  const container = document.getElementById('favoritesContainer');
  const count     = totalCount ?? tracks.length;

  const favCount = document.getElementById('favCount');
  if (favCount) favCount.textContent = count ? count + ' треков' : '';

  if (!tracks.length) {
    const q = document.getElementById('favSearchInput')?.value.trim();
    container.innerHTML = emptyHTML(q ? 'Ничего не найдено' : 'Здесь появятся треки, которые вы лайкнули ♡');
    return;
  }

  renderTrackList(container, tracks, {
    ...makeTrackHandlers(tracks),
    onLikeToggle: (track, btn) => {
      Liked.remove(track.url);
      Sync.pushLiked(Liked.getAll());
      const row = btn.closest('.track-item');
      row.style.transition = 'opacity 0.3s, transform 0.3s';
      row.style.opacity    = '0';
      row.style.transform  = 'translateX(-20px)';
      setTimeout(() => refreshFavorites(), 300);
      showToast('♡ Убрано из избранного');
      if (Player.currentTrack?.url === track.url) {
        updatePlayerBar({ track: Player.currentTrack });
      }
    },
  });
}

// ════════════════════════════════════════════════════════════════
// SHARED TRACK HANDLERS
// ════════════════════════════════════════════════════════════════
function makeTrackHandlers(tracks) {
  return {
    onPlay: (track, i) => Player.setQueue(tracks, i),

    onLikeToggle: (track, btn) => {
      const isNowLiked = Liked.toggle(track);
      updateLikeButton(btn, isNowLiked);
      refreshFavorites();
      showToast(isNowLiked ? '♥ Добавлено в избранное' : '♡ Убрано из избранного');
      Sync.pushLiked(Liked.getAll());
      if (Player.currentTrack?.url === track.url) {
        updatePlayerBar({ track: Player.currentTrack });
      }
    },

    onDownload: (track, btn) => handleDownload(track, btn),
    onDelete:   (track, btn) => handleDelete(track, btn),
    onShare:    (track)      => handleShare(track),
  };
}

// ── Download ──────────────────────────────────────────────────
// ── VPN / Auth hint ───────────────────────────────────────────
function showVpnHint(onContinue) {
  if (sessionStorage.getItem('vpn_hint_shown')) { onContinue(); return; }
  sessionStorage.setItem('vpn_hint_shown', '1');

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `
    <div class="confirm-dialog vpn-hint-dialog">
      <div class="vpn-hint-icon">🔒</div>
      <div class="confirm-msg">
        <strong>Для скачивания треков</strong><br>
        Включите VPN для стабильной работы.<br>
        Или авторизуйтесь через Telegram — это позволит сохранять треки в облаке.
      </div>
      <div class="confirm-btns">
        <button class="confirm-cancel" id="vpnContinueBtn">Продолжить без VPN</button>
        <button class="confirm-ok" id="vpnTgBtn">${Auth.isLoggedIn() ? '✓ Аккаунт подключён' : 'Войти через Telegram'}</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));

  const close = (cb) => {
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.remove(); cb?.(); }, 200);
  };

  overlay.querySelector('#vpnContinueBtn').onclick = () => close(onContinue);
  overlay.querySelector('#vpnTgBtn').onclick = () => {
    if (Auth.isLoggedIn()) { close(onContinue); return; }
    close(() => showTelegramAuth());
  };
  overlay.onclick = (e) => { if (e.target === overlay) close(onContinue); };
}

function showTelegramAuth() {
  openTelegramLogin(() => updateAuthUI());
}

function updateAuthUI() {
  const user = Auth.user;
  const authBtn = document.getElementById('authBtn');
  if (!authBtn) return;
  if (user) {
    authBtn.innerHTML = (user.photo
      ? `<img src="${user.photo}" class="auth-avatar">`
      : `<svg class="auth-icon" viewBox="0 0 24 24" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`)
      + `<span class="auth-name">${user.name || user.username}</span>`;
    authBtn.classList.add('logged-in');
    authBtn.title = user.name || user.username;
    authBtn.onclick = () => { if (confirm('Выйти из аккаунта?')) Auth.logout(); };
  } else {
    authBtn.innerHTML = `<svg class="auth-icon" viewBox="0 0 24 24" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg><span class="auth-name">Войти</span>`;
    authBtn.classList.remove('logged-in');
    authBtn.title = 'Войти через Telegram';
    authBtn.onclick = showTelegramAuth;
  }
}

// ── Двусторонняя синхронизация лайков ────────────────────────
// Мержим локальные → KV и KV → локальные
async function syncBothWays() {
  try {
    const remote = await Sync.pull();
    const local  = Liked.getAll();

    // KV → локально (добавляем треки которых нет локально)
    let changed = false;
    if (remote?.liked?.length) {
      remote.liked.forEach(t => {
        if (!Liked.isLiked(t.url)) { Liked.add(t); changed = true; }
      });
    }
    if (changed) refreshFavorites();

    // Локально → KV (пушим мёрж если локальных больше чем в KV)
    const merged = Liked.getAll();
    const remoteCount = remote?.liked?.length || 0;
    if (merged.length > remoteCount) {
      Sync.pushLiked(merged);
    }
  } catch (e) {
    console.warn('[sync] syncBothWays failed:', e.message);
  }
}

function handleDownload(track, btn) {
  if (Download.isDownloading(track.url)) return;

  showVpnHint(() => {
    updateDownloadButton(btn, 'downloading', 0);
    Download.start(track, {
    onProgress: ({ percent }) => {
      updateDownloadButton(btn, 'downloading', percent);
      const pbBtn = document.getElementById('playerDownloadBtn');
      if (pbBtn && pbBtn.dataset.url === track.url) {
        updateDownloadButton(pbBtn, 'downloading', percent);
      }
    },
    onDone: () => {
      updateDownloadButton(btn, 'downloaded');
      const pbBtn = document.getElementById('playerDownloadBtn');
      if (pbBtn && pbBtn.dataset.url === track.url) updateDownloadButton(pbBtn, 'downloaded');

      // Автоматически добавляем в избранное при скачивании
      const wasLiked = Liked.isLiked(track.url);
      if (!wasLiked) {
        Liked.add(track);
        // Обновляем кнопку лайка в player-bar
        updatePlayerBar({ track: Player.currentTrack?.url === track.url ? Player.currentTrack : track });
        // Обновляем кнопку лайка в списке треков
        document.querySelectorAll('.like-btn[data-url]').forEach(b => {
          if (b.dataset.url === track.url) updateLikeButton(b, true);
        });
      }

      showToast('✓ Трек сохранён и добавлен в избранное');
      refreshFavorites();
      Offline.getAll().then(tracks => Sync.pushOffline(tracks));
    },
    onError: (msg) => {
      updateDownloadButton(btn, 'idle');
      showToast('Ошибка загрузки: ' + msg, 'error');
    },
    });
  }); // showVpnHint
}

async function handleDelete(track, btn) {
  const ok = await showConfirm('Удалить «' + track.title + '» из загрузок?');
  if (!ok) return;
  await Offline.remove(track.url);
  updateDownloadButton(btn, 'idle');
  const pbBtn = document.getElementById('playerDownloadBtn');
  if (pbBtn && pbBtn.dataset.url === track.url) updateDownloadButton(pbBtn, 'idle');
  showToast('Трек удалён из загрузок');
  refreshFavorites();
}

// ── Share ─────────────────────────────────────────────────────
function handleShare(track) {
  const url  = location.origin + location.pathname + '?track=' + encodeURIComponent(track.url);
  const text = (track.artist || '') + ' — ' + (track.title || '');

  if (navigator.share) {
    navigator.share({ title: text, url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url)
      .then(() => showToast('🔗 Ссылка скопирована'))
      .catch(() => showToast('Не удалось скопировать ссылку', 'error'));
  }
}

// ════════════════════════════════════════════════════════════════
// PLAYER BAR
// ════════════════════════════════════════════════════════════════
function initPlayerBar() {
  document.getElementById('playBtn').addEventListener('click',    () => Player.togglePlay());
  document.getElementById('prevBtn').addEventListener('click',    () => Player.prev());
  document.getElementById('nextBtn').addEventListener('click',    () => Player.next());

  document.getElementById('shuffleBtn').addEventListener('click', function() {
    this.classList.toggle('active', Player.toggleShuffle());
  });

  document.getElementById('repeatBtn').addEventListener('click', function() {
    this.classList.toggle('active', Player.toggleRepeat());
  });

  document.getElementById('progressBar').addEventListener('click', e => {
    const bar = e.currentTarget;
    const pct = ((e.clientX - bar.getBoundingClientRect().left) / bar.offsetWidth) * 100;
    Player.seek(pct);
  });

  const vol = document.getElementById('volumeSlider');
  vol.addEventListener('input', () => {
    Player.setVolume(vol.value / 100);
    localStorage.setItem('ss_volume', vol.value);
    updateVolumeStyle(vol.value);
  });

  document.getElementById('heartBtn').addEventListener('click', () => {
    const track = Player.currentTrack;
    if (!track) return;
    const isNowLiked = Liked.toggle(track);
    updatePlayerBar({ track });
    refreshFavorites();
    document.querySelectorAll('.like-btn[data-url]').forEach(btn => {
      if (btn.dataset.url === track.url) updateLikeButton(btn, isNowLiked);
    });
    showToast(isNowLiked ? '♥ Добавлено в избранное' : '♡ Убрано из избранного');
    Sync.pushLiked(Liked.getAll()); // синхронизируем после лайка/анлайка в плеере
  });

  document.getElementById('playerDownloadBtn').addEventListener('click', async () => {
    const track = Player.currentTrack;
    if (!track) return;
    const btn = document.getElementById('playerDownloadBtn');
    if (btn.classList.contains('downloaded')) {
      handleDelete(track, btn);
    } else {
      const cardBtn = document.querySelector('.download-btn[data-url]');
      handleDownload(track, cardBtn && cardBtn.dataset.url === track.url ? cardBtn : btn);
    }
  });

  document.getElementById('playerShareBtn').addEventListener('click', () => {
    const track = Player.currentTrack;
    if (track) handleShare(track);
  });
}

function initPlayerEvents() {
  document.addEventListener('player:track-changed', ({ detail }) => {
    updatePlayerBar({ track: detail.track });
    markPlayingTrack(detail.track.url);
    if (Wave.isActive()) updateWaveNowPlaying(detail.track);
  });

  document.addEventListener('player:state-changed', ({ detail }) => {
    updatePlayerBar({ playing: detail.playing });
  });

  document.addEventListener('player:progress', ({ detail }) => {
    updatePlayerBar({
      percent:     detail.percent,
      currentTime: detail.currentTime,
      duration:    detail.duration,
    });
  });

  document.addEventListener('player:error', ({ detail }) => {
    showToast('Ошибка воспроизведения: ' + detail.message, 'error');
  });
}

function restoreVolume() {
  const saved = localStorage.getItem('ss_volume') || '80';
  const vol = document.getElementById('volumeSlider');
  vol.value = saved;
  Player.setVolume(saved / 100);
  updateVolumeStyle(saved);
}

function updateVolumeStyle(value) {
  const vol = document.getElementById('volumeSlider');
  vol.style.background =
    'linear-gradient(to right, var(--accent) ' + value + '%, var(--border) ' + value + '%)';
}

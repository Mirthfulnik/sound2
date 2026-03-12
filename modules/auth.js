// ── auth.js ───────────────────────────────────────────────────
// Telegram Login Widget + JWT хранение.
// AUTH_URL — URL вашей Yandex Function tg-auth (без /auth на конце)

const AUTH_DIRECT = 'https://functions.yandexcloud.net/d4ebehbkbja32u0et4rl';
// Роутим через CF прокси чтобы обойти CORS блокировку Yandex Functions
const CF_PROXY   = 'https://silent-boat-5c96.chatgptnik.workers.dev/?url=';
const AUTH_URL   = CF_PROXY + encodeURIComponent(AUTH_DIRECT);
const BOT_NAME   = 'sound_auth_bot';
const TOKEN_KEY  = 'ss_jwt';
const USER_KEY   = 'ss_user';

// ── Публичное API ─────────────────────────────────────────────
export const Auth = {
  // Текущий пользователь (из localStorage) или null
  get user() {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
  },

  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },

  isLoggedIn() {
    return !!this.token && !!this.user;
  },

  // Инициализация — проверяем токен на сервере
  async init() {
    const token = this.token;
    if (!token) return null;
    try {
      const res = await fetch(CF_PROXY + encodeURIComponent(AUTH_DIRECT + '/me'), {
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (!res.ok) { this.logout(); return null; }
      const data = await res.json();
      if (!data.ok) { this.logout(); return null; }
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      return data.user;
    } catch {
      // Сеть недоступна — доверяем локальному кэшу
      return this.user;
    }
  },

  logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    emit('auth:logout');
  },
};

// ── Telegram Login Widget ─────────────────────────────────────
// Вызывается из app.js когда пользователь нажимает "Войти через Telegram"
export function openTelegramLogin(onSuccess) {
  // Глобальный callback — вызывается виджетом после авторизации
  window._tgAuthCallback = async (tgData) => {
    closeModal();
    try {
      const res = await fetch(CF_PROXY + encodeURIComponent(AUTH_DIRECT + '/auth'), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(tgData),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Auth failed');
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      emit('auth:login', data.user);
      onSuccess?.(data.user);
    } catch (e) {
      emit('auth:error', e.message);
    }
  };

  // Показываем модальное окно с кнопкой Telegram Widget
  const overlay = document.createElement('div');
  overlay.id = 'tg-login-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:9999;
    background:rgba(0,0,0,.7);
    display:flex;align-items:center;justify-content:center;
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    background:var(--surface,#1a1a2e);
    border-radius:16px;padding:28px 24px;
    display:flex;flex-direction:column;align-items:center;gap:16px;
    min-width:260px;text-align:center;
  `;
  box.innerHTML = `
    <div style="font-size:32px">✈️</div>
    <div style="font-size:15px;color:var(--text,#fff);font-weight:600">Войти через Telegram</div>
    <div style="font-size:13px;color:var(--text3,#aaa)">Нажмите кнопку ниже и подтвердите вход в приложении Telegram</div>
    <div id="tg-widget-container"></div>
    <button id="tg-modal-cancel" style="
      background:none;border:none;color:var(--text3,#aaa);
      font-size:13px;cursor:pointer;padding:4px 8px;
    ">Отмена</button>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => { overlay.style.opacity = '0'; overlay.style.transition = 'opacity .2s'; requestAnimationFrame(() => { overlay.style.opacity = '1'; }); });

  const closeModal = () => {
    const el = document.getElementById('tg-login-overlay');
    if (el) el.remove();
  };

  overlay.querySelector('#tg-modal-cancel').onclick = closeModal;
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

  // Добавляем скрипт виджета в контейнер внутри модалки
  const existing = document.getElementById('tg-login-script');
  if (existing) existing.remove();

  const script = document.createElement('script');
  script.id = 'tg-login-script';
  script.src = 'https://telegram.org/js/telegram-widget.js?22';
  script.setAttribute('data-telegram-login', BOT_NAME);
  script.setAttribute('data-size',           'large');
  script.setAttribute('data-onauth',         '_tgAuthCallback(user)');
  script.setAttribute('data-request-access', 'write');
  script.async = true;

  document.getElementById('tg-widget-container').appendChild(script);
}

// ── Простой event emitter (если нет глобального) ──────────────
function emit(event, detail) {
  window.dispatchEvent(new CustomEvent(event, { detail }));
}

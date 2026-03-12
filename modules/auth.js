// ── auth.js ───────────────────────────────────────────────────
// Telegram Login Widget + JWT хранение.
// AUTH_URL — URL вашей Yandex Function tg-auth (без /auth на конце)

const AUTH_URL   = 'https://functions.yandexcloud.net/REPLACE_WITH_YOUR_AUTH_FUNCTION_ID';
const BOT_NAME   = 'REPLACE_WITH_YOUR_BOT_USERNAME'; // без @, например: skysound_bot
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
      const res = await fetch(AUTH_URL + '/me', {
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
  // Telegram Widget открывает popup и вызывает callback
  window._tgAuthCallback = async (tgData) => {
    try {
      const res = await fetch(AUTH_URL + '/auth', {
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

  // Динамически добавляем скрипт Telegram Widget
  const existing = document.getElementById('tg-login-script');
  if (existing) existing.remove();

  const script = document.createElement('script');
  script.id        = 'tg-login-script';
  script.src       = 'https://telegram.org/js/telegram-widget.js?22';
  script.setAttribute('data-telegram-login',    BOT_NAME);
  script.setAttribute('data-size',              'large');
  script.setAttribute('data-onauth',            '_tgAuthCallback(user)');
  script.setAttribute('data-request-access',    'write');
  script.async = true;

  // Временный контейнер — widget сам откроет popup
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;opacity:0;pointer-events:none;top:0;left:0;';
  container.appendChild(script);
  document.body.appendChild(container);

  // Скрипт загружается и автоматически открывает popup Telegram
  // Удалим контейнер через 30 секунд если не авторизовался
  setTimeout(() => container.remove(), 30000);
}

// ── Простой event emitter (если нет глобального) ──────────────
function emit(event, detail) {
  window.dispatchEvent(new CustomEvent(event, { detail }));
}

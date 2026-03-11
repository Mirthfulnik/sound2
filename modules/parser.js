// ── parser.js ─────────────────────────────────────────────────
// All network requests go through a CORS proxy.
// Primary:  Yandex Cloud Function (stable in RU)
// Fallback: Cloudflare Worker

const PROXIES = [
  'https://functions.yandexcloud.net/d4ebfvpcafvdghfva6fs?url=',
  'https://silent-boat-5c96.chatgptnik.workers.dev/?url=',
];
const BASE = 'https://skysound7.com';

// Genre slugs available on skysound7.com
export const GENRES = [
  { label: 'Все жанры',    value: '' },
  { label: 'Dance',        value: 'dance' },
  { label: 'Rap',          value: 'rap' },
  { label: 'Альтернатива', value: 'alternative' },
  { label: 'Рок',          value: 'rock' },
  { label: 'Классика',     value: 'classical' },
  { label: 'Jazz',         value: 'jazz' },
  { label: 'Blues',        value: 'blues' },
  { label: 'Авторская',    value: 'singer' },
  { label: 'Инструментал', value: 'instrumental' },
];

// ── Low-level fetch with fallback ─────────────────────────────
// Tries each proxy in order, returns first successful response.
export async function fetchPage(url) {
  const encoded = encodeURIComponent(url);
  let lastError;

  for (const proxy of PROXIES) {
    try {
      const res = await fetch(proxy + encoded, {
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // Sanity check — proxy returned JSON error instead of HTML
      if (text.startsWith('{"ok":false')) {
        throw new Error('Proxy error: ' + text);
      }
      return text;
    } catch (e) {
      lastError = e;
      console.warn(`[parser] proxy failed (${proxy}):`, e.message);
      // Try next proxy
    }
  }

  throw new Error(`Все прокси недоступны. Последняя ошибка: ${lastError?.message}`);
}

// ── Track list parser ─────────────────────────────────────────
// skysound7 HTML structure:
// <li>
//   2:41
//   <a href="https://illit.skysound7.com/">ILLIT</a>
//   <a href="https://illit.skysound7.com/t/ID-slug/"><em>Magnetic</em></a>
// </li>


// ── HTML entity decoder ───────────────────────────────────────
// Браузерный DOMParser — самый надёжный способ декодировать
// &#039; → ' и другие entities из HTML источника
function decodeEntities(str) {
  try {
    const txt = document.createElement('textarea');
    txt.innerHTML = str;
    return txt.value;
  } catch {
    return str
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
  }
}

export function parseTrackList(html, genre = '') {
  const tracks = [];
  const liRegex = /<li(?:\s[^>]*)?>[\s\S]*?<\/li>/gi;
  let m;
  let idx = 0;

  while ((m = liRegex.exec(html)) !== null) {
    const li = m[0];

    // Must contain a /t/ track link
    const trackHref = li.match(/href="(https?:\/\/[^"]+\/t\/[^"]+?)"/i);
    if (!trackHref) continue;

    const trackUrl = ensureTrailingSlash(trackHref[1]);

    // Duration
    const durM     = li.match(/\b(\d{1,2}:\d{2})\b/);
    const duration = durM ? durM[1] : '';

    // Title: prefer <em>/<i>, fallback to link text
    let title = '';
    const emM = li.match(/<(?:em|i)[^>]*>([^<]+)<\/(?:em|i)>/i);
    if (emM) {
      title = decodeEntities(emM[1].trim());
    } else {
      const tM = li.match(/href="[^"]+\/t\/[^"]+?"[^>]*>([^<]+)<\/a>/i);
      if (tM) title = decodeEntities(tM[1].trim());
    }

    // Artist: first <a> pointing to artist subdomain (no /t/)
    let artist = '';
    const linkMatches = [...li.matchAll(/href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const lm of linkMatches) {
      const href = lm[1];
      const text = lm[2].replace(/<[^>]+>/g, '').trim();
      if (!href.includes('/t/') && href.includes('skysound7.com') && text.length > 0) {
        artist = decodeEntities(text);
        break;
      }
    }

    // Fallback title from URL slug
    if (!title) {
      const slugM = trackUrl.match(/\/t\/[^-]+-(.+?)\/?$/);
      if (slugM) title = decodeURIComponent(slugM[1]).replace(/-/g, ' ').trim();
    }

    if (!title) continue;

    const durationSec = parseDurationToSeconds(duration);
    tracks.push({ id: idx++, url: trackUrl, artist, title, duration, durationSec, genre });
  }

  return tracks;
}

// ── MP3 extractor ─────────────────────────────────────────────
export function parseMp3(html) {
  const patterns = [
    /["'](https?:\/\/[^"'\s]+\.mp3(?:\?[^"'\s]*)?)['"]/i,
    /src:\s*["'](https?:\/\/[^"']+\.mp3[^"']*)['"]/i,
    /file:\s*["'](https?:\/\/[^"']+\.mp3[^"']*)['"]/i,
    /data-src=["'](https?:\/\/[^"']+\.mp3[^"']*)['"]/i,
  ];
  for (const p of patterns) {
    const mm = html.match(p);
    if (mm?.[1]) return mm[1];
  }
  const a = html.match(/<audio[^>]+src=["']([^"']+)["']/i);
  if (a) return a[1];
  const s = html.match(/<source[^>]+src=["']([^"']+)["']/i);
  if (s) return s[1];
  return null;
}

// ── Load genre page ───────────────────────────────────────────
export async function loadGenrePage(genreValue) {
  const url    = genreValue ? `${BASE}/top/${genreValue}/` : `${BASE}/`;
  const html   = await fetchPage(url);
  const tracks = parseTrackList(html, genreValue);
  if (!tracks.length) throw new Error('Треки не найдены на странице жанра');
  return tracks;
}

// ── Search ────────────────────────────────────────────────────
export async function search(query) {
  const q = query.trim();
  if (!q) return [];

  // Strategy 1: Google → extract artist subdomain → load it
  try {
    const gHtml = await fetchPage(
      `https://www.google.com/search?q=${encodeURIComponent(q + ' site:skysound7.com')}&num=15`
    );
    const subdomains = extractSubdomains(gHtml);
    if (subdomains.length > 0) {
      const html   = await fetchPage(`https://${subdomains[0]}.skysound7.com/`);
      const tracks = parseTrackList(html);
      if (tracks.length > 0) return tracks;
    }
  } catch { /* Google blocked or failed */ }

  // Strategy 2: transliterate → try as subdomain
  try {
    const slug = transliterate(q);
    if (slug) {
      const html   = await fetchPage(`https://${slug}.skysound7.com/`);
      const tracks = parseTrackList(html);
      if (tracks.length > 0) return tracks;
    }
  } catch { /* subdomain not found */ }

  // Strategy 3: popular page + local filter
  const html     = await fetchPage(BASE + '/');
  const tracks   = parseTrackList(html);
  const lq       = q.toLowerCase();
  return tracks.filter(t =>
    t.title.toLowerCase().includes(lq) || t.artist.toLowerCase().includes(lq)
  );
}

// ── Helpers ───────────────────────────────────────────────────
function ensureTrailingSlash(url) {
  return url.endsWith('/') ? url : url + '/';
}

function parseDurationToSeconds(dur) {
  if (!dur) return 0;
  const [m, s] = dur.split(':').map(Number);
  return (m || 0) * 60 + (s || 0);
}

function extractSubdomains(html) {
  const re   = /https?:\/\/([\w-]+)\.skysound7\.com\//gi;
  const skip = new Set(['www', 'skysound7']);
  const found = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    const sub = m[1];
    if (!skip.has(sub) && !sub.startsWith('xn--')) found.add(sub);
  }
  return [...found];
}

function transliterate(s) {
  const map = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh',
    'з':'z','и':'i','й':'j','к':'k','л':'l','м':'m','н':'n','о':'o',
    'п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts',
    'ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu',
    'я':'ya',' ':'-',"'":'','\u2019':''
  };
  return s.toLowerCase()
    .split('').map(c => map[c] !== undefined ? map[c] : c).join('')
    .replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ==UserScript==
// @name         YouTube Menu Downloader
// @namespace    https://github.com/DverkaSK/youtube-menu-downloader
// @version      0.3.0
// @description  Пункт «Скачать» в меню «⋯» на YouTube, в Shorts и YouTube Music: MP4, WEBM, MP3, аудио, субтитры
// @author       DverkaSK
// @license      MIT
// @homepageURL  https://github.com/DverkaSK/youtube-menu-downloader
// @supportURL   https://github.com/DverkaSK/youtube-menu-downloader/issues
// @updateURL    https://raw.githubusercontent.com/DverkaSK/youtube-menu-downloader/main/youtube-menu-downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/DverkaSK/youtube-menu-downloader/main/youtube-menu-downloader.user.js
// @match        https://www.youtube.com/*
// @match        https://music.youtube.com/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const IS_MUSIC = location.hostname === 'music.youtube.com';

  const DEFAULTS = {
    cobaltUrl: '',
    cobaltKey: '',
    usePublic: true,
    quality: '1080',
    bitrate: '320',
    subFormat: 'srt',
    lastFormat: 'mp4',
    lastFormatMusic: 'mp3',
  };
  const settings = Object.assign({}, DEFAULTS, GM_getValue('settings', {}));
  const saveSettings = () => GM_setValue('settings', settings);

  const FORMATS = [
    { id: 'mp4', label: 'MP4' },
    { id: 'webm', label: 'WEBM' },
    { id: 'mp3', label: 'MP3' },
    { id: 'audio', label: 'Аудио' },
    { id: 'subs', label: 'Субтитры' },
  ];
  const QUALITIES = ['max', '2160', '1440', '1080', '720', '480', '360', '240', '144'];
  const BITRATES = ['320', '256', '128', '96', '64'];
  const SUB_FORMATS = ['srt', 'vtt', 'txt'];

  // ---------------------------------------------------------------------------
  // Токен субтитров. YouTube отдаёт /api/timedtext только с pot-токеном, который
  // плеер добавляет сам, когда включаются субтитры. Подсматриваем его запросы.

  const timedtextUrls = new Map(); // videoId -> URL запроса плеера с pot
  const TIMEDTEXT_OWN_PARAMS = new Set(['lang', 'kind', 'tlang', 'fmt', 'name']);

  function sniff(url) {
    if (typeof url !== 'string' || !url.includes('/api/timedtext')) return;
    try {
      const u = new URL(url, location.origin);
      const v = u.searchParams.get('v');
      if (v && u.searchParams.has('pot')) timedtextUrls.set(v, u.href);
    } catch {}
  }

  function wrapPage(obj, name, make) {
    try {
      const orig = obj[name];
      if (typeof orig !== 'function') return;
      let fn = make(orig);
      if (typeof exportFunction === 'function') fn = exportFunction(fn, W);
      obj[name] = fn;
    } catch (e) {
      console.warn('[ytdm] не удалось перехватить', name, e);
    }
  }

  wrapPage(W.XMLHttpRequest.prototype, 'open', (orig) => function (method, url) {
    sniff(String(url));
    return orig.apply(this, arguments);
  });
  wrapPage(W, 'fetch', (orig) => function (input) {
    sniff(input && typeof input === 'object' && typeof input.url === 'string' ? input.url : String(input));
    return orig.apply(this, arguments);
  });

  // ---------------------------------------------------------------------------
  // Данные о видео

  const textOf = (n) => n?.simpleText ?? n?.runs?.map((r) => r.text).join('') ?? '';

  function getPlayerResponse(videoId) {
    const ids = location.pathname.startsWith('/shorts/') ? ['shorts-player', 'movie_player'] : ['movie_player'];
    const matches = (r) => r?.videoDetails && (!videoId || r.videoDetails.videoId === videoId);
    for (const id of ids) {
      try {
        const r = W.document.getElementById(id)?.getPlayerResponse?.();
        if (matches(r)) return r;
      } catch {}
    }
    const init = W.ytInitialPlayerResponse;
    return matches(init) ? init : null;
  }

  function currentVideoId() {
    const shorts = location.pathname.match(/^\/shorts\/([\w-]{11})/);
    if (shorts) return shorts[1];
    const v = new URLSearchParams(location.search).get('v');
    if (v) return v;
    return getPlayerResponse()?.videoDetails?.videoId || null;
  }

  // Данные о видео, которое сейчас не играет (карточка на главной, в канале и т.д.).
  async function fetchPlayerResponse(videoId) {
    try {
      const context = JSON.parse(JSON.stringify(W.ytcfg?.get?.('INNERTUBE_CONTEXT') || null));
      if (!context) return null;
      const key = W.ytcfg.get('INNERTUBE_API_KEY');
      const r = await fetch(`/youtubei/v1/player?prettyPrint=false${key ? `&key=${key}` : ''}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, videoId }),
      });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  function videoInfo(videoId, titleHint, pr = getPlayerResponse(videoId)) {
    const tl = pr?.captions?.playerCaptionsTracklistRenderer;
    const pageTitle = videoId === currentVideoId() && document.title.replace(/\s+-\s+YouTube( Music)?$/, '').trim();
    return {
      videoId,
      loaded: Boolean(pr),
      title: pr?.videoDetails?.title || titleHint || pageTitle || videoId,
      tracks: (tl?.captionTracks || []).map((t) => ({
        baseUrl: t.baseUrl,
        lang: t.languageCode,
        auto: t.kind === 'asr',
        name: textOf(t.name) || t.languageCode,
      })),
      translations: (tl?.translationLanguages || []).map((l) => ({
        code: l.languageCode,
        name: textOf(l.languageName) || l.languageCode,
      })),
    };
  }

  const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

  // ---------------------------------------------------------------------------
  // DOM-хелперы. На YouTube включены Trusted Types, поэтому без innerHTML.

  function h(tag, props = {}, ...children) {
    const svg = tag === 'svg' || tag === 'path';
    const el = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class' || svg || !(k in el)) el.setAttribute(k, v);
      else el[k] = v;
    }
    return el;
  }

  const downloadIcon = () =>
    h('svg', { viewBox: '0 0 24 24', class: 'ytdm-icon', 'aria-hidden': 'true' },
      h('path', { d: 'M17 18v1H6v-1h11zm-.5-6.6-.7-.7-3.3 3.3V4h-1v10l-3.3-3.3-.7.7 4.5 4.5 4.5-4.5z' }));

  const isVisible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  function clickLink(url, download) {
    const a = h('a', { href: url, download, target: download ? null : '_blank', rel: 'noopener noreferrer' });
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    clickLink(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const safeName = (s) =>
    s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'video';

  // ---------------------------------------------------------------------------
  // Пункт «Скачать» в меню «⋯»

  // Кнопка «⋯» основного (играющего) видео.
  function playerMenuVideoId(el) {
    if (IS_MUSIC) {
      const menu = el.closest('ytmusic-menu-renderer');
      if (!menu || !menu.closest('ytmusic-player-bar') || el.closest('#top-level-buttons')) return null;
      return currentVideoId();
    }
    if (location.pathname.startsWith('/shorts/')) {
      if (!el.closest('ytd-reel-video-renderer, ytd-shorts')) return null;
      return el.closest('#menu-button, ytd-menu-renderer') ? currentVideoId() : null;
    }
    if (location.pathname === '/watch') {
      if (!el.closest('ytd-watch-metadata ytd-menu-renderer')) return null;
      if (el.closest('#top-level-buttons-computed, #flexible-item-buttons')) return null;
      return currentVideoId();
    }
    return null;
  }

  // Меню у комментариев, шапки и т.п. — там «Скачать» не нужен, хотя ссылки на видео бывают.
  const CARD_EXCLUDE = [
    'ytd-comment-thread-renderer', 'ytd-comment-view-model', 'ytd-comment-renderer',
    'ytd-masthead', '#masthead-container', 'ytd-guide-renderer', 'ytmusic-nav-bar', 'tp-yt-iron-dropdown',
  ].join(', ');
  // Карточки плейлистов и миксов: ссылка в них ведёт на первое видео, качать его неожиданно.
  const PLAYLIST_CARD = [
    'ytd-playlist-renderer', 'ytd-grid-playlist-renderer', 'ytd-compact-playlist-renderer',
    'ytd-radio-renderer', 'ytd-compact-radio-renderer', 'yt-collection-thumbnail-view-model', 'yt-collections-stack',
  ].join(', ');
  const VIDEO_LINKS = 'a[href*="watch?v="], a[href*="/shorts/"]';

  function videoIdFromHref(href) {
    try {
      const u = new URL(href, location.origin);
      const shorts = u.pathname.match(/^\/shorts\/([\w-]{11})/);
      if (shorts) return shorts[1];
      if (u.pathname === '/watch') return u.searchParams.get('v');
    } catch {}
    return null;
  }

  function cardTitle(card, links) {
    const t = card.querySelector('#video-title, #video-title-link, h3, .title');
    const text = t?.getAttribute('title') || t?.textContent?.trim();
    return text || [...links].map((a) => a.getAttribute('title') || a.getAttribute('aria-label')).find(Boolean) || '';
  }

  // Кнопка «⋯» на карточке видео где угодно: главная, канал, поиск, рекомендации,
  // плейлисты, полки Shorts, списки YouTube Music. Поднимаемся от кнопки до первого
  // предка со ссылками на видео; если ссылки ведут на разные видео — это уже не карточка.
  function cardMenuTarget(el) {
    if (!el.closest('button, [role="button"], yt-icon-button, ytd-menu-renderer, ytmusic-menu-renderer')) return null;
    if (el.closest('a[href]') || el.closest(CARD_EXCLUDE)) return null;
    let node = el.parentElement;
    for (let depth = 0; node && node !== document.body && depth < 15; depth++, node = node.parentElement) {
      const links = node.querySelectorAll(VIDEO_LINKS);
      if (!links.length) continue;
      const ids = new Set([...links].map((a) => videoIdFromHref(a.getAttribute('href'))).filter(Boolean));
      if (ids.size !== 1 || node.matches(PLAYLIST_CARD) || node.querySelector(PLAYLIST_CARD)) return null;
      return { videoId: [...ids][0], title: cardTitle(node, links) };
    }
    return null;
  }

  // Возвращает { videoId, title }, если клик пришёлся на кнопку «⋯» видео.
  function menuTarget(el) {
    const videoId = playerMenuVideoId(el);
    return videoId ? { videoId, title: '' } : cardMenuTarget(el);
  }

  // Сами пункты меню: новый (view-model) и старый (Polymer) варианты, плюс YouTube Music.
  const MENU_ITEM_SELECTORS = [
    'yt-list-item-view-model',
    'ytd-menu-service-item-renderer',
    'ytd-menu-navigation-item-renderer',
    'ytmusic-menu-service-item-renderer',
    'ytmusic-menu-navigation-item-renderer',
    'ytmusic-toggle-menu-service-item-renderer',
    '[role="menuitem"]:not(.ytdm-item)',
  ].join(', ');

  // Контейнеры списка — на случай, если пункты ещё не отрисованы.
  const MENU_LIST_SELECTORS = [
    'yt-list-view-model',
    'ytd-menu-popup-renderer #items',
    'ytmusic-menu-popup-renderer #items',
    'tp-yt-paper-listbox',
  ];

  // Возвращает { parent, ref }: куда вставлять пункт и перед каким пунктом.
  function findOpenMenu() {
    for (const dropdown of document.querySelectorAll('tp-yt-iron-dropdown')) {
      if (!isVisible(dropdown)) continue;
      const ref = [...dropdown.querySelectorAll(MENU_ITEM_SELECTORS)].find(isVisible);
      if (ref) return { dropdown, parent: ref.parentNode, ref };
      for (const sel of MENU_LIST_SELECTORS) {
        const list = dropdown.querySelector(sel);
        if (list && isVisible(list)) return { dropdown, parent: list, ref: list.firstElementChild };
      }
    }
    return null;
  }

  // Подгоняем размеры под соседний пункт. Меню может открываться с анимацией
  // масштаба, поэтому расстояния делим на текущий масштаб.
  function matchItemLook(item, ref) {
    if (!ref) return;
    const r = ref.getBoundingClientRect();
    const scale = ref.offsetWidth ? r.width / ref.offsetWidth || 1 : 1;
    if (ref.offsetHeight) item.style.minHeight = `${ref.offsetHeight}px`;
    const icon = ref.querySelector('yt-icon, svg, img');
    const ir = icon?.getBoundingClientRect();
    if (ir?.width) {
      item.style.paddingLeft = `${Math.round((ir.left - r.left) / scale)}px`;
      item.querySelector('.ytdm-icon').style.width = item.querySelector('.ytdm-icon').style.height = `${Math.round(ir.width / scale)}px`;
    }
    const text = [...ref.querySelectorAll('*')].find((el) =>
      !el.childElementCount && el.textContent.trim() && !el.closest('svg, yt-icon'));
    if (text) {
      const cs = getComputedStyle(text);
      item.style.font = cs.font;
      item.style.color = cs.color;
      if (ir?.width) item.style.gap = `${Math.max(8, Math.round((text.getBoundingClientRect().left - ir.right) / scale))}px`;
    }
  }

  const removeMenuItems = () => document.querySelectorAll('.ytdm-item').forEach((el) => el.remove());

  function closeMenu(dropdown) {
    try {
      if (typeof dropdown?.close === 'function') return dropdown.close();
    } catch {}
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }

  function injectMenuItem({ dropdown, parent, ref }, target) {
    removeMenuItems();
    const item = h('div', {
      class: 'ytdm-item',
      role: 'menuitem',
      tabIndex: 0,
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(dropdown);
        openDialog(target);
      },
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.currentTarget.click();
        }
      },
    }, downloadIcon(), h('span', {}, 'Скачать'));
    // stopPropagation в onclick не даёт tp-yt-paper-listbox принять пункт за свой.
    parent.insertBefore(item, ref);
    matchItemLook(item, ref);
    try {
      dropdown?.refit?.();
    } catch {}
  }

  // Меню рендерится асинхронно после клика, поэтому недолго ждём его появления.
  let menuWait = 0;
  function waitForMenu(target) {
    const token = ++menuWait;
    const started = Date.now();
    const tick = () => {
      if (token !== menuWait) return;
      const menu = findOpenMenu();
      if (menu) return injectMenuItem(menu, target);
      if (Date.now() - started < 2000) setTimeout(tick, 40);
    };
    setTimeout(tick, 30);
  }

  window.addEventListener('click', (e) => {
    const el = e.composedPath?.()[0] ?? e.target;
    if (!(el instanceof Element) || el.closest('.ytdm-item, .ytdm-overlay')) return;
    removeMenuItems();
    const target = menuTarget(el);
    if (target) waitForMenu(target);
    else menuWait++;
  }, true);

  // ---------------------------------------------------------------------------
  // cobalt (MP4 / WEBM / аудио)

  // Публичные инстансы без ключа. Они бывают перегружены, поэтому идут после своего.
  const PUBLIC_COBALT_APIS = ['https://cobalt-api.kwiatekmiki.com/'];
  // Веб-версия cobalt — запасной вариант, ссылка передаётся через #.
  const FALLBACK_SITE = (url) => `https://cobalt.meowing.de/#${url}`;

  const normalizeApi = (url) => url.trim().replace(/\/+$/, '') + '/';

  function cobaltInstances() {
    const list = [settings.cobaltUrl, ...(settings.usePublic ? PUBLIC_COBALT_APIS : [])].filter(Boolean).map(normalizeApi);
    return [...new Set(list)];
  }

  function cobaltRequest(base, method, body) {
    const url = normalizeApi(base);
    return new Promise((resolve, reject) => {
      const headers = { Accept: 'application/json' };
      if (body) headers['Content-Type'] = 'application/json';
      if (settings.cobaltKey && url === normalizeApi(settings.cobaltUrl)) headers.Authorization = `Api-Key ${settings.cobaltKey}`;
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body ? JSON.stringify(body) : undefined,
        timeout: 30000,
        onload: (r) => {
          let json = null;
          try {
            json = JSON.parse(r.responseText);
          } catch {}
          resolve({ status: r.status, json });
        },
        onerror: () => reject(new Error(`Нет связи с ${url}`)),
        ontimeout: () => reject(new Error('Сервер cobalt не ответил вовремя')),
      });
    });
  }

  function cobaltError(error) {
    const code = error?.code || 'unknown';
    if (code.includes('auth')) return 'Сервер cobalt требует авторизацию: укажите API-ключ или используйте свой инстанс';
    if (code.includes('youtube.login') || code.includes('youtube.token')) return 'YouTube не пускает сервер cobalt (нужен вход / токен на стороне сервера)';
    if (code.includes('content.too_long')) return 'Видео слишком длинное для этого сервера cobalt';
    if (code.includes('unavailable') || code.includes('private')) return 'Видео недоступно серверу cobalt';
    if (code.includes('rate_exceeded')) return 'Слишком много запросов, попробуйте позже';
    return `Ошибка cobalt: ${code}`;
  }

  function cobaltBody(videoId, format) {
    const body = { url: watchUrl(videoId), filenameStyle: 'pretty' };
    if (format === 'mp4' || format === 'webm') {
      // В cobalt контейнер определяется кодеком: h264/av1 -> mp4, vp9 -> webm.
      // Выше 1080p у YouTube нет H.264, поэтому для MP4 берём AV1.
      const high = settings.quality === 'max' || Number(settings.quality) > 1080;
      body.downloadMode = 'auto';
      body.videoQuality = settings.quality;
      body.youtubeVideoCodec = format === 'webm' ? 'vp9' : high ? 'av1' : 'h264';
    } else {
      body.downloadMode = 'audio';
      body.audioFormat = format === 'mp3' ? 'mp3' : 'best';
      if (format === 'mp3') body.audioBitrate = settings.bitrate;
    }
    return body;
  }

  async function downloadFrom(base, info, format) {
    const { status, json } = await cobaltRequest(base, 'POST', cobaltBody(info.videoId, format));
    if (!json) throw new Error(`HTTP ${status}`);
    if (json.status === 'error') throw new Error(cobaltError(json.error));
    const url = json.url || json.picker?.[0]?.url;
    if (!url) throw new Error(`неожиданный ответ: ${json.status}`);
    // tunnel отдаётся с Content-Disposition: attachment, поэтому страница не уходит,
    // а просто начинается загрузка. redirect ведёт на сам поток — его во вкладку.
    if (json.status === 'tunnel') clickLink(url);
    else GM_openInTab(url, { active: true });
    return url;
  }

  // Возвращает { url } при успехе или { fallback, errors }, если ни один сервер не справился.
  async function downloadViaCobalt(info, format) {
    const errors = [];
    for (const base of cobaltInstances()) {
      try {
        return { url: await downloadFrom(base, info, format) };
      } catch (e) {
        errors.push(`${new URL(base).host}: ${e.message}`);
      }
    }
    const fallback = FALLBACK_SITE(watchUrl(info.videoId));
    GM_setClipboard(watchUrl(info.videoId), 'text');
    GM_openInTab(fallback, { active: true });
    return { fallback, errors };
  }

  // ---------------------------------------------------------------------------
  // Субтитры

  function timestamp(ms, sep) {
    const p = (n, len = 2) => String(Math.floor(n)).padStart(len, '0');
    return `${p(ms / 3600000)}:${p((ms / 60000) % 60)}:${p((ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
  }

  function json3ToCues(json) {
    const cues = [];
    for (const ev of json.events || []) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/​/g, '').trim();
      if (!text) continue;
      const start = ev.tStartMs || 0;
      cues.push({ start, end: start + (ev.dDurationMs || 2000), text });
    }
    // Автосубтитры идут «окном» из двух строк, обрезаем наложения.
    for (let i = 0; i < cues.length - 1; i++) {
      if (cues[i].end > cues[i + 1].start) cues[i].end = Math.max(cues[i + 1].start, cues[i].start + 1);
    }
    return cues;
  }

  const toSrt = (cues) =>
    cues.map((c, i) => `${i + 1}\n${timestamp(c.start, ',')} --> ${timestamp(c.end, ',')}\n${c.text}\n`).join('\n');
  const toVtt = (cues) =>
    'WEBVTT\n\n' + cues.map((c) => `${timestamp(c.start, '.')} --> ${timestamp(c.end, '.')}\n${c.text}\n`).join('\n');
  const toTxt = (cues) => cues.map((c) => c.text).join('\n') + '\n';

  async function downloadSubs(info, trackIndex, tlang) {
    const track = info.tracks[trackIndex];
    if (!track) throw new Error('У этого видео нет субтитров');
    const u = new URL(track.baseUrl, location.origin);
    const captured = timedtextUrls.get(info.videoId);
    if (captured) {
      for (const [k, v] of new URL(captured).searchParams) {
        if (!TIMEDTEXT_OWN_PARAMS.has(k) && !u.searchParams.has(k)) u.searchParams.set(k, v);
      }
    }
    u.searchParams.set('fmt', 'json3');
    if (tlang) u.searchParams.set('tlang', tlang);
    else u.searchParams.delete('tlang');

    const r = await fetch(u.href, { credentials: 'include' });
    const text = r.ok ? await r.text() : '';
    if (!text.trim()) {
      throw new Error(captured
        ? 'YouTube вернул пустые субтитры. Обновите страницу и попробуйте снова'
        : 'YouTube не отдаёт субтитры без токена плеера. Откройте это видео, включите субтитры (CC) на пару секунд и нажмите «Скачать» ещё раз');
    }
    const cues = json3ToCues(JSON.parse(text));
    const fmt = settings.subFormat;
    const out = fmt === 'vtt' ? toVtt(cues) : fmt === 'txt' ? toTxt(cues) : toSrt(cues);
    saveBlob(new Blob([out], { type: 'text/plain;charset=utf-8' }), `${safeName(info.title)}.${tlang || track.lang}.${fmt}`);
  }

  // ---------------------------------------------------------------------------
  // yt-dlp

  function ytdlpCommand(info, format, trackIndex, tlang) {
    const url = `"${watchUrl(info.videoId)}"`;
    const hq = settings.quality === 'max' ? '' : `[height<=${settings.quality}]`;
    switch (format) {
      case 'mp4':
        return `yt-dlp -f "bv*${hq}[ext=mp4]+ba[ext=m4a]/b${hq}[ext=mp4]/bv*${hq}+ba/b" --merge-output-format mp4 ${url}`;
      case 'webm':
        return `yt-dlp -f "bv*${hq}[ext=webm]+ba[ext=webm]/b${hq}[ext=webm]" ${url}`;
      case 'mp3':
        return `yt-dlp -x --audio-format mp3 --audio-quality ${settings.bitrate}K ${url}`;
      case 'audio':
        return `yt-dlp -f ba ${url}`;
      case 'subs': {
        const track = info.tracks[trackIndex];
        const auto = tlang || track?.auto ? '--write-auto-subs' : '--write-subs';
        const lang = tlang || track?.lang || 'all';
        const conv = settings.subFormat === 'vtt' ? 'vtt' : 'srt';
        return `yt-dlp --skip-download ${auto} --sub-langs ${lang} --convert-subs ${conv} ${url}`;
      }
    }
    return `yt-dlp ${url}`;
  }

  // ---------------------------------------------------------------------------
  // Диалог

  let overlay = null;

  function closeDialog() {
    overlay?.remove();
    overlay = null;
  }

  const button = (label, kind, onclick) => h('button', { type: 'button', class: `ytdm-btn ytdm-btn-${kind}`, onclick }, label);
  const field = (label, control) => h('label', { class: 'ytdm-field' }, h('span', {}, label), control);
  const hint = (text) => h('div', { class: 'ytdm-hint' }, text);
  const select = (options, value, onchange) =>
    h('select', { class: 'ytdm-select', value, onchange: (e) => onchange(e.target.value) },
      options.map(([v, label]) => h('option', { value: v }, label)));

  // target: { videoId, title } или null, если видео не найдено.
  function openDialog(target, view = 'main') {
    closeDialog();
    const info = target?.videoId ? videoInfo(target.videoId, target.title) : null;
    const formatKey = IS_MUSIC ? 'lastFormatMusic' : 'lastFormat';
    const state = { view: info ? view : 'settings', format: settings[formatKey], track: 0, tlang: '' };

    const body = h('div', { class: 'ytdm-body' });
    const status = h('div', { class: 'ytdm-status', role: 'status' });

    function setStatus(content, kind = 'info') {
      status.replaceChildren(...[content].flat().filter(Boolean));
      status.className = `ytdm-status ytdm-status-${kind}`;
    }

    function renderOptions() {
      const noCobalt = !cobaltInstances().length && hint('Серверы cobalt отключены в настройках — откроется веб-версия cobalt.');
      switch (state.format) {
        case 'mp4':
        case 'webm': {
          const high = settings.quality === 'max' || Number(settings.quality) > 1080;
          return [
            field('Качество', select(
              QUALITIES.map((q) => [q, q === 'max' ? 'Максимальное' : `${q}p`]),
              settings.quality,
              (v) => { settings.quality = v; saveSettings(); render(); },
            )),
            hint(state.format === 'webm' ? 'VP9 + Opus' : high ? 'Выше 1080p MP4 будет в кодеке AV1' : 'H.264 + AAC, открывается везде'),
            noCobalt,
          ];
        }
        case 'mp3':
          return [
            field('Битрейт', select(BITRATES.map((b) => [b, `${b} кбит/с`]), settings.bitrate,
              (v) => { settings.bitrate = v; saveSettings(); })),
            noCobalt,
          ];
        case 'audio':
          return [hint('Оригинальная дорожка без перекодирования (обычно Opus или M4A).'), noCobalt];
        case 'subs':
          if (!info.tracks.length) return [hint('У этого видео нет субтитров.')];
          return [
            field('Дорожка', select(
              info.tracks.map((t, i) => [String(i), t.auto ? `${t.name} (автоматические)` : t.name]),
              String(state.track),
              (v) => { state.track = Number(v); },
            )),
            info.translations.length > 0 && field('Перевод', select(
              [['', 'Без перевода'], ...info.translations.map((l) => [l.code, l.name])],
              state.tlang,
              (v) => { state.tlang = v; },
            )),
            field('Формат', select(SUB_FORMATS.map((f) => [f, f.toUpperCase()]), settings.subFormat,
              (v) => { settings.subFormat = v; saveSettings(); })),
            !timedtextUrls.has(info.videoId) && hint('Если скачать не получится — включите субтитры (CC) в плеере и повторите.'),
          ];
      }
      return [];
    }

    function renderMain() {
      const download = button('Скачать', 'primary', async () => {
        download.disabled = true;
        setStatus('Готовлю…');
        try {
          if (state.format === 'subs') {
            await downloadSubs(info, state.track, state.tlang);
            setStatus('Субтитры сохранены', 'ok');
          } else {
            const { url, fallback, errors } = await downloadViaCobalt(info, state.format);
            if (url) {
              setStatus(['Загрузка началась. Если нет — ', h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'откройте ссылку')], 'ok');
            } else {
              setStatus([
                'Серверы cobalt не ответили, открыл ',
                h('a', { href: fallback, target: '_blank', rel: 'noopener noreferrer' }, 'веб-версию cobalt'),
                ' во вкладке (ссылка на видео в буфере обмена).',
                errors.length > 0 && h('code', {}, ' ' + errors.join('; ')),
              ], 'error');
            }
          }
        } catch (e) {
          setStatus(e.message || String(e), 'error');
        } finally {
          download.disabled = false;
        }
      });
      const copy = button('yt-dlp', 'tonal', () => {
        const cmd = ytdlpCommand(info, state.format, state.track, state.tlang);
        GM_setClipboard(cmd, 'text');
        setStatus(['Команда скопирована: ', h('code', {}, cmd)], 'ok');
      });
      return [
        h('div', { class: 'ytdm-video', title: info.title }, info.title),
        h('div', { class: 'ytdm-chips' }, FORMATS.map((f) => h('button', {
          type: 'button',
          class: `ytdm-chip${f.id === state.format ? ' ytdm-chip-on' : ''}`,
          onclick: () => {
            state.format = settings[formatKey] = f.id;
            saveSettings();
            setStatus('');
            render();
          },
        }, f.label))),
        h('div', { class: 'ytdm-options' }, renderOptions()),
        status,
        h('div', { class: 'ytdm-actions' },
          button('Настройки', 'text', () => { state.view = 'settings'; setStatus(''); render(); }),
          h('div', { class: 'ytdm-spacer' }),
          copy,
          download),
      ];
    }

    function renderSettings() {
      const url = h('input', { class: 'ytdm-input', type: 'url', placeholder: 'https://cobalt.example.com/', value: settings.cobaltUrl });
      const key = h('input', { class: 'ytdm-input', type: 'password', placeholder: 'необязательно', value: settings.cobaltKey, autocomplete: 'off' });
      const usePublic = h('input', { type: 'checkbox', checked: settings.usePublic });
      const apply = () => {
        settings.cobaltUrl = url.value.trim();
        settings.cobaltKey = key.value.trim();
        settings.usePublic = usePublic.checked;
        saveSettings();
      };
      return [
        hint('MP4, WEBM и аудио скачиваются через серверы cobalt (github.com/imputnet/cobalt). По умолчанию используется бесплатный публичный сервер; если он не ответит, откроется веб-версия cobalt. Свой сервер, если указан, пробуется первым.'),
        h('label', { class: 'ytdm-check' }, usePublic, h('span', {}, `Публичные серверы (${PUBLIC_COBALT_APIS.map((u) => new URL(u).host).join(', ')})`)),
        field('Свой сервер cobalt (необязательно)', url),
        field('API-ключ своего сервера', key),
        status,
        h('div', { class: 'ytdm-actions' },
          info && button('Назад', 'text', () => { state.view = 'main'; setStatus(''); render(); }),
          h('div', { class: 'ytdm-spacer' }),
          button('Проверить', 'tonal', async () => {
            apply();
            const bases = cobaltInstances();
            if (!bases.length) return setStatus('Нет серверов для проверки', 'error');
            setStatus('Проверяю…');
            const results = await Promise.all(bases.map(async (base) => {
              const host = new URL(base).host;
              try {
                const { status: code, json } = await cobaltRequest(base, 'GET');
                const version = json?.cobalt?.version;
                return version ? `${host}: cobalt ${version} доступен` : `${host}: не API cobalt (HTTP ${code})`;
              } catch (e) {
                return `${host}: ${e.message}`;
              }
            }));
            setStatus(results.join('\n'), 'info');
          }),
          button('Сохранить', 'primary', () => {
            apply();
            if (info) {
              state.view = 'main';
              setStatus('');
              render();
            } else setStatus('Сохранено', 'ok');
          })),
      ];
    }

    function render() {
      body.replaceChildren(...(state.view === 'settings' ? renderSettings() : renderMain()).flat().filter(Boolean));
      dialog.querySelector('.ytdm-heading').textContent = state.view === 'settings' ? 'Настройки загрузки' : 'Скачать';
    }

    const dialog = h('div', { class: 'ytdm-dialog', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'ytdm-header' },
        h('div', { class: 'ytdm-heading' }),
        h('button', { type: 'button', class: 'ytdm-close', 'aria-label': 'Закрыть', onclick: closeDialog }, '✕')),
      body);

    overlay = h('div', { class: 'ytdm-overlay', onclick: (e) => { if (e.target === overlay) closeDialog(); } }, dialog);
    // Не даём горячим клавишам YouTube срабатывать, пока открыт диалог.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      overlay.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'keydown' && e.key === 'Escape') closeDialog();
      });
    }
    render();
    document.body.append(overlay);
    (dialog.querySelector('.ytdm-btn-primary') || dialog).focus();
    if (!info) setStatus('Откройте страницу с видео, чтобы скачать его');

    // Видео не играет — название и субтитры подгружаем отдельно.
    if (info && !info.loaded) {
      const opened = overlay;
      fetchPlayerResponse(info.videoId).then((pr) => {
        if (!pr?.videoDetails || overlay !== opened) return;
        Object.assign(info, videoInfo(info.videoId, info.title, pr));
        render();
      });
    }
  }

  const currentTarget = () => {
    const videoId = currentVideoId();
    return videoId ? { videoId, title: '' } : null;
  };
  GM_registerMenuCommand('Скачать текущее видео', () => openDialog(currentTarget()));
  GM_registerMenuCommand('Настройки', () => openDialog(currentTarget(), 'settings'));

  // ---------------------------------------------------------------------------
  // Стили

  GM_addStyle(`
    .ytdm-item {
      display: flex; align-items: center; gap: 16px;
      min-height: 36px; padding: 0 36px 0 16px;
      font: 400 14px/20px Roboto, Arial, sans-serif;
      color: var(--yt-spec-text-primary, #f1f1f1);
      cursor: pointer; user-select: none; outline: none;
    }
    .ytdm-item:hover, .ytdm-item:focus-visible { background: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, .1)); }
    .ytdm-icon { width: 24px; height: 24px; flex: none; fill: currentColor; }

    .ytdm-overlay {
      --ytdm-bg: var(--yt-spec-menu-background, #282828);
      --ytdm-fg: var(--yt-spec-text-primary, #f1f1f1);
      --ytdm-muted: var(--yt-spec-text-secondary, #aaa);
      --ytdm-tonal: var(--yt-spec-badge-chip-background, rgba(255, 255, 255, .1));
      --ytdm-hover: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, .2));
      --ytdm-accent: var(--yt-spec-call-to-action, #3ea6ff);
      --ytdm-on-accent: var(--yt-spec-text-primary-inverse, #0f0f0f);
      position: fixed; inset: 0; z-index: 10000;
      display: flex; align-items: center; justify-content: center;
      padding: 16px; background: rgba(0, 0, 0, .5);
      font: 400 14px/20px Roboto, Arial, sans-serif;
    }
    .ytdm-dialog {
      box-sizing: border-box; width: min(440px, 100%); max-height: 100%; overflow: auto;
      padding: 20px 24px; border-radius: 12px; outline: none;
      background: var(--ytdm-bg); color: var(--ytdm-fg);
      box-shadow: 0 4px 32px rgba(0, 0, 0, .4);
    }
    .ytdm-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .ytdm-heading { font-size: 18px; line-height: 24px; font-weight: 500; }
    .ytdm-close {
      width: 32px; height: 32px; border: 0; border-radius: 50%;
      background: transparent; color: inherit; font-size: 16px; cursor: pointer;
    }
    .ytdm-close:hover { background: var(--ytdm-hover); }
    .ytdm-body { display: flex; flex-direction: column; gap: 14px; }
    .ytdm-video { color: var(--ytdm-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ytdm-chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .ytdm-chip {
      height: 32px; padding: 0 12px; border: 0; border-radius: 8px;
      background: var(--ytdm-tonal); color: var(--ytdm-fg);
      font: 500 14px Roboto, Arial, sans-serif; cursor: pointer;
    }
    .ytdm-chip:hover { background: var(--ytdm-hover); }
    .ytdm-chip-on, .ytdm-chip-on:hover { background: var(--ytdm-fg); color: var(--ytdm-bg); }
    .ytdm-options { display: flex; flex-direction: column; gap: 10px; }
    .ytdm-field { display: flex; flex-direction: column; gap: 4px; }
    .ytdm-field > span { color: var(--ytdm-muted); font-size: 12px; }
    .ytdm-select, .ytdm-input {
      box-sizing: border-box; width: 100%; height: 36px; padding: 0 10px;
      border: 1px solid transparent; border-radius: 8px;
      background: var(--ytdm-tonal); color: var(--ytdm-fg); font: inherit;
    }
    .ytdm-select:focus, .ytdm-input:focus { outline: none; border-color: var(--ytdm-accent); }
    .ytdm-select option { background: var(--ytdm-bg); color: var(--ytdm-fg); }
    .ytdm-hint { color: var(--ytdm-muted); font-size: 12px; line-height: 18px; }
    .ytdm-status:empty { display: none; }
    .ytdm-status { font-size: 13px; overflow-wrap: anywhere; white-space: pre-line; }
    .ytdm-check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
    .ytdm-check input { margin: 0; accent-color: var(--ytdm-accent); }
    .ytdm-status-error { color: #ff6b62; }
    .ytdm-status-ok { color: var(--ytdm-fg); }
    .ytdm-status a { color: var(--ytdm-accent); }
    .ytdm-status code { font: 12px/18px monospace; color: var(--ytdm-muted); }
    .ytdm-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .ytdm-spacer { flex: 1; }
    .ytdm-btn {
      height: 36px; padding: 0 16px; border: 0; border-radius: 18px;
      font: 500 14px Roboto, Arial, sans-serif; cursor: pointer;
    }
    .ytdm-btn:disabled { opacity: .5; cursor: default; }
    .ytdm-btn-primary { background: var(--ytdm-accent); color: var(--ytdm-on-accent); }
    .ytdm-btn-tonal { background: var(--ytdm-tonal); color: var(--ytdm-fg); }
    .ytdm-btn-tonal:hover { background: var(--ytdm-hover); }
    .ytdm-btn-text { background: transparent; color: var(--ytdm-accent); padding: 0 8px; }
    .ytdm-btn-text:hover { background: var(--ytdm-tonal); }
  `);
})();

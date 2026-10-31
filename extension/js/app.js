/* =========================================================================
 * 视频新标签页 · 主逻辑
 * 功能：本地视频 / 视频直链作为新标签页背景，播放列表、随机、轮换、
 *       播放参数与页面元素设置，全部数据保存在本机扩展存储中。
 * ========================================================================= */
(() => {
  'use strict';

  /* ------------------------------ 常量 ------------------------------ */

  const DEFAULT_SETTINGS = Object.freeze({
    muted: true,
    volume: 0.8,
    loop: true,
    playbackRate: 1,
    fit: 'cover',
    brightness: 1,
    blur: 0,
    dim: 0.25,
    glassBlur: 40,
    glassTint: 18,
    glassRefract: 65,
    glassEdge: 55,
    glassDisperse: 35,
    randomOnOpen: false,
    rotateEnabled: false,
    rotateMinutes: 10,
    showClock: true,
    showDate: true,
    showSearch: true,
    searchEngine: 'bing',
    currentVideoId: null,
  });

  const ENGINES = {
    bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
    baidu: { name: '百度', url: 'https://www.baidu.com/s?wd=' },
    google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  };

  const FITS = ['cover', 'contain', 'fill'];
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const ROTATE_MINUTES = [1, 5, 10, 30, 60];
  const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  const DB_NAME = 'vnt-videos';
  const DB_VERSION = 1;
  const STORE = 'videos';

  const BUILTIN_DEMO = Object.freeze({
    id: 'builtin-demo',
    name: '示例背景（可删除）',
    kind: 'builtin',
    src: 'media/demo.mp4',
    addedAt: 0,
  });

  /* ------------------------------ 状态 ------------------------------ */

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    videos: [],
    objectUrl: null,
    loadedVideoId: null,
    rotateTimer: null,
    toastTimer: null,
    persistTimer: null,
    panelOpen: false,
    menuOpen: false,
    freshInstall: false,
    hasChromeStorage: typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local),
    initDone: false,
  };

  const el = {};

  /* ------------------------------ 小工具 ------------------------------ */

  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  function svgUse(symbolId, className = 'icon') {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', className);
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#' + symbolId);
    svg.appendChild(use);
    return svg;
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '未知大小';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function guessMimeType(fileName) {
    const ext = String(fileName || '').split('.').pop().toLowerCase();
    const map = {
      mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
      ogg: 'video/ogg', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
    };
    return map[ext] || 'video/mp4';
  }

  function toast(message, duration = 3200) {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.toast.classList.remove('show'), duration);
  }

  function extensionUrl(path) {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
      try { return chrome.runtime.getURL(path); } catch (e) { /* ignore */ }
    }
    return path;
  }

  function isValidVideoRecord(record) {
    return !!record
      && typeof record.id === 'string'
      && typeof record.name === 'string'
      && (record.kind === 'local' || record.kind === 'url' || record.kind === 'builtin');
  }

  /* ------------------------------ 存储 ------------------------------ */

  function chromeStorageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (result) => {
          if (chrome.runtime && chrome.runtime.lastError) { resolve(undefined); return; }
          resolve(result ? result[key] : undefined);
        });
      } catch (e) { resolve(undefined); }
    });
  }

  function chromeStorageSet(payload) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(payload, () => {
          if (chrome.runtime && chrome.runtime.lastError) { /* 忽略写入错误 */ }
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }

  function localGet(key) {
    try {
      const raw = localStorage.getItem('vnt:' + key);
      return raw ? JSON.parse(raw) : undefined;
    } catch (e) { return undefined; }
  }

  function localSet(key, value) {
    try { localStorage.setItem('vnt:' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  async function storageGet(key) {
    if (state.hasChromeStorage) {
      const value = await chromeStorageGet(key);
      if (value !== undefined) return value;
    }
    return localGet(key);
  }

  async function storageSet(key, value) {
    if (state.hasChromeStorage) await chromeStorageSet({ [key]: value });
    localSet(key, value);
  }

  function persistSettings() {
    clearTimeout(state.persistTimer);
    state.persistTimer = setTimeout(() => { storageSet('settings', state.settings); }, 140);
  }

  async function persistSettingsNow() {
    clearTimeout(state.persistTimer);
    await storageSet('settings', state.settings);
  }

  async function persistVideos() {
    await storageSet('videos', state.videos);
  }

  /* ------------------------------ IndexedDB ------------------------------ */

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let request;
      try { request = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(err); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开本地数据库'));
    });
    return dbPromise;
  }

  async function idbPut(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('写入本地数据库失败'));
      tx.onabort = () => reject(tx.error || new Error('写入被中止'));
    });
  }

  async function idbGet(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('读取本地数据库失败'));
    });
  }

  async function idbDelete(id) {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  }

  /* ------------------------------ 设置规范化 ------------------------------ */

  function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const s = { ...DEFAULT_SETTINGS, ...source };
    s.muted = !!s.muted;
    s.loop = !!s.loop;
    s.volume = clamp(s.volume, 0, 1, DEFAULT_SETTINGS.volume);
    s.playbackRate = RATES.includes(Number(s.playbackRate)) ? Number(s.playbackRate) : DEFAULT_SETTINGS.playbackRate;
    s.fit = FITS.includes(s.fit) ? s.fit : DEFAULT_SETTINGS.fit;
    s.brightness = clamp(s.brightness, 0.2, 1.2, DEFAULT_SETTINGS.brightness);
    s.blur = clamp(s.blur, 0, 20, 0);
    s.dim = clamp(s.dim, 0, 0.8, DEFAULT_SETTINGS.dim);
    s.glassBlur = clamp(s.glassBlur, 0, 80, DEFAULT_SETTINGS.glassBlur);
    s.glassTint = clamp(s.glassTint, 0, 100, DEFAULT_SETTINGS.glassTint);
    s.glassRefract = clamp(s.glassRefract, 0, 100, DEFAULT_SETTINGS.glassRefract);
    s.glassEdge = clamp(s.glassEdge, 0, 100, DEFAULT_SETTINGS.glassEdge);
    s.glassDisperse = clamp(s.glassDisperse, 0, 100, DEFAULT_SETTINGS.glassDisperse);
    s.randomOnOpen = !!s.randomOnOpen;
    s.rotateEnabled = !!s.rotateEnabled;
    s.rotateMinutes = ROTATE_MINUTES.includes(Number(s.rotateMinutes)) ? Number(s.rotateMinutes) : DEFAULT_SETTINGS.rotateMinutes;
    s.showClock = !!s.showClock;
    s.showDate = !!s.showDate;
    s.showSearch = !!s.showSearch;
    s.searchEngine = ENGINES[s.searchEngine] ? s.searchEngine : DEFAULT_SETTINGS.searchEngine;
    s.currentVideoId = typeof s.currentVideoId === 'string' ? s.currentVideoId : null;
    return s;
  }

  /* ------------------------------ 初始化 ------------------------------ */

  async function init() {
    cacheDom();
    bindVideoEvents();
    bindUiEvents();
    await loadState();
    applySettings();
    setupGlassRefraction();
    setupCanvasGlass();
    renderVideoList();
    updateNavButtons();
    updateMuteUi();
    startClock();
    setupRotation();
    bindVisibility();
    bindStorageSync();

    const initialId = chooseInitialVideoId();
    if (initialId) await loadVideoById(initialId, { silent: true, fromInit: true });
    else clearVideo();

    document.body.classList.add('ready');

    if (state.freshInstall) {
      toast('已启用示例背景：点右上角 ≡ 菜单 → 设置，即可换成自己的视频（也可以把视频文件直接拖进页面）', 5600);
    }

    // 新标签页尽量把焦点给搜索框，方便直接打字
    if (!el.searchForm.hidden) {
      try { el.searchInput.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    state.initDone = true;
  }

  function cacheDom() {
    const byId = (id) => document.getElementById(id);
    el.video = byId('bg-video');
    el.overlay = byId('bg-overlay');
    el.clockWrap = byId('clock-wrap');
    el.clock = byId('clock');
    el.date = byId('date');
    el.menuWrap = byId('menu-wrap');
    el.btnMenu = byId('btn-menu');
    el.glassMenu = byId('glass-menu');
    el.menuCanvas = byId('menu-canvas');
    el.btnPrev = byId('btn-prev');
    el.btnNext = byId('btn-next');
    el.btnMute = byId('btn-mute');
    el.btnSettings = byId('btn-settings');
    el.searchForm = byId('search-form');
    el.searchInput = byId('search-input');
    el.emptyState = byId('empty-state');
    el.btnEmptyLocal = byId('btn-empty-local');
    el.btnEmptySettings = byId('btn-empty-settings');
    el.settingsPanel = byId('settings-panel');
    el.btnCloseSettings = byId('btn-close-settings');
    el.panelBackdrop = byId('panel-backdrop');
    el.videoList = byId('video-list');
    el.videoListEmpty = byId('video-list-empty');
    el.btnAddLocal = byId('btn-add-local');
    el.btnToggleUrl = byId('btn-toggle-url');
    el.urlForm = byId('url-form');
    el.urlInput = byId('url-input');
    el.setMuted = byId('set-muted');
    el.setVolume = byId('set-volume');
    el.setLoop = byId('set-loop');
    el.setRate = byId('set-rate');
    el.setFit = byId('set-fit');
    el.setBrightness = byId('set-brightness');
    el.setBlur = byId('set-blur');
    el.setDim = byId('set-dim');
    el.setGlassBlur = byId('set-glass-blur');
    el.setGlassTint = byId('set-glass-tint');
    el.setGlassRefract = byId('set-glass-refract');
    el.setGlassEdge = byId('set-glass-edge');
    el.setGlassDisperse = byId('set-glass-disperse');
    el.glassWarp = byId('glass-warp');
    el.glassCanvas = byId('glass-canvas');
    el.edgeR = byId('lg-edge-r');
    el.edgeG = byId('lg-edge-g');
    el.edgeB = byId('lg-edge-b');
    el.setRandom = byId('set-random');
    el.setRotate = byId('set-rotate');
    el.setRotateMinutes = byId('set-rotate-minutes');
    el.setShowClock = byId('set-show-clock');
    el.setShowDate = byId('set-show-date');
    el.setShowSearch = byId('set-show-search');
    el.setEngine = byId('set-engine');
    el.btnReset = byId('btn-reset');
    el.dragLayer = byId('drag-layer');
    el.toast = byId('toast');
    el.fileInput = byId('file-input');
  }

  async function loadState() {
    const rawSettings = await storageGet('settings');
    state.settings = normalizeSettings(rawSettings);

    const rawVideos = await storageGet('videos');
    const videos = Array.isArray(rawVideos) ? rawVideos.filter(isValidVideoRecord) : [];
    state.videos = videos;

    const initialized = await storageGet('initialized');
    state.freshInstall = !initialized;
    const hasStoredVideoList = Array.isArray(rawVideos);
    if (!initialized) {
      if (!state.videos.length) {
        state.videos = [{ ...BUILTIN_DEMO }];
        await persistVideos();
      }
      await storageSet('initialized', true);
    } else if (!hasStoredVideoList && !state.videos.length) {
      // 兼容旧版本：videos 键尚未写入过时，补回示例背景并持久化
      state.videos = [{ ...BUILTIN_DEMO }];
      await persistVideos();
    }

    if (!state.videos.some((v) => v.id === state.settings.currentVideoId)) {
      state.settings.currentVideoId = state.videos.length ? state.videos[0].id : null;
    }
  }

  function chooseInitialVideoId() {
    const videos = state.videos;
    if (!videos.length) return null;
    if (state.settings.randomOnOpen && videos.length > 1) {
      const pool = videos.filter((v) => v.id !== state.settings.currentVideoId);
      const pick = pool[Math.floor(Math.random() * pool.length)] || videos[0];
      return pick.id;
    }
    return state.settings.currentVideoId || videos[0].id;
  }

  /* ------------------------------ 视频渲染 ------------------------------ */

  async function loadVideoById(id, options = {}) {
    const record = state.videos.find((v) => v.id === id);
    if (!record) { clearVideo(); return; }
    state.settings.currentVideoId = record.id;
    await persistSettingsNow();
    renderVideoList();
    updateNavButtons();
    updateEmptyState();
    await showVideo(record);
    if (!options.silent) toast(`背景已切换：${record.name}`);
  }

  async function showVideo(record) {
    cleanupVideo();
    state.loadedVideoId = record.id;

    let src = null;
    if (record.kind === 'local') {
      try {
        const stored = await idbGet(record.id);
        if (!stored || !stored.blob) {
          toast('本地视频数据丢失，请重新添加该视频');
          await removeVideo(record.id, { silent: true });
          return;
        }
        state.objectUrl = URL.createObjectURL(stored.blob);
        src = state.objectUrl;
      } catch (err) {
        toast('读取本地视频失败：' + (err && err.message ? err.message : '未知错误'));
        return;
      }
    } else if (record.kind === 'builtin') {
      src = extensionUrl(record.src);
    } else if (record.kind === 'url') {
      src = record.src;
    }

    if (!src) return;
    const video = el.video;
    video.muted = state.settings.muted;
    video.loop = state.settings.loop;
    video.volume = state.settings.volume;
    video.playbackRate = state.settings.playbackRate;
    video.src = src;
    video.load();
    applyVideoLook();
    attemptPlay();
  }

  function cleanupVideo() {
    const video = el.video;
    try { video.pause(); } catch (e) { /* ignore */ }
    video.removeAttribute('src');
    try { video.load(); } catch (e) { /* ignore */ }
    video.classList.remove('ready');
    if (state.objectUrl) {
      try { URL.revokeObjectURL(state.objectUrl); } catch (e) { /* ignore */ }
      state.objectUrl = null;
    }
  }

  function clearVideo() {
    cleanupVideo();
    state.loadedVideoId = null;
    updateEmptyState();
  }

  function attemptPlay() {
    const video = el.video;
    let promise;
    try { promise = video.play(); } catch (e) { return; }
    if (!promise || typeof promise.catch !== 'function') return;
    promise.catch((err) => {
      if (!err) return;
      if (err.name === 'NotAllowedError') {
        if (!video.muted) {
          // 浏览器不允许带声音自动播放：退回静音播放
          video.muted = true;
          state.settings.muted = true;
          el.setMuted.checked = true;
          updateMuteUi();
          persistSettings();
          toast('浏览器禁止自动播放声音，已改为静音播放；点右上角 ≡ 菜单里的声音按钮可开启。');
          try { video.play().catch(() => {}); } catch (e) { /* ignore */ }
        }
      } else if (err.name === 'NotSupportedError') {
        toast('浏览器无法播放该视频格式，建议使用 MP4（H.264）或 WebM。');
      }
      // AbortError：切换视频时旧 play() 被取消，忽略
    });
  }

  function bindVideoEvents() {
    el.video.addEventListener('loadeddata', () => {
      el.video.classList.add('ready');
    });
    el.video.addEventListener('playing', () => {
      el.video.classList.add('ready');
    });
    el.video.addEventListener('error', () => {
      if (!state.loadedVideoId) return;
      el.video.classList.remove('ready');
      toast('无法播放这个视频：格式或编码可能不受支持（推荐 MP4 / H.264 或 WebM）', 4200);
    });
  }

  function applyVideoLook() {
    const s = state.settings;
    const root = document.documentElement;
    root.style.setProperty('--fit', s.fit);
    root.style.setProperty('--dim', String(s.dim));
    root.style.setProperty('--brightness', String(s.brightness));
    root.style.setProperty('--blur', s.blur + 'px');
    root.style.setProperty('--video-scale', s.blur > 0 ? String(1 + s.blur / 200) : '1');
  }

  function applyVideoProperties() {
    const video = el.video;
    video.loop = state.settings.loop;
    video.muted = state.settings.muted;
    video.volume = state.settings.volume;
    video.playbackRate = state.settings.playbackRate;
  }

  /* ------------------------------ 设置应用 ------------------------------ */

  const supportsSvgBackdrop = (() => {
    try {
      const probe = document.createElement('div');
      probe.style.backdropFilter = 'url(#lg-edge-probe)';
      probe.style.webkitBackdropFilter = 'url(#lg-edge-probe)';
      return probe.style.backdropFilter !== '' || probe.style.webkitBackdropFilter !== '';
    } catch (e) { return false; }
  })();

  let ringMaskReady = false;
  let glassRenderer = null;
  let menuGlassRenderer = null;

  function buildRingMask() {
    const search = el.searchForm;
    if (!search) return;
    const rect = search.getBoundingClientRect();
    const w = Math.max(40, Math.round(rect.width));
    const h = Math.max(20, Math.round(rect.height));
    const scale = 2;
    const cw = w * scale;
    const ch = h * scale;
    const edgePct = clamp(state.settings.glassEdge, 0, 100, 55) / 100;
    const strokeCss = 6 + edgePct * 11;
    const stroke = Math.round(Math.min(Math.max(strokeCss, 6), 18)) * scale;
    const inset = stroke / 2;
    const radius = Math.max(1, (ch - stroke) / 2);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + cw + '" height="' + ch + '">'
      + '<defs><filter id="soft" x="-20%" y="-20%" width="140%" height="140%">'
      + '<feGaussianBlur stdDeviation="' + (1.6 * scale) + '"/></filter></defs>'
      + '<rect x="' + inset + '" y="' + inset + '" width="' + (cw - stroke) + '" height="' + (ch - stroke) + '"'
      + ' rx="' + radius + '" fill="none" stroke="#fff" stroke-width="' + stroke + '" filter="url(#soft)"/>'
      + '</svg>';
    search.style.setProperty('--ring-mask', 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")');
    ringMaskReady = true;
  }

  function applyEdgeRefraction() {
    const search = el.searchForm;
    if (!search) return;
    const strength = clamp(state.settings.glassRefract, 0, 100, 65);
    const enabled = supportsSvgBackdrop && strength > 0;
    search.classList.toggle('has-refraction', enabled);
    if (!enabled) return;
    if (!ringMaskReady) buildRingMask();
    const maxScale = 16 * (strength / 100);
    if (el.edgeR) el.edgeR.setAttribute('scale', (maxScale * 0.985).toFixed(2));
    if (el.edgeG) el.edgeG.setAttribute('scale', maxScale.toFixed(2));
    if (el.edgeB) el.edgeB.setAttribute('scale', (maxScale * 1.015).toFixed(2));
  }

  function setupGlassRefraction() {
    if (!supportsSvgBackdrop) return;
    buildRingMask();
    window.addEventListener('resize', () => buildRingMask());
    if (typeof ResizeObserver !== 'undefined' && el.searchForm) {
      const observer = new ResizeObserver(() => buildRingMask());
      observer.observe(el.searchForm);
    }
  }

  function setupCanvasGlass() {
    if (glassRenderer || !el.glassCanvas || !el.video) return;
    if (!window.LiquidGlass || typeof window.LiquidGlass.create !== 'function') return;
    glassRenderer = window.LiquidGlass.create(el.glassCanvas, el.video, {
      onActiveChange: (active) => {
        if (el.searchForm) el.searchForm.classList.toggle('use-canvas-glass', active);
      },
    });
    if (glassRenderer) {
      glassRenderer.start();
      applyCanvasGlass();
    }
  }

  function applyCanvasGlass() {
    if (!glassRenderer) return;
    const s = state.settings;
    glassRenderer.setState({
      blur: s.glassBlur,
      tint: (s.glassTint / 100) * 0.2,
      refract: (s.glassRefract / 100) * 30,
      edgeWidth: 7 + (s.glassEdge / 100) * 17,
      dispersion: (s.glassDisperse / 100) * 0.12,
      brightness: s.brightness,
      dim: s.dim,
      fit: s.fit,
      sat: 1.8,
      videoScale: 1 + (s.blur || 0) / 200,
    });
    if (el.searchForm) {
      el.searchForm.classList.toggle('use-canvas-glass', glassRenderer.active);
    }
  }

  function applyGlassLook() {
    const root = document.documentElement;
    root.style.setProperty('--search-blur', state.settings.glassBlur + 'px');
    root.style.setProperty('--search-tint', (state.settings.glassTint / 100 * 0.2).toFixed(3));
    applyEdgeRefraction();
    applyCanvasGlass();
    applyMenuGlassState();
  }

  function applySettings() {
    const s = state.settings;
    el.setMuted.checked = s.muted;
    el.setVolume.value = String(Math.round(s.volume * 100));
    el.setLoop.checked = s.loop;
    el.setRate.value = String(s.playbackRate);
    el.setFit.value = s.fit;
    el.setBrightness.value = String(Math.round(s.brightness * 100));
    el.setBlur.value = String(s.blur);
    el.setDim.value = String(Math.round(s.dim * 100));
    el.setRandom.checked = s.randomOnOpen;
    el.setRotate.checked = s.rotateEnabled;
    el.setRotateMinutes.value = String(s.rotateMinutes);
    el.setShowClock.checked = s.showClock;
    el.setShowDate.checked = s.showDate;
    el.setShowSearch.checked = s.showSearch;
    el.setEngine.value = s.searchEngine;

    el.clockWrap.hidden = !(s.showClock || s.showDate);
    el.clock.hidden = !s.showClock;
    el.date.hidden = !s.showDate;
    el.searchForm.hidden = !s.showSearch;
    el.searchInput.placeholder = `在 ${ENGINES[s.searchEngine].name} 中搜索`;

    el.setGlassBlur.value = String(Math.round(s.glassBlur));
    el.setGlassTint.value = String(Math.round(s.glassTint));
    el.setGlassRefract.value = String(Math.round(s.glassRefract));
    el.setGlassEdge.value = String(Math.round(s.glassEdge));
    el.setGlassDisperse.value = String(Math.round(s.glassDisperse));
    applyVideoProperties();
    applyVideoLook();
    applyGlassLook();
    updateMuteUi();
    updateEmptyState();
  }

  function updateMuteUi() {
    const muted = state.settings.muted;
    const iconWrap = el.btnMute ? el.btnMute.querySelector('.menu-icon') : null;
    if (iconWrap) {
      iconWrap.textContent = '';
      iconWrap.appendChild(svgUse(muted ? 'i-muted' : 'i-volume'));
    }
    const label = el.btnMute ? el.btnMute.querySelector('.menu-label') : null;
    if (label) label.textContent = muted ? '开启声音' : '静音';
    if (el.btnMute) {
      el.btnMute.title = muted ? '开启声音' : '静音';
      el.btnMute.setAttribute('aria-label', muted ? '开启声音' : '静音');
    }
  }

  function applyMenuGlassState() {
    if (!menuGlassRenderer) return;
    const s = state.settings;
    menuGlassRenderer.setState({
      blur: s.glassBlur,
      tint: (s.glassTint / 100) * 0.2,
      refract: (s.glassRefract / 100) * 20,
      edgeWidth: 6 + (s.glassEdge / 100) * 9,
      dispersion: (s.glassDisperse / 100) * 0.12,
      brightness: s.brightness,
      dim: s.dim,
      fit: s.fit,
      sat: 1.8,
      videoScale: 1 + (s.blur || 0) / 200,
      radius: 18,
    });
  }

  function setupMenuGlass() {
    if (menuGlassRenderer || !el.menuCanvas || !el.video) return;
    if (!window.LiquidGlass || typeof window.LiquidGlass.create !== 'function') return;
    menuGlassRenderer = window.LiquidGlass.create(el.menuCanvas, el.video, {
      radius: 18,
      onActiveChange: (active) => {
        if (el.glassMenu) el.glassMenu.classList.toggle('use-canvas-glass', active);
      },
    });
    applyMenuGlassState();
  }

  function toggleMenu(open) {
    const nextOpen = typeof open === 'boolean' ? open : !state.menuOpen;
    if (nextOpen === state.menuOpen) return;
    state.menuOpen = nextOpen;
    if (!el.glassMenu) return;
    if (nextOpen) {
      updateMuteUi();
      updateNavButtons();
      el.glassMenu.hidden = false;
      if (el.btnMenu) el.btnMenu.setAttribute('aria-expanded', 'true');
      setupMenuGlass();
      applyMenuGlassState();
      if (menuGlassRenderer) {
        menuGlassRenderer.resize();
        menuGlassRenderer.start();
      }
    } else {
      el.glassMenu.hidden = true;
      if (el.btnMenu) el.btnMenu.setAttribute('aria-expanded', 'false');
      if (menuGlassRenderer) menuGlassRenderer.stop();
    }
  }

  function updateNavButtons() {
    const many = state.videos.length > 1;
    el.btnPrev.hidden = !many;
    el.btnNext.hidden = !many;
  }

  function updateEmptyState() {
    el.emptyState.hidden = state.videos.length > 0;
  }

  /* ------------------------------ 视频列表 UI ------------------------------ */

  function renderVideoList() {
    if (!el.videoList) return;
    const list = el.videoList;
    list.textContent = '';
    el.videoListEmpty.hidden = state.videos.length > 0;

    for (const record of state.videos) {
      const active = record.id === state.settings.currentVideoId;

      const item = document.createElement('div');
      item.className = 'video-item' + (active ? ' active' : '');
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', `使用 ${record.name}`);
      if (record.kind === 'url') item.title = record.src;

      const thumb = document.createElement('div');
      thumb.className = 'video-thumb';
      thumb.appendChild(svgUse(record.kind === 'url' ? 'i-link' : 'i-play'));
      item.appendChild(thumb);

      const info = document.createElement('div');
      info.className = 'video-info';
      const name = document.createElement('div');
      name.className = 'video-name';
      name.textContent = record.name || '未命名视频';
      const meta = document.createElement('div');
      meta.className = 'video-meta';
      meta.textContent = describeVideo(record);
      info.append(name, meta);
      item.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'video-actions';

      const useBtn = document.createElement('button');
      useBtn.type = 'button';
      useBtn.className = 'btn' + (active ? ' primary' : '');
      useBtn.textContent = active ? '使用中' : '使用';
      useBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!active) loadVideoById(record.id);
      });
      actions.appendChild(useBtn);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'mini-icon-btn';
      removeBtn.title = '从列表中删除';
      removeBtn.setAttribute('aria-label', `删除 ${record.name}`);
      removeBtn.appendChild(svgUse('i-trash'));
      removeBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await removeVideo(record.id);
      });
      actions.appendChild(removeBtn);

      item.appendChild(actions);

      const activate = () => { if (!active) loadVideoById(record.id); };
      item.addEventListener('click', activate);
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
      });

      list.appendChild(item);
    }
  }

  function describeVideo(record) {
    if (record.kind === 'local') return `本地视频 · ${formatBytes(record.size)}`;
    if (record.kind === 'builtin') return '内置示例';
    try { return '视频链接 · ' + new URL(record.src).hostname; } catch (e) { return '视频链接'; }
  }

  /* ------------------------------ 添加 / 删除视频 ------------------------------ */

  async function addLocalFiles(fileList) {
    const files = Array.from(fileList || []);
    const videoFiles = files.filter((file) => file && (
      (file.type && file.type.startsWith('video/'))
      || /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi)$/i.test(file.name)
    ));
    if (!videoFiles.length) { toast('没有找到可用的视频文件'); return; }

    const added = [];
    for (const file of videoFiles) {
      if (file.size === 0) { toast(`「${file.name}」是空文件，已跳过`); continue; }
      const duplicate = state.videos.find((v) => v.kind === 'local' && v.name === file.name && v.size === file.size);
      if (duplicate) { toast(`「${file.name}」已经在列表里了`); continue; }
      if (file.size > 2 * 1024 * 1024 * 1024) toast(`「${file.name}」超过 2GB，保存可能较慢或失败`, 4200);

      const id = 'local-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const mime = file.type || guessMimeType(file.name);
      const blob = file.type ? file : new Blob([file], { type: mime });
      try {
        await idbPut({ id, blob });
      } catch (err) {
        toast(`保存「${file.name}」失败：${err && err.message ? err.message : '存储空间不足'}`);
        continue;
      }
      const record = {
        id,
        name: file.name,
        kind: 'local',
        mime,
        size: file.size,
        addedAt: Date.now(),
      };
      state.videos.push(record);
      added.push(record);
    }

    if (!added.length) return;
    await persistVideos();
    renderVideoList();
    updateNavButtons();
    setupRotation();
    await loadVideoById(added[0].id, { silent: true });
    toast(added.length === 1 ? `已添加并设为背景：${added[0].name}` : `已添加 ${added.length} 个视频`, 3600);
  }

  async function removeVideo(id, options = {}) {
    const index = state.videos.findIndex((v) => v.id === id);
    if (index < 0) return;
    const record = state.videos[index];
    const wasCurrent = state.settings.currentVideoId === id;

    state.videos.splice(index, 1);
    if (record.kind === 'local') await idbDelete(id);

    if (wasCurrent) {
      const next = state.videos[Math.min(index, state.videos.length - 1)];
      state.settings.currentVideoId = next ? next.id : null;
      await persistSettingsNow();
      if (next) await showVideo(next);
      else clearVideo();
    }
    await persistVideos();
    updateNavButtons();
    setupRotation();
    updateEmptyState();
    renderVideoList();
    if (!options.silent) toast(`已删除：${record.name}`, 2200);
  }

  async function addUrlVideo(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return;
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    } catch (e) {
      toast('链接格式不正确，请粘贴视频的完整直链');
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      toast('只支持 http / https 视频直链');
      return;
    }
    if (state.videos.some((v) => v.kind === 'url' && v.src === url.href)) {
      toast('这个链接已经在列表里了');
      return;
    }
    let name = '';
    try {
      name = decodeURIComponent((url.pathname.split('/').filter(Boolean).pop() || url.hostname));
    } catch (e) {
      name = url.hostname;
    }
    if (name.length > 90) name = name.slice(0, 90) + '…';

    const record = {
      id: 'url-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      name: name || url.hostname,
      kind: 'url',
      src: url.href,
      addedAt: Date.now(),
    };
    state.videos.push(record);
    el.urlInput.value = '';
    el.urlForm.hidden = true;
    await persistVideos();
    renderVideoList();
    updateNavButtons();
    setupRotation();
    await loadVideoById(record.id, { silent: true });
    toast('已添加视频链接');
  }

  /* ------------------------------ 切换 ------------------------------ */

  function switchVideo(delta) {
    if (state.videos.length < 2) return;
    const index = state.videos.findIndex((v) => v.id === state.settings.currentVideoId);
    const nextIndex = (index + delta + state.videos.length) % state.videos.length;
    loadVideoById(state.videos[nextIndex].id, { silent: true });
  }

  function setupRotation() {
    if (state.rotateTimer) {
      clearInterval(state.rotateTimer);
      state.rotateTimer = null;
    }
    if (!state.settings.rotateEnabled || state.videos.length < 2) return;
    const ms = Math.max(1, state.settings.rotateMinutes) * 60 * 1000;
    state.rotateTimer = setInterval(() => switchVideo(1), ms);
  }

  function toggleMute() {
    state.settings.muted = !state.settings.muted;
    el.setMuted.checked = state.settings.muted;
    el.video.muted = state.settings.muted;
    if (!state.settings.muted) {
      try { el.video.play().catch(() => {}); } catch (e) { /* ignore */ }
    }
    updateMuteUi();
    persistSettings();
    toast(state.settings.muted ? '已静音' : '已开启声音', 1600);
  }

  /* ------------------------------ 时钟 ------------------------------ */

  function startClock() {
    updateClock();
    setInterval(updateClock, 1000);
  }

  function updateClock() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    el.clock.textContent = `${hours}:${minutes}`;
    el.date.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAYS[now.getDay()]}`;
  }

  /* ------------------------------ 搜索 ------------------------------ */

  function onSearchSubmit(event) {
    event.preventDefault();
    const query = el.searchInput.value.trim();
    if (!query) return;
    if (/^https?:\/\//i.test(query)) { location.href = query; return; }
    if (/^([\w-]+\.)+[a-z]{2,}([/:?#]|$)/i.test(query)) { location.href = 'https://' + query; return; }
    const engine = ENGINES[state.settings.searchEngine] || ENGINES.bing;
    location.href = engine.url + encodeURIComponent(query);
  }

  /* ------------------------------ 面板 ------------------------------ */

  function togglePanel(open) {
    const nextOpen = typeof open === 'boolean' ? open : !state.panelOpen;
    if (nextOpen === state.panelOpen) return;
    state.panelOpen = nextOpen;
    if (nextOpen) {
      if (state.menuOpen) toggleMenu(false);
      el.panelBackdrop.hidden = false;
      requestAnimationFrame(() => el.panelBackdrop.classList.add('visible'));
      el.settingsPanel.classList.add('open');
      el.settingsPanel.setAttribute('aria-hidden', 'false');
      renderVideoList();
    } else {
      el.settingsPanel.classList.remove('open');
      el.settingsPanel.setAttribute('aria-hidden', 'true');
      el.panelBackdrop.classList.remove('visible');
      el.urlForm.hidden = true;
      setTimeout(() => {
        if (!state.panelOpen) el.panelBackdrop.hidden = true;
      }, 300);
      try { el.searchInput.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }

  /* ------------------------------ 事件绑定 ------------------------------ */

  function bindUiEvents() {
    el.btnMenu.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleMenu();
    });
    document.addEventListener('click', (event) => {
      if (!state.menuOpen) return;
      if (el.menuWrap && el.menuWrap.contains(event.target)) return;
      toggleMenu(false);
    });
    el.btnSettings.addEventListener('click', () => {
      toggleMenu(false);
      togglePanel(true);
    });
    el.btnCloseSettings.addEventListener('click', () => togglePanel(false));
    el.panelBackdrop.addEventListener('click', () => togglePanel(false));

    el.btnMute.addEventListener('click', toggleMute);
    el.btnPrev.addEventListener('click', () => switchVideo(-1));
    el.btnNext.addEventListener('click', () => switchVideo(1));

    el.searchForm.addEventListener('submit', onSearchSubmit);
    el.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') el.searchInput.blur();
    });

    el.btnEmptyLocal.addEventListener('click', () => el.fileInput.click());
    el.btnEmptySettings.addEventListener('click', () => togglePanel(true));
    el.btnAddLocal.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', async () => {
      const files = Array.from(el.fileInput.files || []);
      el.fileInput.value = '';
      if (files.length) await addLocalFiles(files);
    });

    el.btnToggleUrl.addEventListener('click', () => {
      el.urlForm.hidden = !el.urlForm.hidden;
      if (!el.urlForm.hidden) el.urlInput.focus();
    });
    el.urlForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await addUrlVideo(el.urlInput.value);
    });

    el.setMuted.addEventListener('change', () => {
      state.settings.muted = el.setMuted.checked;
      el.video.muted = state.settings.muted;
      updateMuteUi();
      persistSettings();
    });

    el.setVolume.addEventListener('input', () => {
      const volume = clamp(Number(el.setVolume.value) / 100, 0, 1, 0.8);
      state.settings.volume = volume;
      el.video.volume = volume;
      if (volume > 0 && state.settings.muted) {
        state.settings.muted = false;
        el.setMuted.checked = false;
        el.video.muted = false;
        updateMuteUi();
      }
      persistSettings();
    });

    el.setLoop.addEventListener('change', () => {
      state.settings.loop = el.setLoop.checked;
      el.video.loop = state.settings.loop;
      persistSettings();
    });

    el.setRate.addEventListener('change', () => {
      state.settings.playbackRate = clamp(Number(el.setRate.value), 0.5, 2, 1);
      el.video.playbackRate = state.settings.playbackRate;
      persistSettings();
    });

    el.setFit.addEventListener('change', () => {
      state.settings.fit = FITS.includes(el.setFit.value) ? el.setFit.value : 'cover';
      applyVideoLook();
      persistSettings();
    });

    el.setBrightness.addEventListener('input', () => {
      state.settings.brightness = clamp(Number(el.setBrightness.value) / 100, 0.2, 1.2, 1);
      applyVideoLook();
      persistSettings();
    });

    el.setBlur.addEventListener('input', () => {
      state.settings.blur = clamp(Number(el.setBlur.value), 0, 20, 0);
      applyVideoLook();
      persistSettings();
    });

    el.setDim.addEventListener('input', () => {
      state.settings.dim = clamp(Number(el.setDim.value) / 100, 0, 0.8, 0.25);
      applyVideoLook();
      persistSettings();
    });

    el.setGlassBlur.addEventListener('input', () => {
      state.settings.glassBlur = clamp(Number(el.setGlassBlur.value), 0, 80, 40);
      applyGlassLook();
      persistSettings();
    });

    el.setGlassTint.addEventListener('input', () => {
      state.settings.glassTint = clamp(Number(el.setGlassTint.value), 0, 100, 18);
      applyGlassLook();
      persistSettings();
    });

    el.setGlassRefract.addEventListener('input', () => {
      state.settings.glassRefract = clamp(Number(el.setGlassRefract.value), 0, 100, 65);
      applyGlassLook();
      persistSettings();
    });

    el.setGlassEdge.addEventListener('input', () => {
      state.settings.glassEdge = clamp(Number(el.setGlassEdge.value), 0, 100, 55);
      applyGlassLook();
      persistSettings();
    });

    el.setGlassDisperse.addEventListener('input', () => {
      state.settings.glassDisperse = clamp(Number(el.setGlassDisperse.value), 0, 100, 35);
      applyGlassLook();
      persistSettings();
    });

    el.setRandom.addEventListener('change', () => {
      state.settings.randomOnOpen = el.setRandom.checked;
      persistSettings();
    });

    el.setRotate.addEventListener('change', () => {
      state.settings.rotateEnabled = el.setRotate.checked;
      setupRotation();
      persistSettings();
    });

    el.setRotateMinutes.addEventListener('change', () => {
      state.settings.rotateMinutes = clamp(Number(el.setRotateMinutes.value), 1, 60, 10);
      setupRotation();
      persistSettings();
    });

    el.setShowClock.addEventListener('change', () => {
      state.settings.showClock = el.setShowClock.checked;
      applySettings();
      persistSettings();
    });

    el.setShowDate.addEventListener('change', () => {
      state.settings.showDate = el.setShowDate.checked;
      applySettings();
      persistSettings();
    });

    el.setShowSearch.addEventListener('change', () => {
      state.settings.showSearch = el.setShowSearch.checked;
      applySettings();
      persistSettings();
    });

    el.setEngine.addEventListener('change', () => {
      state.settings.searchEngine = ENGINES[el.setEngine.value] ? el.setEngine.value : 'bing';
      applySettings();
      persistSettings();
    });

    el.btnReset.addEventListener('click', () => {
      if (!window.confirm('确定恢复默认设置吗？已添加的视频不会被删除。')) return;
      const keepVideoId = state.settings.currentVideoId;
      state.settings = { ...DEFAULT_SETTINGS, currentVideoId: keepVideoId };
      applySettings();
      setupRotation();
      persistSettingsNow();
      if (keepVideoId) {
        const record = state.videos.find((v) => v.id === keepVideoId);
        if (record) showVideo(record);
      }
      toast('已恢复默认设置');
    });

    document.addEventListener('keydown', onGlobalKeydown);

    bindDragAndDrop();
  }

  function onGlobalKeydown(event) {
    if (event.key === 'Escape') {
      if (state.menuOpen) { toggleMenu(false); return; }
      if (state.panelOpen) { togglePanel(false); return; }
      if (document.activeElement === el.searchInput) el.searchInput.blur();
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (state.panelOpen) return;
    if (event.isComposing) return;

    const target = event.target;
    const typing = target && (
      target.tagName === 'INPUT'
      || target.tagName === 'TEXTAREA'
      || target.tagName === 'SELECT'
      || target.isContentEditable
    );
    if (typing) return;
    if (event.key.length !== 1 || event.key === ' ') return;
    if (el.searchForm.hidden) return;

    // 直接打字即搜索（中文输入建议先点一下搜索框，走输入法组合输入）
    event.preventDefault();
    el.searchInput.focus();
    el.searchInput.value += event.key;
    const end = el.searchInput.value.length;
    try { el.searchInput.setSelectionRange(end, end); } catch (e) { /* ignore */ }
  }

  function bindDragAndDrop() {
    let depth = 0;
    const hasFiles = (event) => !!event.dataTransfer
      && Array.from(event.dataTransfer.types || []).includes('Files');

    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      document.body.classList.add('dragging');
    });

    window.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });

    window.addEventListener('dragleave', () => {
      if (!document.body.classList.contains('dragging')) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) document.body.classList.remove('dragging');
    });

    window.addEventListener('drop', async (event) => {
      if (!event.dataTransfer) return;
      const files = Array.from(event.dataTransfer.files || []);
      if (!files.length) return;
      event.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      await addLocalFiles(files);
    });
  }

  function bindVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        try { el.video.pause(); } catch (e) { /* ignore */ }
      } else if (state.loadedVideoId) {
        attemptPlay();
      }
    });
  }

  function bindStorageSync() {
    if (!state.hasChromeStorage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      try {
        if (changes.settings) {
          const incoming = normalizeSettings(changes.settings.newValue);
          if (JSON.stringify(incoming) === JSON.stringify(state.settings)) return;
          const previousId = state.settings.currentVideoId;
          state.settings = incoming;
          applySettings();
          setupRotation();
          renderVideoList();
          if (incoming.currentVideoId !== previousId) {
            const record = state.videos.find((v) => v.id === incoming.currentVideoId);
            if (record) showVideo(record);
          }
        }
        if (changes.videos && Array.isArray(changes.videos.newValue)) {
          const incoming = changes.videos.newValue.filter(isValidVideoRecord);
          if (JSON.stringify(incoming) === JSON.stringify(state.videos)) return;
          state.videos = incoming;
          renderVideoList();
          updateNavButtons();
          updateEmptyState();
          setupRotation();
          if (!state.videos.some((v) => v.id === state.settings.currentVideoId)) {
            const fallback = state.videos[0];
            if (fallback) loadVideoById(fallback.id, { silent: true });
            else clearVideo();
          }
        }
      } catch (e) { /* 忽略同步异常 */ }
    });
  }

  /* ------------------------------ 启动 ------------------------------ */

  init().catch((err) => {
    // 初始化失败时尽量给出提示，避免白屏
    const toastNode = document.getElementById('toast');
    if (toastNode) {
      toastNode.textContent = '新标签页初始化失败：' + (err && err.message ? err.message : err);
      toastNode.classList.add('show');
    }
    document.body.classList.add('ready');
    console.error(err);
  });
})();

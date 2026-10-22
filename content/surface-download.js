/**
 * 阿抖 - 每个视频封面/播放器表面独立下载按钮
 *
 * 在原有批量下载、详情页下载能力之外，为页面上的每一张视频/图文卡片、
 * 每一个视频播放 surface 追加一个轻量的"下载"按钮。
 *
 * 只复用扩展已有的消息协议：
 *   - saveData   : 按 aweme id 解析作品信息
 *   - downloadUrl: 触发实际下载
 *
 * 视频：默认从 videoInfos 中选择分辨率最高的播放地址。
 * 仅音频：复用原插件 musicInfo.url_list，保存为 .mp3（或 .mp4）。
 * 图文：原插件对 type=1 的图文不会走视频下载；这里下载图文的全部原图，
 *       并额外保存一份文案 txt，不再错误地保存为 mp4。
 */
(() => {
  "use strict";

  if (window.__xsjSurfaceDownloadLoaded) return;
  window.__xsjSurfaceDownloadLoaded = true;

  const BTN_CLASS = "xsj-surface-download";
  const AUDIO_CLASS = "xsj-surface-audio";
  const GROUP_CLASS = "xsj-surface-group";
  const LEGACY_BTN_CLASS = "xsj-download-container";
  const DEFAULT_TITLE = "单独下载该作品（默认最高画质）";
  const AUDIO_TITLE = "仅下载音频（背景音乐 / 原声）";
  const ANCHOR_SELECTOR =
    'a[href*="/video/"], a[href*="/note/"], a[href*="modal_id="], a[href*="aweme_id="], a[data-e2e-vid]';
  const SURFACE_SELECTOR =
    '#sliderVideo, #slideMode, [data-e2e="feed-active-video"], [data-e2e="player-container"]';
  const CARD_SELECTOR =
    'li, [data-e2e="search-result-card"], [data-e2e="feed-item"], [data-e2e="user-post-item"], .search-result-card';
  const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif|bmp|heic)$/i;

  const ICON_DOWNLOAD =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M15 7h-3V1H8v6H5l5 5l5-5zm4.338 6.532c-.21-.224-1.611-1.723-2.011-2.114A1.503 1.503 0 0 0 16.285 11h-1.757l3.064 2.994h-3.544a.274.274 0 0 0-.24.133L12.992 16H7.008l-.816-1.873a.276.276 0 0 0-.24-.133H2.408L5.471 11H3.715c-.397 0-.776.159-1.042.418c-.4.392-1.801 1.891-2.011 2.114c-.489.521-.758.936-.63 1.449l.561 3.074c.128.514.691.936 1.252.936h16.312c.561 0 1.124-.422 1.252-.936l.561-3.074c.126-.513-.142-.928-.632-1.449z"/></svg>';
  const ICON_AUDIO =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M10 3a2 2 0 0 1 2 2v6.586l.414-.207A1.5 1.5 0 0 1 14 12.707v-5.414a3.5 3.5 0 1 0-3.5-3.5A3.5 3.5 0 0 0 7 7.293v5.414a1.5 1.5 0 1 1-1.593-2.228L6 10.586V5a2 2 0 0 1 2-2zm4 6.618v-4.44a2.5 2.5 0 1 0-4 0v4.44L7.15 10.03A.5.5 0 0 0 7.112 11h5.776a.5.5 0 0 0 .139-.969L14 9.618z"/></svg>';
  const ICON_DONE =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M7.6 15.2L2.4 10l1.4-1.4 3.8 3.8 8.6-8.6L17.6 5z"/></svg>';
  const ICON_ERROR =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M10 1a9 9 0 1 0 0 18a9 9 0 0 0 0-18zm1 13H9v-2h2zm0-4H9V5h2z"/></svg>';
  const SPINNER = '<span class="xsj-surface-spinner" aria-hidden="true"></span>';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  let scanTimer = null;
  const anchorState = new WeakMap();
  const surfaceState = new WeakMap();

  // 同一 ID 的解析结果去重：正在解析时直接复用 Promise，解析完永久缓存。
  const infoCache = new Map();
  const infoInFlight = new Map();

  function getOrFetchInfo(id) {
    const cached = infoCache.get(id);
    if (cached && cached.info) return Promise.resolve(cached.info);
    if (infoInFlight.has(id)) return infoInFlight.get(id);
    const promise = requestVideoInfo(id).then(
      (info) => {
        infoCache.set(id, { info });
        infoInFlight.delete(id);
        return info;
      },
      (err) => {
        infoInFlight.delete(id);
        throw err;
      }
    );
    infoInFlight.set(id, promise);
    return promise;
  }

  // 解析并发控制：最多 4 个 saveData 同时飞行，单个慢解析不阻塞其他作品。
  const PARSE_CONCURRENCY = 4;
  let parseInFlight = 0;
  const parseQueue = [];

  function processParseQueue() {
    while (parseInFlight < PARSE_CONCURRENCY && parseQueue.length > 0) {
      const entry = parseQueue.shift();
      parseInFlight++;
      entry.task().then(
        (val) => { parseInFlight--; entry.resolve(val); processParseQueue(); },
        (err)  => { parseInFlight--; entry.reject(err);  processParseQueue(); }
      );
    }
  }

  function enqueueParse(task) {
    return new Promise((resolve, reject) => {
      parseQueue.push({ task, resolve, reject });
      processParseQueue();
    });
  }

  // 旧接口兼容（已无调用方，保留以避免外部引用报错）
  function enqueue(task) {
    return enqueueParse(task);
  }

  /**
   * 主入口：已缓存 ID 直接下载，否则进解析队列串行打 saveData，
   * 解析完成后立即并行下载（downloadVideo/downloadArticle 不阻塞队列）。
   */
  function resolveAndDownload(id, button) {
    const cached = infoCache.get(id);
    if (cached && cached.info) {
      runDownload(id, cached.info, button);
      return;
    }
    enqueueParse(() =>
      getOrFetchInfo(id).then(
        (info) => runDownload(id, info, button),
        (err) => showDownloadError(button, id, err)
      )
    );
  }

  function runDownload(id, info, button) {
    if (!button || !button.isConnected || button.dataset.xsjId !== id) return;
    if (Number(info.type) === 1) {
      downloadArticle(info, id, button).catch((err) =>
        showDownloadError(button, id, err)
      );
    } else {
      downloadVideo(info, id, button).catch((err) =>
        showDownloadError(button, id, err)
      );
    }
  }

  /** 音频专用：已缓存 ID 直接下载音频，否则进解析队列。 */
  function resolveAndDownloadAudio(id, audioBtn, mainBtn) {
    const cached = infoCache.get(id);
    if (cached && cached.info) {
      if (Number(cached.info.type) === 1) {
        setAudioState(audioBtn, "error", "图文");
        audioBtn.title = "图文作品无独立音频，请使用上方「下载」按钮保存图片";
        resetAudioLater(audioBtn, 6000);
      } else {
        downloadAudio(cached.info, id, audioBtn, mainBtn).catch((err) =>
          showAudioError(audioBtn, id, err)
        );
      }
      return;
    }
    enqueueParse(() =>
      getOrFetchInfo(id).then(
        (info) => {
          if (Number(info.type) === 1) {
            setAudioState(audioBtn, "error", "图文");
            audioBtn.title = "图文作品无独立音频，请使用上方「下载」按钮保存图片";
            resetAudioLater(audioBtn, 6000);
          } else {
            downloadAudio(info, id, audioBtn, mainBtn).catch((err) =>
              showAudioError(audioBtn, id, err)
            );
          }
        },
        (err) => showAudioError(audioBtn, id, err)
      )
    );
  }

  // 旧接口保留（外部可能引用，内部已无调用）
  function enqueue(task) {
    return enqueueParse(task);
  }

  // 记录已下载过的作品，避免扫描 / 卡片重渲染 / 切换页面后"已下载"又变回"下载"。
  // 永久保留，不设条数上限。
  // key 格式："{awemeId}"（旧版）或 "{awemeId}:video" / "{awemeId}:audio"（新版）
  const DONE_STORE_KEY = "xsjSurfaceDownloadDone";
  const doneRecords = new Map();

  function loadDoneRecords() {
    try {
      const raw = localStorage.getItem(DONE_STORE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return;
      list.forEach((item) => {
        if (!item || !item.id) return;
        const key = String(item.id);
        // 旧版记录只有 id 没有 kind，兼容加载
        if (!item.kind) {
          doneRecords.set(key, item);          // 旧 key
          doneRecords.set(key + ":video", item); // 同时挂到 video
          doneRecords.set(key + ":audio", item);  // 同时挂到 audio（分不清就都标）
        } else {
          doneRecords.set(key + ":" + item.kind, item);
        }
      });
    } catch (e) {
      console.warn("[xsj] loadDoneRecords 失败:", e);
    }
  }

  function saveDoneRecords() {
    try {
      // 去重：同一 id 的 :video 和 :audio 只保留较新的，外加旧 key 一条
      const byBaseId = new Map();
      for (const [key, rec] of doneRecords) {
        const baseId = key.replace(/(:video|:audio)$/, "");
        if (!byBaseId.has(baseId)) byBaseId.set(baseId, []);
        byBaseId.get(baseId).push({ key, rec });
      }
      const result = [];
      for (const [, entries] of byBaseId) {
        // 旧 key（不带 kind）
        const old = entries.find((e) => !/(:video|:audio)$/.test(e.key));
        if (old) result.push(old.rec);
        // video 和 audio 各保留最新
        const video = entries.filter((e) => e.key.endsWith(":video")).sort((a, b) => (b.rec.at || 0) - (a.rec.at || 0));
        const audio = entries.filter((e) => e.key.endsWith(":audio")).sort((a, b) => (b.rec.at || 0) - (a.rec.at || 0));
        if (video[0]) result.push(video[0].rec);
        if (audio[0]) result.push(audio[0].rec);
      }
      localStorage.setItem(DONE_STORE_KEY, JSON.stringify(result));
    } catch (e) {
      console.warn("[xsj] saveDoneRecords 失败:", e);
    }
  }

  /**
   * 记录一次下载完成。
   * @param {string} id    aweme id
   * @param {string} kind  "video" | "audio"（旧调用可省略，默认 "video"）
   * @param {string} text  按钮显示文字
   * @param {string} title 按钮 tooltip
   */
  function rememberDone(id, kind, text, title) {
    if (!id) return;
    const resolvedKind = kind || "video";
    const key = String(id) + ":" + resolvedKind;
    doneRecords.set(key, {
      id: key,
      kind: resolvedKind,
      text: text || "已下载",
      title: title || "已下载",
      at: Date.now(),
    });
    saveDoneRecords();
  }

  /**
   * 按 kind 查询是否已下载过。
   * @param {string} id   aweme id
   * @param {string} kind "video" | "audio"
   */
  function isDone(id, kind) {
    if (!id || !kind) return false;
    const key = String(id) + ":" + kind;
    return doneRecords.has(key);
  }

  /**
   * 将按钮设为已下载（如果该 kind 有记录）。
   * @returns {boolean} 是否应用了
   */
  function applyDoneState(button, id, kind) {
    if (!button || !id || !kind) return false;
    const state = button.dataset.state;
    if (state === "loading" || state === "error") return false;
    const key = String(id) + ":" + kind;
    const record = doneRecords.get(key);
    if (!record) return false;
    setButtonState(button, "done", record.text || "已下载");
    button.title = record.title || "已下载";
    return true;
  }

  /** 音频按钮专用：主按钮也标记已下载（因为音频是视频的附属） */
  function applyAudioDoneState(audioBtn, id) {
    if (!audioBtn || !id) return false;
    const state = audioBtn.dataset.state;
    if (state === "loading" || state === "error") return false;
    const record = doneRecords.get(String(id) + ":audio");
    if (!record) return false;
    setAudioState(audioBtn, "done", record.text || "已下载");
    audioBtn.title = record.title || "已下载";
    return true;
  }

  function toHttps(url) {
    return /^http:\/\//.test(url) ? "https://" + url.substring(7) : url;
  }

  function sanitizeFilename(name) {
    return String(name || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[\/|\\:*~?"<>\n\r\.]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseVideoUrl(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.href);
      const match = url.pathname.match(/\/(video|note)\/(\d+)/);
      if (match) return { type: match[1], id: match[2] };
      const modalId = url.searchParams.get("modal_id") || url.searchParams.get("aweme_id");
      if (modalId && /^\d+$/.test(modalId)) return { type: "video", id: modalId };
    } catch (e) {
      // ignore invalid href
    }
    return null;
  }

  function readSurfaceId(element, allowPageFallback) {
    if (!element) return null;
    if (element.matches && element.matches("a[href]")) {
      const parsed = parseVideoUrl(element.getAttribute("href"));
      if (parsed) return parsed.id;
    }
    if (element.dataset && element.dataset.e2eVid) return element.dataset.e2eVid;
    const inner = element.querySelector("[data-e2e='feed-active-video']");
    if (inner && inner.dataset && inner.dataset.e2eVid) return inner.dataset.e2eVid;
    if (!allowPageFallback) return null;
    const canonical = document.querySelector("link[rel='canonical']");
    if (canonical) {
      const parsed = parseVideoUrl(canonical.getAttribute("href"));
      if (parsed) return parsed.id;
    }
    const fromLocation = parseVideoUrl(location.pathname);
    return fromLocation ? fromLocation.id : null;
  }

  const resolveButtonId = (button) => {
    // 支持音频按钮（其 parentElement 是 group）和主按钮
    const group = button.closest ? button.closest("." + GROUP_CLASS) : null;
    const anchor = group
      ? group.closest(ANCHOR_SELECTOR)
      : button.closest
        ? button.closest(ANCHOR_SELECTOR)
        : null;
    if (anchor) {
      const parsed = parseVideoUrl(anchor.getAttribute("href"));
      if (parsed) return parsed.id;
      if (anchor.dataset && /^\d+$/.test(anchor.dataset.e2eVid || "")) {
        return anchor.dataset.e2eVid;
      }
    }
    // group 上的 xsjId
    const groupId = group ? group.dataset.xsjId : null;
    if (groupId) return groupId;
    const surface = button.parentElement;
    const id = readSurfaceId(surface, isMainSurface(surface));
    return id || button.dataset.xsjId || null;
  };

  function getOwnGroup(container) {
    for (let i = 0; i < container.children.length; i++) {
      const child = container.children[i];
      if (child.classList && child.classList.contains(GROUP_CLASS)) return child;
    }
    return null;
  }

  function removeOwnButton(container) {
    const group = getOwnGroup(container);
    if (group) { group.remove(); return; }
    for (let i = 0; i < container.children.length; i++) {
      const child = container.children[i];
      if (child.classList && child.classList.contains(BTN_CLASS)) { child.remove(); return; }
    }
  }

  function setButtonState(button, state, text) {
    if (!button) return;
    button.dataset.state = state;
    let icon = ICON_DOWNLOAD;
    if (state === "loading") icon = SPINNER;
    else if (state === "done") icon = ICON_DONE;
    else if (state === "error") icon = ICON_ERROR;
    button.innerHTML =
      icon + '<span class="xsj-surface-download-text">' + text + "</span>";
  }

  function resetToIdle(button) {
    setButtonState(button, "idle", "下载");
    button.title = DEFAULT_TITLE;
  }

  function setAudioState(audioBtn, state, text) {
    if (!audioBtn) return;
    audioBtn.dataset.state = state;
    let icon = ICON_AUDIO;
    if (state === "loading") icon = SPINNER;
    else if (state === "done") icon = ICON_DONE;
    else if (state === "error") icon = ICON_ERROR;
    audioBtn.innerHTML =
      icon + '<span class="xsj-surface-audio-text">' + text + "</span>";
  }

  function resetAudioToIdle(audioBtn) {
    setAudioState(audioBtn, "idle", "仅音频");
    audioBtn.title = AUDIO_TITLE;
  }

  /**
   * 创建按钮组容器。视频类型包含主按钮 + 仅音频子按钮；
   * 图文类型（note）只有主按钮。
   */
  function createButton(kind) {
    const group = document.createElement("div");
    group.className = GROUP_CLASS;
    group.setAttribute("role", "group");

    const mainBtn = document.createElement("div");
    mainBtn.className = BTN_CLASS;
    mainBtn.setAttribute("role", "button");
    mainBtn.setAttribute("aria-label", "下载该作品（默认最高画质）");
    mainBtn.title = DEFAULT_TITLE;
    mainBtn.tabIndex = 0;
    setButtonState(mainBtn, "idle", "下载");
    mainBtn.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      if (mainBtn.dataset.state !== "loading") {
        void handleDownload(mainBtn);
      }
    });
    group.appendChild(mainBtn);

    if (kind !== "note") {
      const audioBtn = document.createElement("div");
      audioBtn.className = AUDIO_CLASS;
      audioBtn.setAttribute("role", "button");
      audioBtn.setAttribute("aria-label", "仅下载音频");
      audioBtn.title = AUDIO_TITLE;
      audioBtn.tabIndex = 0;
      setAudioState(audioBtn, "idle", "仅音频");
      audioBtn.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        if (audioBtn.dataset.state !== "loading") {
          void handleAudioDownload(audioBtn);
        }
      });
      group.appendChild(audioBtn);
    }

    return group;
  }

  /** 兼容旧调用：获取主按钮（group 内或裸按钮） */
  function getMainButton(container) {
    const group = getOwnGroup(container);
    if (group) return group.querySelector("." + BTN_CLASS);
    for (let i = 0; i < container.children.length; i++) {
      const child = container.children[i];
      if (child.classList && child.classList.contains(BTN_CLASS)) return child;
    }
    return null;
  }

  /** 获取仅音频按钮 */
  function getAudioBtn(container) {
    const group = getOwnGroup(container);
    if (group) return group.querySelector("." + AUDIO_CLASS);
    return null;
  }

  /** 获取旧接口期望的"主按钮"：group 优先，否则裸 main */
  function getOwnButton(container) {
    const group = getOwnGroup(container);
    if (group) return group;
    return getMainButton(container);
  }

  function ensurePositioned(element) {
    const style = getComputedStyle(element);
    if (style.position === "static") element.style.position = "relative";
  }

  function findCard(anchor) {
    return anchor.closest(CARD_SELECTOR) || anchor;
  }

  function hasLegacyButton(scope) {
    return !!(scope && scope.querySelector && scope.querySelector("." + LEGACY_BTN_CLASS));
  }

  function isMainSurface(element) {
    if (element.matches("#sliderVideo, #slideMode")) return true;
    if (element.matches('[data-e2e="player-container"]')) {
      return !element.closest(CARD_SELECTOR);
    }
    return false;
  }

  function injectForAnchor(anchor) {
    if (!anchor.isConnected) return;

    const href = anchor.getAttribute("href");
    const parsed = parseVideoUrl(href);
    const attrId = anchor.dataset && anchor.dataset.e2eVid;
    const id = parsed ? parsed.id : attrId && /^\d+$/.test(attrId) ? attrId : null;
    if (!id) return;

    const card = findCard(anchor);
    if (hasLegacyButton(card)) {
      removeOwnButton(anchor);
      anchorState.set(anchor, { href, skipped: true, at: Date.now() });
      return;
    }

    let group = getOwnGroup(anchor);
    let mainBtn = group ? group.querySelector("." + BTN_CLASS) : getMainButton(anchor);
    const cached = anchorState.get(anchor);
    if (mainBtn && mainBtn.dataset.xsjId === id && cached && cached.href === href) {
      return;
    }

    const rect = anchor.getBoundingClientRect();
    if (rect.width < 72 || rect.height < 72) return;
    if (
      !anchor.querySelector("img, video, picture, canvas") &&
      rect.width < 120
    ) {
      return;
    }

    if (!mainBtn) {
      ensurePositioned(anchor);
      const kind = parsed ? parsed.type : "video";
      group = createButton(kind);
      anchor.appendChild(group);
      mainBtn = group.querySelector("." + BTN_CLASS);
    }

    const previousId = mainBtn.dataset.xsjId;
    mainBtn.dataset.xsjId = id;
    mainBtn.dataset.xsjType = parsed ? parsed.type : "video";
    if (group) group.dataset.xsjId = id;
    // 主按钮只读 video 记录；已下载过就保持，正在下载/重试中不被扫描重置。
    const kindForMain = parsed && parsed.type === "note" ? "video" : "video";
    if (!applyDoneState(mainBtn, id, kindForMain)) {
      const busy =
        previousId === id &&
        (mainBtn.dataset.state === "loading" || mainBtn.dataset.state === "error");
      if (!busy) resetToIdle(mainBtn);
    }
    // 音频按钮只读 audio 记录
    const audioBtnRef = group ? group.querySelector("." + AUDIO_CLASS) : null;
    if (audioBtnRef) {
      if (!applyAudioDoneState(audioBtnRef, id)) {
        if (audioBtnRef.dataset.state !== "loading" && audioBtnRef.dataset.state !== "error") {
          resetAudioToIdle(audioBtnRef);
        }
      }
    }
    anchorState.set(anchor, { href, button: mainBtn, card, recheckAt: Date.now() + 1500 });
  }

  function injectForSurface(element) {
    if (!element.isConnected) return;

    // 只给最外层 surface 注入，避免 slider/feed/player 嵌套时重复。
    const outer = element.closest(SURFACE_SELECTOR);
    if (outer && outer !== element) return;

    const mainSurface = isMainSurface(element);
    const card = findCard(element);

    if (
      !mainSurface &&
      card &&
      card !== element &&
      hasLegacyButton(card)
    ) {
      removeOwnButton(element);
      return;
    }

    if (!mainSurface && hasLegacyButton(element)) {
      removeOwnButton(element);
      return;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 120) return;

    const id = readSurfaceId(element, mainSurface);
    if (!id) return;

    let group = getOwnGroup(element);
    let mainBtn = group ? group.querySelector("." + BTN_CLASS) : getMainButton(element);
    if (mainBtn && mainBtn.dataset.xsjId === id) {
      surfaceState.set(element, { id, button: mainBtn });
      return;
    }

    if (!mainBtn) {
      ensurePositioned(element);
      group = createButton("video"); // 播放器/大屏 surface 固定为视频
      element.appendChild(group);
      mainBtn = group.querySelector("." + BTN_CLASS);
    }

    const previousId = mainBtn.dataset.xsjId;
    mainBtn.dataset.xsjId = id;
    mainBtn.dataset.xsjType = "video";
    if (group) group.dataset.xsjId = id;
    if (!applyDoneState(mainBtn, id, "video")) {
      const busy =
        previousId === id &&
        (mainBtn.dataset.state === "loading" || mainBtn.dataset.state === "error");
      if (!busy) resetToIdle(mainBtn);
    }
    const audioBtnRef2 = group ? group.querySelector("." + AUDIO_CLASS) : null;
    if (audioBtnRef2) {
      if (!applyAudioDoneState(audioBtnRef2, id)) {
        if (audioBtnRef2.dataset.state !== "loading" && audioBtnRef2.dataset.state !== "error") {
          resetAudioToIdle(audioBtnRef2);
        }
      }
    }
    surfaceState.set(element, { id, button: mainBtn });
  }

  function scan() {
    if (document.hidden) return;
    document.querySelectorAll(ANCHOR_SELECTOR).forEach(injectForAnchor);
    document.querySelectorAll(SURFACE_SELECTOR).forEach(injectForSurface);
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 350);
  }

  async function requestVideoInfo(id) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const info = await withTimeout(
          chrome.runtime.sendMessage({
            type: "saveData",
            data: { downloadId: id, title: document.title },
            withComment: false,
            queryInfo: true,
          }),
          30000,
          "作品信息解析超时"
        );
        if (
          info &&
          (Number(info.type) === 1 ||
            info.videoInfo ||
            (Array.isArray(info.videoInfos) && info.videoInfos.length > 0) ||
            (Array.isArray(info.fileInfos) && info.fileInfos.length > 0))
        ) {
          return info;
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(500 * (attempt + 1));
    }
    throw lastError || new Error("作品信息解析失败");
  }

  function videoRank(video) {
    const width = Number(video && video.width) || 0;
    const height = Number(video && video.height) || 0;
    const name = String((video && (video.xsjName || video.gear_name)) || "");
    let named = 0;
    let match = name.match(/(\d{3,4})\s*[pP]/);
    if (match) named = Number(match[1]) || 0;
    match = name.match(/(\d{3,4})\s*[xX*]\s*(\d{3,4})/);
    if (match) named = Math.max(named, Math.min(Number(match[1]) || 0, Number(match[2]) || 0));
    const tokens = name.match(/\d{3,4}/g);
    if (tokens) {
      for (const token of tokens) {
        const value = Number(token);
        if (value >= 360 && value <= 4320) named = Math.max(named, value);
      }
    }
    const shortSide = Math.max(width && height ? Math.min(width, height) : 0, named);
    const longSide = width && height ? Math.max(width, height) : 0;
    return {
      shortSide,
      longSide,
      size: Number(video && video.data_size) || 0,
      h264: video && video.xsjKey === "play_addr_h264" ? 1 : 0,
    };
  }

  function selectVideo(info) {
    const list = (info.videoInfos || []).filter(
      (video) => video && Array.isArray(video.url_list) && video.url_list.length > 0
    );
    if (list.length === 0) return info.videoInfo;

    return list.slice().sort((a, b) => {
      const ra = videoRank(a);
      const rb = videoRank(b);
      if (rb.shortSide !== ra.shortSide) return rb.shortSide - ra.shortSide;
      if (rb.longSide !== ra.longSide) return rb.longSide - ra.longSide;
      if (rb.size !== ra.size) return rb.size - ra.size;
      return rb.h264 - ra.h264;
    })[0];
  }

  function videoQualityLabel(video) {
    if (!video) return "";
    const name = String(video.xsjName || video.gear_name || "").trim();
    const width = Number(video.width) || 0;
    const height = Number(video.height) || 0;
    const resolution = width && height ? Math.min(width, height) + "p" : "";
    if (name && !/^(auto|h264|265)$/i.test(name)) return name;
    return resolution || name;
  }

  async function pickPlayableUrl(urls) {
    if (!Array.isArray(urls) || urls.length === 0) return "";
    const sorted = [...urls].sort((a, b) => {
      const aDouyin = String(a).includes("douyin.com") ? 1 : 0;
      const bDouyin = String(b).includes("douyin.com") ? 1 : 0;
      return bDouyin - aDouyin;
    });

    for (const raw of sorted) {
      const url = toHttps(raw);
      try {
        const controller = new AbortController();
        const response = await fetch(url, { signal: controller.signal });
        const size = Number(response.headers.get("Content-Length") || 0);
        controller.abort();
        if (response.ok && size > 0) return url;
      } catch (e) {
        // try next url
      }
    }
    return toHttps(sorted[0]);
  }

  function buildVideoFilename(info, video, id) {
    const username = (info.user && info.user.username) || "抖音";
    const title = String(info.title || document.title || id).substring(0, 120);
    const fileHash = (video && video.file_hash) || id;
    return sanitizeFilename("(" + username + ")" + title + "_" + fileHash) + ".mp4";
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (e) {
      return value;
    }
  }

  function isImageUrl(url) {
    try {
      return IMAGE_EXT_RE.test(new URL(url, location.href).pathname);
    } catch (e) {
      return false;
    }
  }

  function imageExtension(url, fileName) {
    for (const candidate of [url, fileName]) {
      if (!candidate) continue;
      try {
        const pathname = String(candidate).startsWith("http")
          ? new URL(candidate, location.href).pathname
          : String(candidate).split("?")[0];
        const match = pathname.match(IMAGE_EXT_RE);
        if (match) {
          const ext = match[1].toLowerCase();
          return "." + (ext === "jpeg" ? "jpg" : ext);
        }
      } catch (e) {
        // try next candidate
      }
    }
    return ".jpg";
  }

  function findFileInfo(info, fileName) {
    const files = Array.isArray(info.fileInfos) ? info.fileInfos : [];
    const decoded = safeDecode(fileName);
    for (const file of files) {
      if (!file) continue;
      const name = String(file.fileName || "");
      const decodedName = safeDecode(name);
      if (
        name === fileName ||
        decodedName === decoded ||
        name.endsWith("/" + fileName) ||
        decodedName.endsWith("/" + decoded)
      ) {
        return { url: String(file.fileUrl || ""), fileName: name || fileName };
      }
    }
    return null;
  }

  function addArticleImage(images, seen, rawUrl, fileName) {
    if (!rawUrl) return;
    let url;
    try {
      url = new URL(String(rawUrl), location.href).href;
    } catch (e) {
      return;
    }
    url = toHttps(url);
    if (!/^https?:/i.test(url) || seen.has(url)) return;
    seen.add(url);
    images.push({ url, fileName: String(fileName || "") });
  }

  function parseMarkdownImages(markdown, info, images, seen, requireTitle) {
    const regex = /!\[[^\]]*\]\(\s*([^\s)]+)(?:\s+"([^"]*)")?\s*\)/g;
    let match;
    while ((match = regex.exec(markdown))) {
      const title = match[2] || "";
      if (requireTitle && !/^\d+$/.test(title)) continue;
      const src = match[1];
      const file = findFileInfo(info, src);
      if (file && file.url) {
        addArticleImage(images, seen, file.url, file.fileName);
      } else if (/^https?:/i.test(src)) {
        addArticleImage(images, seen, src, "");
      }
    }
  }

  function extractArticleImages(info) {
    const images = [];
    const seen = new Set();
    const content = String(info.content || "");
    const markdown = String(info.markdown || "");

    // 原插件的 saveData 返回 content 是 markdown；下载图片时 src 已被替换为
    // images/2.jpg 这类本地文件名，真实地址在 fileInfos 里。
    if (content) parseMarkdownImages(content, info, images, seen, true);
    if (images.length === 0 && markdown) {
      parseMarkdownImages(markdown, info, images, seen, true);
    }

    // 兼容 content 仍是 HTML 的情况。
    if (images.length === 0 && content && /<img[\s>]/i.test(content)) {
      try {
        const doc = new DOMParser().parseFromString(content, "text/html");
        doc.querySelectorAll("img").forEach((img) => {
          if (img.hasAttribute("data-music") || img.hasAttribute("data-video")) return;
          const title = img.getAttribute("title");
          if (!title || !/^\d+$/.test(title)) return;
          addArticleImage(images, seen, img.getAttribute("src"), "");
        });
      } catch (e) {
        // fall through to fileInfos
      }
    }

    // 最后的兜底：只取 images/ 下的图片，跳过 attachments/ 的音乐/视频。
    if (images.length === 0 && Array.isArray(info.fileInfos)) {
      for (const file of info.fileInfos) {
        if (!file) continue;
        const fileName = String(file.fileName || "");
        const fileUrl = String(file.fileUrl || "");
        if (/^attachments\//i.test(fileName)) continue;
        if (/^images\//i.test(fileName) || isImageUrl(fileUrl) || IMAGE_EXT_RE.test(fileName)) {
          addArticleImage(images, seen, fileUrl, fileName);
        }
      }
    }

    // 兼容 content 里直接使用远程图片地址的旧版本。
    if (images.length === 0 && content) {
      const regex = /(?:!|\%)\[[^\]]*\]\(\s*(https?:\/\/[^\s)]+)/g;
      let match;
      while ((match = regex.exec(content))) {
        addArticleImage(images, seen, match[1], "");
      }
    }

    return images;
  }

  function articleCaption(info) {
    let text = String(info.content || info.markdown || "");
    text = text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/%\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "");

    if (/<[a-z][\s\S]*>/i.test(text)) {
      try {
        const doc = new DOMParser().parseFromString(text, "text/html");
        text = doc.body ? doc.body.textContent : text;
      } catch (e) {
        // keep markdown text
      }
    }

    return String(text)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function buildArticleFilename(info, id) {
    const username = (info.user && info.user.username) || "抖音";
    const pageTitle = String(document.title || "").trim();
    let title = String(info.title || "").trim();
    if (!title || title === pageTitle) {
      const caption = articleCaption(info).replace(/\s+/g, " ").trim();
      if (caption) title = caption.substring(0, 80);
    }
    if (!title || title === pageTitle) title = id;
    const base = sanitizeFilename("(" + username + ")" + title).substring(0, 120);
    return base || String(id);
  }

  function buildArticleText(info, id) {
    const title = String(info.title || "").trim();
    const username = (info.user && info.user.username) || "";
    const caption = articleCaption(info);
    const sourceType = Number(info.type) === 1 ? "note" : "video";
    const source = "https://www.douyin.com/" + sourceType + "/" + id;
    const lines = [];
    if (title) lines.push("标题：" + title);
    if (username) lines.push("作者：" + username);
    lines.push("链接：" + source);
    if (caption) lines.push("", caption);
    return lines.join("\n").trim();
  }

  function sendDownload(downloadId, title, filename, url) {
    return chrome.runtime.sendMessage({
      type: "downloadUrl",
      data: { downloadId, title, filename, url },
    });
  }

  /**
   * 标记一个按钮为已下载，同时按 kind 记录到 localStorage。
   * @param {HTMLElement} button   要标记的按钮
   * @param {string} id           aweme id
   * @param {string} kind         "video" | "audio"
   * @param {string} text         按钮文字
   * @param {string} title        tooltip
   */
  function markDone(button, id, kind, text, title) {
    rememberDone(id, kind, text, title);
    if (!button || !button.isConnected) return;
    if (button.classList && button.classList.contains(AUDIO_CLASS)) {
      setAudioState(button, "done", text);
    } else {
      setButtonState(button, "done", text);
    }
    button.title = title;
  }

  async function downloadVideo(info, id, button) {
    const video = selectVideo(info);
    if (!video || !video.url_list || video.url_list.length === 0) {
      throw new Error("没有找到可下载的视频地址");
    }

    const label = videoQualityLabel(video);
    setButtonState(button, "loading", "获取地址");
    button.title = label
      ? "正在获取最高画质（" + label + "）的视频地址…"
      : "正在获取最高画质的视频地址…";

    const url = await pickPlayableUrl(video.url_list);
    if (!url) throw new Error("视频地址不可用");
    if (!button.isConnected || button.dataset.xsjId !== id) return;

    setButtonState(button, "loading", "下载中");
    const filename = buildVideoFilename(info, video, id);
    await sendDownload(id, info.title || document.title, filename, url);

    if (!button.isConnected || button.dataset.xsjId !== id) return;
    markDone(
      button,
      id,
      "video",
      "已下载",
      "已开始下载" + (label ? "（" + label + "）" : "") + "：" + filename
    );
  }

  async function downloadArticle(info, id, button) {
    const images = extractArticleImages(info);
    if (images.length === 0) {
      throw new Error("没有找到图文图片");
    }

    const base = buildArticleFilename(info, id);
    setButtonState(button, "loading", "保存图片");
    button.title = "正在下载 " + images.length + " 张图文原图…";

    const tasks = images.map((image, index) => {
      const suffix = String(index + 1).padStart(2, "0");
      const filename =
        base + "_" + suffix + imageExtension(image.url, image.fileName);
      return withTimeout(
        sendDownload(
          id + "_img_" + (index + 1),
          info.title || document.title,
          filename,
          image.url
        ),
        60000,
        "图片下载超时"
      );
    });

    const text = buildArticleText(info, id);
    if (text) {
      // 文案交给后台用 chrome.downloads 直接保存，避免页面 CSP 拦截 data: 请求。
      void chrome.runtime
        .sendMessage({
          type: "downloadText",
          data: {
            downloadId: id + "_txt",
            title: info.title || document.title,
            filename: base + ".txt",
            text,
          },
        })
        .catch(() => null);
    }

    const results = await Promise.allSettled(tasks);
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed === tasks.length) throw new Error("图文图片下载失败");

    if (!button.isConnected || button.dataset.xsjId !== id) return;
    markDone(
      button,
      id,
      "video",
      "已下载",
      "已开始下载 " + images.length + " 张图片" + (text ? "和文案" : "")
    );
  }

  function showDownloadError(button, id, error) {
    if (!button || !button.isConnected || button.dataset.xsjId !== id) return;
    const message =
      error && error.message ? error.message : "下载失败，请稍后重试";
    setButtonState(button, "error", "重试");
    button.title = message;
    resetLater(button, 6000);
  }

  async function handleDownload(button) {
    if (button.dataset.state === "loading") return;

    const id = resolveButtonId(button);
    if (!id) {
      setButtonState(button, "error", "无ID");
      button.title = "未找到该作品的 ID";
      resetLater(button, 4000);
      return;
    }

    setButtonState(button, "loading", "解析中");
    button.title = "正在解析作品信息…";

    resolveAndDownload(id, button);
  }

  async function handleAudioDownload(audioBtn) {
    if (audioBtn.dataset.state === "loading") return;

    const group = audioBtn.closest("." + GROUP_CLASS);
    const mainBtn = group ? group.querySelector("." + BTN_CLASS) : audioBtn.parentElement;
    const id = mainBtn ? mainBtn.dataset.xsjId : null;
    if (!id) {
      setAudioState(audioBtn, "error", "无ID");
      audioBtn.title = "未找到该作品的 ID";
      resetAudioLater(audioBtn, 4000);
      return;
    }

    setAudioState(audioBtn, "loading", "解析中");
    audioBtn.title = "正在解析作品信息…";

    resolveAndDownloadAudio(id, audioBtn, mainBtn);
  }

  async function downloadAudio(info, id, audioBtn, mainBtn) {
    const music = info.musicInfo;
    const urls = music && Array.isArray(music.url_list) && music.url_list.length > 0
      ? music.url_list
      : info.videoInfo && Array.isArray(info.videoInfo.url_list)
        ? info.videoInfo.url_list
        : [];

    if (urls.length === 0) {
      throw new Error("没有找到可用的音频地址");
    }

    setAudioState(audioBtn, "loading", "获取地址");
    audioBtn.title = "正在获取音频地址…";

    const url = await pickPlayableUrl(urls);
    if (!url) throw new Error("音频地址不可用");
    if (!audioBtn.isConnected || !mainBtn || mainBtn.dataset.xsjId !== id) return;

    setAudioState(audioBtn, "loading", "下载中");
    const username = (info.user && info.user.username) || "抖音";
    const title = String(info.title || document.title || id).substring(0, 120);
    const urlKey = (music && music.url_key) || (music && music.file_hash) || id;
    const filename =
      sanitizeFilename("(" + username + ")" + title + "_" + urlKey) + ".mp3";

    await sendDownload(id + "_audio", info.title || document.title, filename, url);

    if (!audioBtn.isConnected || !mainBtn || mainBtn.dataset.xsjId !== id) return;
    // 音频下载完成：音频按钮标记 done，主按钮同步标记（视觉反馈），记录 kind=audio
    markDone(audioBtn, id, "audio", "已下载", "已开始下载音频：" + filename);
    if (mainBtn.isConnected && mainBtn.dataset.xsjId === id && mainBtn.dataset.state !== "loading") {
      setButtonState(mainBtn, "done", "已下载");
      mainBtn.title = "已开始下载音频：" + filename;
    }
  }

  function showAudioError(audioBtn, id, error) {
    if (!audioBtn || !audioBtn.isConnected) return;
    const message =
      error && error.message ? error.message : "音频下载失败，请稍后重试";
    setAudioState(audioBtn, "error", "重试");
    audioBtn.title = message;
    resetAudioLater(audioBtn, 6000);
  }

  function resetAudioLater(audioBtn, delay) {
    setTimeout(() => {
      if (audioBtn.isConnected && audioBtn.dataset.state === "error") {
        resetAudioToIdle(audioBtn);
      }
    }, delay);
  }

  function resetLater(button, delay) {
    setTimeout(() => {
      if (button.isConnected && button.dataset.state === "error") {
        resetToIdle(button);
      }
    }, delay);
  }

  // 最外层捕获点击，避免触发视频卡片的跳转
  const SURFACE_SEL = "." + BTN_CLASS + ", ." + AUDIO_CLASS;
  ["pointerdown", "mousedown", "mouseup", "pointerup", "auxclick"].forEach(
    (type) => {
      document.addEventListener(
        type,
        (event) => {
          const target = event.target;
          if (!target || !target.closest) return;
          const btn = target.closest(SURFACE_SEL);
          if (!btn) return;
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
          }
        },
        true
      );
    }
  );

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      const btn = target.closest(SURFACE_SEL);
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      if (btn.dataset.state === "loading") return;
      if (btn.classList.contains(AUDIO_CLASS)) {
        void handleAudioDownload(btn);
      } else {
        void handleDownload(btn);
      }
    },
    true
  );

  function startObserver() {
    const root = document.documentElement;
    if (!root) {
      document.addEventListener("DOMContentLoaded", startObserver, { once: true });
      return;
    }
    const observer = new MutationObserver(scheduleScan);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "data-e2e-vid"],
    });
  }

  loadDoneRecords();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan, { once: true });
  } else {
    scan();
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleScan();
  });
  window.addEventListener("focus", scheduleScan);
  startObserver();
  setInterval(scan, 2500);
})();

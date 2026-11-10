/**
 * 阿抖 - 扩展指纹降权补丁（v1.5.8.4 新增，可选启用）
 *
 * 加载顺序：js/background-entry.js 先 await import("./background.js")
 * （原始 service worker，一行不改），再 await import 本文件。
 *
 * 作用：覆盖 chrome.downloads.download，把跨域 CDN URL 的下载转成
 *   fetch → Blob → blob: URL
 * 再调一次 chrome.downloads.download（但 URL 是本地 blob:，跨域
 * 下载指纹显著降低）。
 *
 * 启用条件：仅当 chrome.storage.local 中 chromeDownload===true 时
 * 走"blob 转换"路径；否则保持原 chrome.downloads 跨域下载行为。
 * （与 js/background.js 内 "downloadUrl" 分支里已有的 chromeDownload
 * 开关语义保持一致，用户可在 setting 页切换。）
 *
 * 如果不需要本补丁：把 manifest.json 的 background.service_worker
 * 改回 "js/background.js" 即可，本文件不参与运行。
 */
(() => {
  "use strict";
  if (chrome.__xsjDownloadOverlay) return;
  chrome.__xsjDownloadOverlay = true;

  const origDownload = chrome.downloads.download.bind(chrome.downloads);

  chrome.downloads.download = async (options) => {
    let useChromeDownloads = false;
    try {
      const stored = await chrome.storage.local.get("chromeDownload");
      useChromeDownloads = Boolean(stored && stored.chromeDownload);
    } catch (e) {
      useChromeDownloads = false;
    }

    // 保留原行为：用户显式选择 chrome.downloads 路径（或补丁关闭）
    if (useChromeDownloads) {
      return origDownload(options);
    }

    // 跨域 URL 才需要走 blob 转换；blob:/data: URL 直接用原 API
    const url = options.url;
    if (!/^https?:/i.test(url || "")) {
      return origDownload(options);
    }

    try {
      const resp = await fetch(url, { credentials: "omit" });
      if (!resp.ok) throw new Error("download failed: " + resp.status);
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        const id = await origDownload({ ...options, url: objectUrl });
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
        return id;
      } catch (err) {
        URL.revokeObjectURL(objectUrl);
        throw err;
      }
    } catch (err) {
      // fetch 失败（CORS/网络错误）时回落到原 chrome.downloads 跨域下载
      // 以保证下载能力不中断；仅放弃"指纹降权"这一层优化。
      return origDownload(options);
    }
  };
})();

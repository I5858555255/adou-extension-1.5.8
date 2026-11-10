/**
 * 扩展 service worker 入口
 *
 * 顺序：
 *   1. 加载原 js/background.js（完整下载/解析协议，不改一行）；
 *   2. 加载 js/background-overlay.js（可选指纹降权补丁：把跨域
 *      chrome.downloads 下载转成 fetch→Blob→blob: URL，把"跨域
 *      downloads 高频调用"指纹降为"本地 blob 一次下载"）。
 *
 * manifest.json 的 background.service_worker 指向本文件，不再直接
 * 指向 js/background.js。
 *
 * 加载模式：manifest.json 的 background.type 为 "module"，
 * 顶层 await import 静态解析；js/background.js 不是 ESM 但
 * 没有 export/import 关键字，作为普通脚本模块加载是兼容的。
 *
 * 如果不需要本入口/补丁：把 manifest.json 的
 * background.service_worker 改回 "js/background.js" 即可。
 */
await import("./background.js");
await import("./background-overlay.js");

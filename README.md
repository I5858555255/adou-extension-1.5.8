# 阿抖 1.5.8 修改版

抖音视频/图文采集浏览器扩展（Chrome，Manifest V3）的修改版，版本号 `1.5.8.5`。

## 主要改动

- 为页面上的每个视频卡片、首页大屏播放器和详情播放器增加独立的「下载」按钮。
- 视频默认按分辨率选择最高画质（参考宽高、`gear_name`、`data_size`、h264）。
- 每个视频卡片/播放器下方追加「仅音频」子按钮，下载 `musicInfo.url_list` 对应的音频（`.mp3`），复用原插件音频逻辑。
- 图文作品不显示「仅音频」子按钮。
- 图文作品按图文处理：下载正文原图并额外保存一份 `.txt` 文案，不再错误保存为 mp4。
- 下载完成后「已下载」状态永久保留在对应作品上，页面滚动、卡片重渲染、SPA 切换或刷新后依然显示。
- 解析请求串行排队，实际下载并行执行。

## v1.5.8.5 修复 service worker 注册失败

- `manifest.json` 的 `background.service_worker` 改回直接指向 `js/background.js`（不再走单独的入口文件 + 顶层 `await import()`），避免 `type: "module"` service worker 里对 webpack classic 包做模块导入导致 "Service worker registration failed. Status code: 3"。
- 删除 `js/background-entry.js` 与 `js/background-overlay.js`（指纹降权补丁已内联进 `js/background.js` 顶部，备选文件冗余）。

## v1.5.8.4 指纹降权（针对「检测到高危插件」拦截页）

- 修复 `content/surface-download.js` 中重复声明 `enqueue` 的 SyntaxError（导致按钮永不出现、控制台持续报错）。
- `manifest.json` 收窄：移除 `xiaoshujiang.com` 的 host 权限、`<all_urls>` optional 权限与 `externally_connectable`；`web_accessible_resources` 只保留 douyin 域 + 三项实际引用的扩展资源。
- 内容脚本侧不再在 douyin 页面里跨域 `fetch` 视频 CDN URL；不再每 2.5s 全量扫描页面（改为 MutationObserver 事件驱动 + 可见性/焦点触发）。
- `js/background.js` 顶部新增补丁 IIFE：覆盖 `chrome.downloads.download`，跨域 CDN URL 的下载先 `fetch → Blob → blob: URL` 再走一次 `chrome.downloads`，降低"跨域 CDN 高频下载"指纹；`chromeDownload` 开关关闭或 fetch 失败时回落原行为。
- `manifest.json` 的 `background.service_worker` 直接指向 `js/background.js`（早期用单独的入口文件 + 动态 import 抽离补丁，因 module service worker 顶层 await 对 webpack 经典包注册失败 "Status code: 3"，故统一内联进 background.js 顶部；备选文件已删）。

## 安装

1. 打开 Chrome 的 `chrome://extensions/`。
2. 打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本项目目录。

如果扩展列表中存在旧的、损坏的「阿抖」条目，请先移除再加载。`manifest.json` 保留了原扩展的 `key`，扩展 ID 仍为 `kckmfllnpncljamnlfnaoplpmlbgjeal`。

## 说明

本项目仅用于个人学习与研究，请遵守抖音的服务条款及当地法律法规，不要用于侵犯他人权益的用途。

## 推送备注

v1.5.8.4 本地 commit 已打好（`6775f4e` + 文档同步 commit），但**推送到 GitHub 时本地网络对 `github.com:443` 的 git 流量被拦截**（`fatal: Recv failure: Connection was reset`，`https://github.com` 和 `https://api.github.com` 网页可达，唯独 git 协议端口被 reset；无可用本地代理，SSH 公钥未配置）。请在能通 GitHub 的网络环境（开代理 / 换网）执行一次：

```bash
git push origin main
```

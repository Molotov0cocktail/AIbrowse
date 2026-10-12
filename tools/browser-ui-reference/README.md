# 浏览器界面参考图查看器

用于查看十款浏览器的既有公开截图，从隔离 Electron 窗口生成实际渲染画面，供人工视觉调研。
这不是 AIbrowse 产品验收，不证明目标浏览器的版本、交互或功能。

在项目开发 PowerShell 中执行 `./tools/browser-ui-reference/run.ps1`。工具不构建、不加载或修改
产品 `out/`，不调用 Provider，不下载或保存远程原媒体文件；只保存 Chromium 渲染截图。

- 固定十个来源，每目标加载预算 20 秒，总预算 240 秒；遇失败停止剩余目标。
- 远程窗口无 preload，禁用 Node integration、页面 JavaScript、下载、弹窗与权限请求；
  启用 context isolation、sandbox 和 web security。
- 网络仅允许当前目标的精确主文档 URL；其他资源及重定向拒绝。
- 使用无缓存的内存 Session 与独立 profile；退出时关闭窗口。
- 原始记录与截图保存在忽略目录 `log/browser-ux-20261012/references-*`，不覆盖历史轮次。
- `captured-needs-visual-inspection` 仅表示捕获了非空画面，必须用图像查看工具逐张确认内容。
  加载成功不代表图像正确，不允许只凭索引宣称视觉研究完成。

工程范围为参考图可见性；来源可能有年代、裁切与分辨率限制，不能据图推断未显示的功能。

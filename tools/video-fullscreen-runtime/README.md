# 网页视频全屏原生验收

本工具使用真实 `AppSessionManager`、`BrowserControllerImpl` 和 Electron 窗口，不修改产品权限判定。所有运行使用新的隔离 profile，证据保存在 `log/video-fullscreen-20261030/<UUID>/`，不清除失败原件。

```powershell
. .\tools\maintenance\enter-project-environment.ps1
node --experimental-strip-types tools/video-fullscreen-runtime/run.ts
node --experimental-strip-types tools/video-fullscreen-runtime/run.ts --case=video --native
node --experimental-strip-types tools/video-fullscreen-runtime/run.ts --negative
node --experimental-strip-types tools/video-fullscreen-runtime/run.ts --shell --native
```

默认使用 `sendInputEvent`。`--native` 使用 Windows 输入 API；仅将隔离验收窗口置顶以免浮层遮挡，脚本先核对精确测试窗口和进程，尝试激活该窗口，再核对操作系统前台，鼠标还校验位置所属窗口。任何检查失败都停止发送输入。真实输入需要可操作的交互桌面，Electron `isFocused()` 不能替代操作系统前台证明。

每轮最多 180 秒、40 次本机请求、零 Provider 调用。`binding.json` 记录工具、打包涉及的产品源码、产物 SHA256 和预算；真实壳还绑定整个 `out/`。结束检查源码是否变化，进程退出码、判定文件和绑定检查均通过才返回成功。运行中修改源码的结果仅可诊断。

`--budget-ms=30000` 可缩短外部预算；`--trace-close` 透明记录关闭路径调用前后及主进程心跳，便于识别 native 阻塞。外部超时单独留下 `deadline.json`。每次本机请求及时更新 `requests.json`，每项结束更新 `partial.json`；单个异步探针独立限时。关闭正例检查窗口退出与精确旧 WC 销毁，不向正在销毁的页面注入 DOM 查询。

`--case=<名称>` 可选 `video`、`container`、`keyboard`、`iframe`、`iframe-noallow`、`escape-block`、`page-exit`、`switch`、`navigate`、`close`、`hide`、`automatic`、`background`、`task`、`ai`。`--negative` 只运行后四项。夹具的视频来自本机 canvas 流；跨源 iframe 使用不同主机名，不访问外网。

额外生命周期窄验使用 `page-close`（页面主动关闭）、`destroyed`（绕过 Controller 直接关闭 WC）、`dispose`、`owner-hide`、`minimize`，建议单例加 `--budget-ms=30000`。它们不改变默认十五项矩阵；隐藏与最小化分别检查退出全屏后仍保持对应窗口状态。

正例同时要求实际权限回调允许、DOM `fullscreenElement`、窗口全屏状态、视图全内容区尺寸，并验证退出后的布局恢复。工具在产品安装 Session handler 时透明包装回调，以相同参数同步转发且不改变产品判定，记录 WC 身份、权限、请求 URL、主 frame 标记与结果。负例要求实际尝试、权限回调明确拒绝或 Chromium 前置拒绝、零允许回调、零进入事件、DOM/窗口/布局不变；后台恢复可见后还检查无迟到全屏。Electron 43.8.4 权限拒绝分支可能不结束页面 Promise，因此不把 Promise 必须 reject 当作产品安全承诺；原旧 oracle 失败记录保持原判。后台与任务页的敌手负例可通过 `executeJavaScript(..., true)` 提供 Chromium 激活，但不产生产品实体手势；它不能用作任何正例证据。AI 路径必须经 `clickElement` 成功执行，再检查全屏被拒绝。

`--shell` 需要先完成产品构建，加载真实 `out/main/index.js`，打开 AI 侧栏并检验全屏期间的 renderer 布局更新及退出恢复。它不代替完整的发行或正常退出专项验收。

旧源码对照可加 `--baseline=<完整40位Git SHA>`，仅适用于控制器矩阵。esbuild 从该提交读取 `src/`，不改工作区；`baselineSources` 单独记录实际编译源码摘要。同一夹具、输入和 oracle 才能形成有效红绿对照。`--red` 仅是单 video 场景快捷选项，不表示结果自动构成有效红态。`--offset` 仅用于坐标诊断。

当前任务结论、逐轮账本和阻塞状态由正式任务文档与 `doc/tasks/progress.md` 维护；本文件只说明工具用法和证据边界。

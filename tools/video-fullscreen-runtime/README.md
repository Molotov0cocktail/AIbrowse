# 网页视频全屏原生验收

本工具使用真实 `AppSessionManager`、`BrowserControllerImpl` 和 Electron 窗口，不修改产品权限判定。所有运行使用新的隔离 profile，证据保存在 `log/video-fullscreen-20261030/<UUID>/`，不清除失败原件。

```powershell
. .\tools\maintenance\enter-project-environment.ps1
node --experimental-strip-types tools/video-fullscreen-runtime/run.ts
node --experimental-strip-types tools/video-fullscreen-runtime/run.ts --case=video --native
node --experimental-strip-types tools/video-fullscreen-runtime/run.ts --negative
node --experimental-strip-types tools/video-fullscreen-runtime/run.ts --shell --native
```

默认使用 `sendInputEvent`。`--native` 使用 Windows 输入 API；脚本先核对精确测试窗口和进程，尝试激活该窗口，再核对操作系统前台，鼠标还校验位置所属窗口。任何检查失败都停止发送输入。真实输入需要可操作的交互桌面，Electron `isFocused()` 不能替代操作系统前台证明。

每轮最多 180 秒、40 次本机请求、零 Provider 调用。`binding.json` 记录工具、打包涉及的产品源码、产物 SHA256 和预算；真实壳还绑定整个 `out/`。结束检查源码是否变化，进程退出码、判定文件和绑定检查均通过才返回成功。运行中修改源码的结果仅可诊断。

`--case=<名称>` 可选 `video`、`container`、`keyboard`、`iframe`、`iframe-noallow`、`escape-block`、`page-exit`、`switch`、`navigate`、`close`、`hide`、`automatic`、`background`、`task`、`ai`。`--negative` 只运行后四项。夹具的视频来自本机 canvas 流；跨源 iframe 使用不同主机名，不访问外网。

正例同时要求 DOM `fullscreenElement`、窗口全屏状态、视图全内容区尺寸，并验证退出后的布局恢复。负例要求实际尝试以及请求 Promise 拒绝；只有主进程拒绝日志而页面 Promise 未结束时仍判失败。后台与任务页的敌手负例可通过 `executeJavaScript(..., true)` 提供 Chromium 激活，但不产生产品实体手势；它不能用作任何正例证据。AI 路径必须经 `clickElement` 成功执行，再检查全屏被拒绝。

`--shell` 需要先完成产品构建，加载真实 `out/main/index.js`，打开 AI 侧栏并检验全屏期间的 renderer 布局更新及退出恢复。它不代替完整的发行或正常退出专项验收。

旧源码对照可加 `--baseline=<完整40位Git SHA>`，仅适用于控制器矩阵。esbuild 从该提交读取 `src/`，不改工作区；`baselineSources` 单独记录实际编译源码摘要。同一夹具、输入和 oracle 才能形成有效红绿对照。`--red` 仅是单 video 场景快捷选项，不表示结果自动构成有效红态。`--offset` 仅用于坐标诊断。

当前任务结论、逐轮账本和阻塞状态由正式任务文档与 `doc/tasks/progress.md` 维护；本文件只说明工具用法和证据边界。

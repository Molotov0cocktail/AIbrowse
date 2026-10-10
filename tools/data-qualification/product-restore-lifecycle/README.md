# R/P 普通关闭观察

本工具只用于已审 ReleaseProfile 场景内的普通关闭。`startOrdinaryLease` 在调用入口固定
`min(场景余额, 30秒)`；预检、helper 启动、编译、身份采集、UI 关闭、退休读回与实际 helper
退出共享该期限。先保存返回的 client，等待 `ready()` 后由 runner 发出 Window.Close，
然后等待 `retired()` 和 `closed`，核对 `pendingOwned === 0`。没有第二条关闭命令或续租。

原生 helper 持有 main、guardian 及已分类 Job 成员句柄，绑定 PID、FILETIME、image 文件身份、
包摘要、同一 profile 身份、guardian 参数/session 与 writer 账本。仅打开外层 ReleaseProfile Job
进行查询；不打开内部 writer Job 或 owner.lock，不发送产品终止。外层的资源与停止责任保持。
`ready` 之前必须精确持有两个活句柄；退休必须两个句柄 signal/exit0、同 session 账本双空，
且外层 Job 仅余工具成员。无法分类的新成员立即失败。瞬态未捕获进程不被猜成安全成员。

接口没有恢复审批或继任模式。C# 仅复用 `product-restore-process/SuccessorObserver.cs` 中公开的
`ValidateCim`、`ValidateRoles` 和有界 `ReadFrame`；不构造其 observer，也不调用其 `finish`。
原生文件/句柄采集沿用其中的安全原语。TS 复用 `Identity`、`identity`、`decodeLedger`、`sha256`
以及 profile isolation policy、bounded JSON；guardian 源码摘要固定于已有审查版本。
调用方的来源清单必须绑定本目录、上述依赖及它们的导入闭包。

每帧最多 4 KiB，原件最多 512 条/2 MiB，最终回执最多 64 KiB，最多持有 128 个身份。
输出独占 `journal/runner-output/ordinary-<pid>-<FILETIME>/`，失败原件保留。最终回执的存在
不单独授权后续动作；必须收到合法 retired 帧并核实原 child exit 和 close 均为 0。
TS 的逻辑超时不解除原 IO、队列或 child close 所有权，失败调用外层 stop 回调。

普通冷启动和首次 UI 的 boot60/UI30 预算由 runner 持有；本工具不授予这些门通过。
它也不判定 Store 健康、四域语义或恢复正确性，不替代完整 R/P 独立审核与实际场景。

验证入口：`protocol.test.ts` 的身份/证据/异步反例和 `test-native-pure.ps1` 的实际退休谓词。
纯检查不创建产品、Job、UI 或真实观察 session。

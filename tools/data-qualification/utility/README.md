# E2 独立 utilityProcess 资格

本工具仅回答：当前 Windows x64/Electron 43.7.7 在产品相同安全 fuse 下，固定 entry 的
`utilityProcess` 执行同步 `node:sqlite` 时，父进程能否确认终止，并保持实际 sandbox UI IPC 往返。
这是冻结 E2 产品预算前的工程资格，不是 AIbrowse 产品包验收、E2 PASS 或独立 Windows 安装证据。
正式契约见 `doc/stage7/detailed-design.md` §4；工具不得修改产品 release 入口。

## 固定测量设计

- 固定 1 次运行：control 1 轮、native 3 轮、迟到/洪泛/畸形各 1 轮；最多 7 个串行 utility 进程。
- native 固定编译期递归 SQL，内存数据库、常量大小递归状态；观察 1000 ms 后请求 kill。
  `entered` 标记后同步调用未返回、JS heartbeat 停止且无结果，说明观测窗口位于固定 native 调用中；
  不声称采集了 native CPU 栈。control 执行已知短 SQL 并正常退出作为对照。
- kill→Electron `exit` 事件单调耗时观测门 2000 ms；逐轮总时限 7000 ms，app 总时限 65000 ms。
  原封复用已审核 `tools/release-profile/JobProcess.cs`，Job 90000 ms 后强制收口，最多另等 30000 ms。
- 实际 sandbox renderer 每 50 ms 经 preload invoke 往返并上报样本；native 期间至少 6 条，
  往返不超过 750 ms，相邻/两端空隙不超过 1000 ms。保留全部样本供最终分布分析。
  这些只是事前可行性观测门；E2 产品预算仍须结合完整容量 IO、维护 drain 和用户体验正式冻结。
- IPC 只接收固定小 JSON 状态：单条 256 bytes、最多 32 条、累计 8192 bytes。
  洪泛固定发送 64 条，超额关闭操作并终止；畸形只发 257 bytes。迟到成功在故意失败后到达，必须拒绝复活。
- 构建和运行目录总量不超过 768 MiB；实际包、原件、合成 profile 全部在新建的
  `log/stage7-e2/utility-<32位ID>`。启动前后目录核查；不清理失败原件，不接触实际 aibrowse profile。
- 任何预设门失败立即停止后续轮次；相同路线连续两轮无新证据则换路。禁止更改阈值迁就结果或覆盖重跑。

## 入口

只使用现有依赖，构建读取本地 Electron dist，无依赖安装或下载。源码以当前 TypeScript 转译成 CJS，
ASAR 正向清单仅 7 文件；EXE fuse、ASAR header/文件 hash 及 PE 完整性资源均实读核验。

```powershell
node --experimental-strip-types tools/data-qualification/utility/build.ts
# Build 输出 utility-<ID>；此步不启动 Electron。
pwsh -NoProfile -File tools/data-qualification/utility/run.ps1 -BuildId utility-<ID>
```

运行前必须由主协调分配无其它验收运行的窗口。BuildId 仅匹配固定格式，不能指定任意路径、SQL、脚本或命令。
一次构建只允许启动一次。Node 包预检与实际运行均先移除非白名单环境变量，并在 finally 恢复；
使用 `[NullString]::Value` 真正移除变量，避免 PowerShell 将 `$null` 转为空字符串。
utility 的环境为空，不注入配置、Key、Session 或文件成员。
UI 通过独立安全 scheme 的两资产白名单，只加载 ASAR 内 `ui.html` / `renderer.js`；
请求不能指定任意文件。Node 关闭、context isolation/sandbox 开启，禁止新窗和网络请求。
`GrantFileProtocolExtraPrivileges=false` 保持与产品一致，不通过恢复 file 协议特权加载 UI。

### UI 资产边界与旧失败的适用范围

UI 固定入口为 `e2qualification://app/ui.html`；唯一脚本为
`e2qualification://app/renderer.js`。主进程仅接受这两个精确 URL 的 GET，映射到编译期文件名，
不把请求路径拼接进文件系统路径。未知资产、其它 host、query、fragment 或方法均拒绝。
scheme 注册为 standard/secure，不启用 CSP 绕过、Service Worker、扩展或 Fetch API；
资产响应带固定 CSP 和 `nosniff`。preload 保持独立的固定 ASAR 路径，UI 没有通用 IPC 或文件读取接口。

最初两次实际运行使用 `file://…/app.asar/ui.html`，均在获得 UI 样本和创建 utility 进程之前失败。
第一轮只记录了失败分类，具体首错仍 unknown；第二轮增加阶段和有界受信错误诊断，明确记录
`加载固定UI` 阶段的 `ERR_FILE_NOT_FOUND (-6)`。ASAR 成员的静态存在性已经核对，但这些结果
不能单独证明失败由哪一个 fuse 引起，也不能判断 native SQLite 终止路线成功或失败。
两轮各自的 Job 均已确认归零，并保留失败包、报告及进程查询原件；不覆盖或删除这些证据。

后继方案采用产品同类的安全自定义协议，保留全部 fuse、UI 隔离配置和事前测量门限。
协议单测与包静态检查只证明各自覆盖范围；仍须通过新的实际运行才能取得 UI 往返及 utility 终止证据。
本节记录方案适用边界；具体构建、最新运行状态与阶段结论仍由原始报告和 `doc/tasks/progress.md` 管理。

进程拥有相同 Windows 账户权限，路径和 IPC 限制不是 OS 沙箱。合成 active marker 在失败前后 hash 必须不变，
协议仅 control 正常结果+exit0 可授予切换资格；这不能代替后续真实三库恢复的零切换反例。

## 检查与原件

```powershell
npx vitest run tools/data-qualification/utility/protocol.test.ts --maxWorkers=1
npx tsc --noEmit -p tsconfig.node.json --composite false
npx eslint tools/data-qualification/utility
npx prettier --check tools/data-qualification/utility
```

`measurement-plan.json` 是运行前固定设计及源码摘要，`package-proof.json` 为真实产物静态证明；
`runtime/report.json` 保留版本、退出时延、所有 UI 样本、反例状态、合成原件 hash；
`job-result.json` 独立记录实际 EXE 进程身份、退出码、Job 归零和总耗时。
全部原件留在 gitignored `log/`，不能用正常退出或本工具单次通过替代 E2 产品验收。

API 依据：[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、
[parentPort](https://www.electronjs.org/docs/latest/api/parent-port)。运行适用范围以实装 43.7.7 与实际产物为准。

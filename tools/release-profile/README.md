# Windows release disposable profile 资格工具

本目录只服务 E1 的 Windows x64 未签名目录包资格。工具不修改产品的数据根逻辑，也不提供 OS 文件沙箱、
安装验收或公开发布能力。运行需要项目既有的 Node 24、PowerShell 7 和 NTFS；不会安装 SDK、MSVC 或其它工具。

## 当前入口

```powershell
# 只读检查：确认没有 AIbrowse/Electron 进程，固定 KnownFolder/aibrowse 为空，
# 并核对声明路径与解析实体的 128 位 FileID、64 位卷身份和 ACL。
pwsh -NoProfile -File tools/release-profile/disposable-profile.ps1 -Action Preflight

# 唯一实际入口：固定先跑 Product，再跑 Tamper。
pwsh -NoProfile -File tools/release-profile/disposable-profile.ps1 `
  -Action Run -Runner All -PackageRoot release/win-unpacked

# package.json 中的同一入口。
npm run test:release-security

# 仅当 All 已留下“Product 成功、Tamper 失败”的受审原件时：先按下述
# ArchiveFailed 保全旧 profile，再验证旧 Product 报告与当前候选字节绑定，
# 最后在新的空 root 中只补 Tamper。旧 All 终态不会被改写。
pwsh -NoProfile -File tools/release-profile/disposable-profile.ps1 `
  -Action ValidateTamperBinding -Journal <旧All journal绝对路径> `
  -PackageRoot release/win-unpacked
pwsh -NoProfile -File tools/release-profile/disposable-profile.ps1 `
  -Action Run -Runner Tamper -PackageRoot release/win-unpacked `
  -BindingJournal <旧All journal绝对路径>

# 固定失败现场通过 terminal/marker/根身份门后，原子归档到实体父目录的唯一 sibling，
# 再以同一 ACL 创建新的空 KnownFolder 根。未知状态、跨卷和已存在目标全部拒绝。
pwsh -NoProfile -File tools/release-profile/disposable-profile.ps1 `
  -Action ArchiveFailed -Journal <失败journal绝对路径>

# 仅采集失败原子写的根/tmp/缺失target元数据与 Node realpath 视图；不读文件正文。
pwsh -NoProfile -File tools/release-profile/read-failed-atomic-metadata.ps1 `
  -Journal <失败journal绝对路径>
```

`Run` 不接受任意命令、脚本、回调或 userData 路径。首次完整资格只接受 `All`。Product 必须先运行，因为原生
Provider 取消反例要求首次 profile 中不存在 Provider 配置；Product 失败会立即停止，不会继续 Tamper。
`Tamper` 是故障恢复专用固定入口：它必须绑定已归档的同候选 Product 成功报告、失败终态和三项包哈希，且只在
新的空 root 中执行。任一绑定缺失、阶段不符或候选字节变化都会在创建新 journal 前拒绝。

当前工具只认领已经明确授权清空的固定 Windows `ApplicationData/aibrowse`。首次运行前该目录必须为空。
`Run` 本身不会删除、移动、恢复或重置这个目录；成功和失败都会保留全部合成状态与证据。失败后不得直接
复跑。受审的 `ArchiveFailed` 只接受本工具拥有且已证明 Job 归零的失败 journal：它在固定解析实体父目录中
原子保全旧 root，并按原 ACL 独占创建新的空 root；不会复制、删除、覆盖或接受任意归档目标。

## 文件系统身份与证据

- 工具同时打开 KnownFolder 声明路径及其 `GetFinalPathNameByHandleW` 解析实体，要求二者的
  `FileIdInfo`、卷身份、owner/group/DACL 和 NTFS 类型一致，且都不是重解析点。
- 根目录句柄在整个运行期间禁止 delete share。固定命名互斥阻止两个 `Run` 或 `Preflight` 并发认领。
- journal 独占创建于 `log/stage7-e1/disposable-profile/journal-<runId>`，DACL 只允许当前用户和 SYSTEM。
  `manifest.json` 记录声明路径、解析路径、根身份和候选 EXE 路径。
- owner marker 以 `CreateNew` 写入固定 profile，记录 `runId`、128 位 FileID 和 64 位卷身份。工具以同一
  限长读取句柄验证内容，并在完整 Job 生命周期持续禁止写入、删除或替换 marker。
- Node runner 独立 `stat(bigint)` 声明路径与解析路径，要求 `dev+ino` 完全相同。Product 启动前 profile
  只允许存在 owner marker。
- `terminal.json` 无论 Job 成功或失败都记录根退出码、Job 是否实际归零、marker 与双路径身份是否复验通过。
  原始 runner 输出和失败现场一律保留。
- `ArchiveFailed` 在操作前持有实体父目录和失败 root 身份句柄，写入 durable intent，并保存 rename、新 root
  创建及终态证据。新 root 创建后的任何异常都保留新旧两方；工具不会盲目回滚或清理失败现场。

宿主为 MSIX 时，声明的 `C:\...\AppData\Roaming\aibrowse` 可能解析到包虚拟化后的其它卷路径。工具不根据
字符串猜测隔离是否成立，只接受上述句柄身份和 Node 双视图实测一致。进程的 `GetPackageFullName` 只作为
观测字段；它本身不证明文件系统视图一致。

## 固定进程边界

根 Node runner 使用 Windows `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建时原子加入带
`KILL_ON_JOB_CLOSE` 的 Job，所有后代继承同一 Job 且不能 breakaway。工具记录根 PID 与创建 FILETIME；
产品进程探针必须同时满足 Job 成员、固定候选 EXE 路径和同一 profile 身份，并记录进程创建 FILETIME。600 秒超时后终止
整个 Job，并最多再等待 30 秒确认实际进程数归零。没有归零就失败并保留现场。

`tools/release-profile/test-job-process.ps1` 覆盖根进程先退而后代仍存活、超时归零、启动失败，以及
`AssertContains` 的 Job 成员正控和外部进程反例。旧 `profile-isolation.ps1`、恢复矩阵和夹具保留为此前
同父 rename 方案及其失败证据；MSIX 虚拟化使声明路径与实体路径跨卷时，旧入口会拒绝，不能用于当前实际资格。

## Product 与 Tamper oracle

Product 使用最终 `AIbrowse.exe` 和正式 UI/IPC，不增加 release 调试后门。`--force-renderer-accessibility`
只启用 Chromium 的正式 Windows UI Automation 支持，候选 EXE 哈希不变。固定检查覆盖：

- 应用 UI 与 CSP 可用，环境 renderer URL、`NODE_OPTIONS`、`ELECTRON_RUN_AS_NODE` 和 userData 覆盖均失效；
- 原生 Provider 取消与确认、目标世代绑定、受控 loopback 成功请求、凭据重定向拒绝；
- 第二实例退出并恢复/聚焦原窗口；
- 首主进程确证退出后，以同一候选和owned profile冷重启：UI 必须读回已存Provider/Key状态和上一轮答复，
  且不重写配置/凭据即可用原目标与原合成Key完成新请求；
- 启动前后的合成 profile 清单差量，要求配置、DPAPI 凭据、Sources/Research/Watch 数据库和日志都落在
  同一固定 root；合成 Key 在有界完整扫描中零明文命中。

冷重启前后还会比较配置与凭据的字节哈希、文件身份、版本和世代；会话文件必须保留旧答复并由新问答推进。
三个 SQLite 文件以只读连接执行 `quick_check`、外键检查、固定 schema/版本检查，并由受控 Job 内的原生探针
比较声明/实体路径的 128 位 FileID。该证据只证明当前空业务库重开时仍是同一对象且 schema 完整；不声称
已有 Sources、Research 或 Watch 业务行已经跨重启验收。

Windows TaskDialog 的按钮在当前同版 Electron 中由 UIA 暴露为没有 `InvokePattern` 的 Pane。工具只接受属于
精确主窗口 owner、精确目标对话框、同 PID 的唯一 `Button` HWND，并要求 MSAA `OBJID_CLIENT` 返回精确名称、
push-button role、enabled 状态和非空默认动作；调用前重新验证 owner/目标与同一语义对象后才执行默认动作。
它不使用坐标、键盘模拟或窗口消息回退。

Tamper 先确认原包可运行且 Node/Chromium 调试端口均未监听，再复制候选并分别修改 ASAR 内容、移走 ASAR
加入裸 `app`。两个反例都必须拒绝运行，裸 app canary 必须零执行。Product 与 Tamper 报告均记录实际 EXE、
ASAR、ASAR header 的 SHA-256，并绑定 package-policy 对 fuse 和 PE `ElectronAsar` 资源的实读结果。
AppData 探针在 Electron ready 前只同步读取三个路径并立即退出；调用方设 10 秒期限，超时后必须终止进程树并
确认退出。探针报告明确区分 Windows AppData、探针默认 userData 与 sessionData，不用默认 Electron profile
冒充产品数据根。

所有通用源码位于受控 `tools/`。机器日志、候选包、合成 profile、journal 和失败原件只写入 gitignored
`log/`、`out/` 或 `release/`，不进入 Git。

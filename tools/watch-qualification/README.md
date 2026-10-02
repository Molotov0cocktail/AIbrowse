# Watch 非暂停资源验收工具

产品与验收契约见 `doc/stage6/detailed-design.md` §15.6/§15.7；本工具不改变固定负载或资源阈值。
原始 JSONL、构建产物、机器配置和合成数据库放在受控的 ignored 目录，源码及反例纳入 Git。

## 运行

1. `pwsh -NoProfile -File tools/watch-qualification/build.ps1 -Tests` 构建 Windows 采集器并运行真实子进程和文件占用反例。
2. `npm run build:qualification:load-diagnostic` 生成短验产物；正式窗口用 `npm run build:qualification`。
   normal 与各资格构建输出到不同目录，不能用普通入口替代资格入口。
3. `run.ps1` 接受 `-WorkParent`、`-ArtifactRoot`、`-Mode short|formal`、`-EnvironmentApproved`。
   两个目录须预先存在；工作父目录须在仓库和用户 profile 外，证据目录可位于仓库 `log/`。
   开关只表示操作者已完成环境与关键改动审核；脚本还会执行只读预检，不能把开关当隔离证明。
4. 独立复算：`node tools/watch-qualification/report.ts <observations.jsonl> <telemetry.jsonl> <新报告.json>`。
   输出文件必须不存在，防止覆盖旧报告。原始证据始终保留。

采集器直接创建 suspended Electron，加入专属 Job 后启动；产品不等待外部采样。CPU使用Job累计量，
内存与句柄逐成员保留身份并前后复核，可能阻塞的查询在独立worker中有界执行。每项记录独立QPC区间；
worker失败记录invalid，不补零。main遥测原件的QPC为固定16位十六进制，外部记录为十进制字符串，报告器分别解析。

短验覆盖固定负载中的四个Session初始化任务，只证明测量可行性。正式资源窗口仍需361点、drain61点；
CPU、内存、main、释放结果分别报告，已证越界不会被其它指标的缺证掩盖。电池、关闭后DB业务事实、隐私和
Windows稳定性未覆盖时，总门保持缺证。工具不会自动删除运行根；后续必须先按身份复核数据库与本轮所有权。

## 验证

`npm test -- --maxWorkers=1 tools/watch-qualification` 运行报告器与安全预检反例。
工具TypeScript纳入项目typecheck/lint/format。native反例覆盖退出子进程CPU、Job残余、禁止breakaway、
伪writer、普通读/写/DELETE共享句柄、真实SQLite连接以及temp条目。测试过程不读取真实凭据。

## 关闭后的数据库复算

原库不得用SQLite打开；即使readOnly也可能创建WAL/SHM。先用采集器的`--verify-released`
绑定原始root FileId、watch目录和DB身份，再使用`build-database-copy.ps1 -Tests`构建的
`database-copy.exe --copy-closed <repo> <runRoot> <rootIds.json> <watchDirId> <watchDbId>`。
复制工具在独占源句柄存活期间复制两个数据库，生成hash/FileId收据并保留失败副本。
调用方须设置120秒外部期限；来源根和副本均保留，不做自动删除。

`build-database-report.ps1`将报告器构建至`log/watch-qualification-build/database-report.mjs`。
CLI参数为`<副本runRoot> <runId> short|formal [认证setup中的M0 UTC]`，正式模式必须提供M0。
报告只含计数与分类；副本来源收据、内部运行时长和资源报告须由总验收绑定，不能单凭DB内容授总门PASS。
报告器关闭副本后再次核验原始释放状态，防止把观察器副作用误判为产品事实。

## 空白页开销的单次机制实验

仅在正式测量和drain结束后，使用`build.ps1 -Target blank-feasibility`构建专用启动器，
再运行`run-blank-feasibility.ps1 -WorkParent <合成根父目录> -ArtifactRoot <证据目录>`。
工具使用固定CJS、全新六根、显式user-data-dir、默认GPU及专属Job。仅比较真实WCV构造、
显示并聚焦、显式加载空白文档三个阶段；显式加载前不执行页面脚本。CJS正常实验预算28秒，
启动器及外部收口期限分别110/120秒；不自动重试，失败原件保留。

输出只含固定阶段、PID/type、生命周期计数、合成DOM布尔值以及Job成员资源。它不证明完整产品、
四个Session任务或正式资源门通过；只用于决定是否继续默认空白页延迟加载的工程候选。

产品修复后的窄集成冒烟：`build-browser-smoke.ps1` 编译实际BrowserController/SessionManager，
再给同一启动脚本加 `-ProductSmoke`。启动器额外固定bundle并记录hash。八组场景验证默认空白
显示聚焦、首次导航、并发物化、替代导航、显式空白兼容、交互跨文档拒绝及关闭/销毁的等待取消。仅使用本机
公开固定HTTP夹具；没有Provider、用户profile或公网请求。单进程预算50秒，外部预算仍120秒。
产品日志保留在raw stdout；必须收到全部场景通过收据并且exit0/Job0/EOF，不能只看退出码。

## 完整产品冒烟矩阵

`run-product-smoke.ps1 -Variant dev|production -Kind default|session|sources|sources-ui|research|watch -ArtifactRoot <证据目录>`
为每组创建新的合成根；跨进程组在同一根顺序执行set/check。子进程只继承必要系统环境，使用离线FakeProvider，
保存stdout/stderr、退出收据和失败根。production须先明确构建当前候选，脚本通过preview的`--skipBuild`
复用该产物并逐模式记录入口hash；完成production矩阵前不要交错运行会改写out的dev构建。
每次进程最多15分钟，失败即停止后继。退出收据仍须与实际产品断言及清理日志核对，不替代正式Job释放门。

`read-console-environment.ps1`只读当前进程SessionId及[物理控制台会话](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-wtsgetactiveconsolesessionid)，
补充UserInteractive和[SM_REMOTESESSION](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getsystemmetrics)。
不能仅以SM_REMOTESESSION=0判定本地会话；输出不证明未锁屏、无远程协助或整个窗口环境恒定，也不改系统设置。

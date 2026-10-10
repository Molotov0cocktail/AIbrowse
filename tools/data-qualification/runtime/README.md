# E2 实际 main 工程资格

契约见 `doc/stage7/detailed-design.md §4.1–4.2`。工具绑定实际产品 main、preload、React UI、生产 Research factory、各 Service/Repository 及现有 Electron 43.7.7 可执行文件。运行 `SMOKE_MODE=false`，使用固定、全新合成 profile。没有真实资料、凭据或外网请求；不实现备份 UI、不可信容器解析或新数据集恢复。

这是非 release 开发构建的工程资格，不授 E2 产品通过、release EXE 或独立 Windows 环境验收。已通过的 packaged utility fuses/native kill 机制、5GiB I/O 与 Conversation 投影证据各保留其原适用范围，不重复运行。

## 冻结的一轮

- 最大同代输入：5000 Sources；30 个稠密 Research；200 Rule、2800 Event、8400 Evidence pair、1030 Digest；50 Conversation，其中一个恰好 64MiB。没有声称覆盖有限历史最大值。
- idle 维护 ready → utility 同代一致副本/校验 → resume → 活跃操作维护 → resume → 实际退出排水。
- 2 次 acquire→ready 各不超过 20 秒；票据共用应用 90 秒 deadline；1 次 utility 不超过 30 秒；Job 90 秒、回收 30 秒；候选目录累计不超过 2GiB。
- UI 每 50ms 经真实 sandbox preload/main IPC 往返；RTT≤750ms、相邻及相界间隔≤1000ms。idle、utility、active、resumed 四相各至少 1 秒且至少 6 次；短相的额外观察时间单列为 workFinished→finished。首个真实 sample 至 resumed 相结束另作全程判定，包含四相之间创建活跃负载的过程。
- utility 双向最多 16 帧/64KiB，每帧≤4KiB。仅在绑定摘要一致、同 operation 未失败、8 个阶段完整有序、唯一闭合 result 和实际 exit 0 全部成立时接受。exit 0 本身不足以成功（已知被 kill 的 utility 也可能 exit 0）。异常、迟到、洪泛不能授静默许可或更换数据集。

活跃操作通过真实 main root gate 调用真实服务，观察 Chat、Agent、Research、Watch acquisition、Digest、Preview、Export 和 usage 的原 Promise。Agent 先完成真实 `source_list` 工具调用；Research 使用生产 factory；Watch 同时记录原 executeRun 与其受控 acquisition。取消后人为保持固定 1 秒，再释放端口，原 Promise 与真实持久终态必须先于 maintenance ready。人工保持与释放后的自然尾部单列。Notification 同步实际投递并核对持久终态，未伪称存在异步长任务。

受控 Provider/acquisition/save-dialog 只证明本地取消、所有权和排水协议；不作为真实 Provider、Public/Session 网络或 task-owned Tab 采集通过证据。真实主工作区仍执行正式 cleanup/reconcile。各业务调用由 main 私有工具发起；仅 UI ping/sample 经资格 IPC，不冒称所有业务 UI IPC 已覆盖。

## 输入与语义

生成器复用原容量工具，重新生成 Research 稠密正文。只修正旧合成元数据：Sources 人工断言的 verification（实际 SourceService 同形写入为 asserted）、Research 来源/排序键一致性与正式 32hex 哈希、Digest 父 runStats 与 cursor；正文、Evidence 与结果未裁切。旧原件与小样本失败保留。

utility 在主维护屏障内以 readOnly SQLite 打开真实 main 三库，经 `node:sqlite.backup(rate:100)` 将含 WAL 的一致数据写入新 staging；不复制活库主文件代替快照。三库原件及存在的 WAL、Conversation 原件前后流式 SHA256 一致。所有 migration、Sources FTS 重建只针对 staging。

staging 复用正式 `openPrivateStagingDatabase`，逐库打开、完成该阶段并关闭，再打开下一库。只对可丢弃私有副本设置 MEMORY journal/temp、8MiB cache 与各库物理上限对应的 max_page_count；实际 SQLite 版本、编译选项和回读配置逐次留存。`heapEnforcement:'not-guaranteed'` 明确表示没有 SQLite 堆硬限，不把配置或 RSS 采样当作防止 OS OOM 的保证。

扫描复用正式 `validateTransferSchema`/`normalizeTransferSchema`、Sources、Research、Watch 业务扫描器；13 个固定空历史前缀覆盖正式迁移路径，不能代表历史满库迁移成本。Conversation 复用已资格化的闭合白名单投影，恰好 64MiB 样本不得裁切。active 阶段才创建正常新 Research 任务（按正式保留策略淘汰 1 个旧终态）、Event 与 Digest，最大输入扫描在这些变化之前。

RSS 为阶段/投影采样峰。磁盘为各相/各扫描阶段末目录普查，保留 fixtures+实际 profile+staging 共存量；不声称捕捉所有瞬时 SQLite/OS 临时文件。容量硬限与最终整链峰值仍须正式实现验收。

## 准备、审查、运行

已有依赖即可；不安装或下载工具。源码纳 Git，`log/stage7-e2` 原件不入库。

1. `node tools/data-qualification/runtime/build.ts` 只构建新候选，绑定源码、bundle 和实际 Electron.exe SHA256。
2. 主协调确认 scanner 版本后，运行该候选固定 `prepare.cjs --prepare-fixed-fixture` 一次生成/校验全量合成 fixture；预算 30 秒/2GiB。失败保留并停止，先诊断，禁止无变化重跑。
   后续代码修复可用 `node tools/data-qualification/runtime/reuse-fixture.ts <原 BuildId> <新 BuildId>` 复用已成功准备的固定样本。入口仅接受两个合法 BuildId，拒绝已有现场的目标，核对完整 67 成员及复制前后 SHA256，保留原证明摘要与版本边界；不重新生成样本，不把原版本语义验证冒充当前版本通过。
3. 普通/release 构建后，`node tools/data-qualification/runtime/inspect-build.ts` 检查主/预载/UI 制品零资格入口，并核 release 模块报告。专用编译插件先移除资格分支；最终打包结果及模块报告证明资格 imports/hooks 已被剥离，不能只检查转换前后的源码字符串。
4. 独审、边界差量核对、主协调独占窗口后，仅以 `run.ps1 -BuildId runtime-<32hex>` 运行一次。启动器清环境覆盖 Node 预检及 Electron，finally 恢复；原 JobProcess 负责整棵进程树收口并真实 ConfirmReleased。

失败不调宽阈值、不自动换包再跑。报告写明有限工程范围，所有旧失败与候选保留。普通 UI 文档握手/普通 IPC 的维护门没有被资格 ping 放宽。

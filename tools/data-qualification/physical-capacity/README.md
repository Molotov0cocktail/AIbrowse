# 物理容量夹具：Research 64 MiB 前置工具

`padding.ts` 只接受调用方独占的合成 SQLite 副本连接；不得传入用户数据连接。`build.ts` 和 `run.ps1` 现提供固定 Research 64 MiB 前置入口，只接受工具生成的 scopeId，没有任意路径、域、SQL、目标长度或重试参数。该入口须经新的独立审核后才可实际运行。

固定算法使用两个工具表。bulk 通过参数绑定的 `zeroblob` 分配页面，每条不超过 8 MiB，最多 512 条，并预留 16 页。独立 tail 表只有一行，其 root 保持一个 leaf；一次更新按剩余页数乘 `page_size - 4` 分配 overflow 页。实际 `page_count` 和 `freelist_count` 必须证明精确触顶，随后 DROP 两表并提交。尾段若未精确触顶立即失败，不搜索其它 payload。

仅支持 `auto_vacuum=NONE`；不扩长文件、不尾补零、不执行 VACUUM。目标最大 512 MiB，必须按已核页大小整除，不能缩小原库。固定 scratch 名称碰撞或调用方已有事务时在写入前拒绝。schema 定义、user_version、完整性和外键检查在成功前复核。业务数据还需调用方按固定 fixture oracle 验证。

小测试使用实际 Node SQLite，单库不超过 1 MiB，保留全部小原件。它们验证 512/4096/65536 页大小、已有 freelist、精确目标、schema/业务不变、输入拒绝与自有事务失败结算。新增功能的首个红态仅证明模块尚未实现；不是历史产品缺陷红态。

## 来源、预算与输出

- 唯一源为 `runtime-9399eea0c11d4e6f9cde46ae2369376b/fixtures/research/research.db`；复用 FullTransfer 编译期长度/hash和固定源证明 `f07a1a59ef5639d10c17eae1a80e6f7709d681623230c64d7bd54f4b089077e5`。源不原地写，不读取其 profile 或真实用户数据。
- 构建创建全新 ignored `log/stage7-e2/physical-capacity-<UUID>`。绑定实际打包输入、工具源码、package/lock、制品、固定 Node 24.18.0 可执行文件及原生监督器源码。最终 proof 绑定构建证明 hash；当前源码改变必须新建构建，不能沿用旧证明。
- 运行复用 FullTransfer 的独立文件复制及原 `FixedTransferJob.cs`，使用 import 模式：最多一个子进程、单进程/Job commit 2 GiB、100 ms RSS 采样 1 GiB、Node old-space 768 MiB。整个 wrapper 共用 120 秒工作期限，随后最多 30 秒仅精确退出与 Job0 收口。同步 SQLite 由父 Job 截止，不依赖进程内检查强制中断。
- 原件以只读且仅共享读的句柄持有至结束；文件身份、路径、父目录、非 reparse、单硬链接、非稀疏/压缩由原监督器复核。副本始终 `wx` 创建，原件逐 64 KiB COPY 时核hash，最终输出hash流式采集，目录不允许 WAL/SHM/journal。新增 `allocation.cs` 只从已持有输出句柄读实际分配量，无路径或写入能力。
- 本轮新增磁盘量为 `2 × round(64 MiB) + round(128 MiB) + round(16 MiB) + 1 GiB`，逐文件按实际卷分配单元取整，同时核原生与 Node 可用空间；已有源与失败原件已计入当前已用量。源副本原位扩至64 MiB，生产暂存连接采用 `journal_mode=MEMORY`、`temp_store=MEMORY`、`cache_size=-8192`；这不控制backup内部的目的连接。独审实际小库证实该连接会临时创建rollback journal，因此单列J=128MiB拒绝预算，不能把小测试观测512B外推成上界。16MiB只覆盖构建/证明/诊断，原1GiB空余量保持。
- `journal.ts` 在backup前、每次progress与连接关闭后检查固定目录、原件/目标身份及长度；运行期只额外允许唯一目标`-journal`，源sidecar、WAL/SHM、未知成员、链接、身份变化或首次观测超过J都失败并保留原件。读取journal的短句柄核fstat/路径身份后立即关闭，允许SQLite退役；结束必须无附属文件。证明记录离散`maxObservedBytes`及次数、J、最终缺席和`continuousPeakVerified=false`，wrapper严格核字段/类型/范围。它不声称连续峰值、硬磁盘预约或采样间没有其它变化。检查异常仍结算并关闭自有SQLite连接，不重试。
- Node 阶段使用生产闭合schema与 Research只读业务validator，前后任务数均30，schema/user_version/业务投影保持。backup 复用生产调用方式 `node:sqlite.backup(rate:64)`，随后只读重开并复验精确长度、完整性、外键、schema、业务和freelist。
- 输出 `fixtures/research.db`、`fixtures/research-backup.db` 和有界proof；全部保留。首次失败停止，不复用scope、不删除失败文件、不提高期限或资源门。存在 `generate-intent.json` 即拒绝同scope重跑。最终stdout与原Job证据必须成功闭合，不能单凭较早的 fixture-proof 或 generate-result 宣称成功。

## 入口与资格边界

审核通过后，主协调在实际运行窗口使用 Node 构建，再在新的 PowerShell 7 进程运行一次：

```powershell
node --experimental-strip-types tools/data-qualification/physical-capacity/build.ts
pwsh -NoProfile -File tools/data-qualification/physical-capacity/run.ps1 -ScopeId <本次构建返回的scopeId>
```

调用方保留完整stdout/stderr原件。构建不启动生成。该工具实际运行也只授 `research64-node-construction`；proof始终 `productE2Pass=false`、`electronQualified=false`。真正产品 SQLite/业务资格必须经过实际 Electron 产品 worker。512/64/512 MiB 三库生成及组合 full50 链路仍未实现、未运行；不能把小库算法/backup通过拼成物理最大PASS。

小测试每个数据库≤1 MiB，保留原件；覆盖精确页数、已有freelist、schema/业务保持、backup保留长度、期限/附属文件/已有目标拒绝以及空间计算。通用身份与复制反例复用 FullTransfer IO测试，原原生Job资格按其明确范围复用，新增绑定/组合仍需独立审核。

同步 SQLite 不承诺可被本地 `check()` 强制中断；实际生成必须由父进程按冻结期限监督。失败不返回 proof；包含 BEGIN 已成功但其后检查抛错在内的自有事务失败均尝试 ROLLBACK，调用方仍持有连接和现场，不能据异常就删除文件。进入工具前已有调用方事务仍在写入前拒绝，不能替调用方回滚。

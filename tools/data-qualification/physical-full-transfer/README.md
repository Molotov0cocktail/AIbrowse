# 物理三库与 full50 组合资格工具

本工具把三份已经通过 Node 首门的物理数据库与既有 full50 会话组合到一个新的
`physical-full-transfer-<UUID>` scope。它复用旧 FullTransfer 的协调器、计数器、IO 和生产
`transfer-worker`，仅在 esbuild 中把旧工具对 `./contract`、`./input` 的 13 个固定 importer
映射到本目录实现。构建证明记录每条映射、完整 bundle 输入、源码与制品摘要，并拒绝旧新输入模块混用。

固定来源：

- full50：`full-conversations-29d6709186ef4d179628e94ec8c73663`，51 个成员，树摘要
  `cced3aa17d685cc1b119f060e3caf9928f49640195599debf9ab51f007546989`；
- Sources：`physical-sources512-2aed3c7406694689baa106edd05d79d1/fixtures/sources.db`，512 MiB；
- Research：`physical-capacity-728ac71ab99a41babadd33c7fcc50045/fixtures/research.db`，64 MiB；
- Watch：`physical-watch512-4d1f0347a0924c268f1441f62aeb21e8/fixtures/watch.db`，512 MiB。

构建只读四份小 `fixture-proof.json`，不读取大数据库或会话正文，也不启动 Job：

```powershell
npx tsx tools/data-qualification/physical-full-transfer/build.ts --build-only
```

独立审核通过后，主协调者才按构建返回的同一个 scope 运行唯一 campaign 入口：

```powershell
pwsh -NoProfile -File tools/data-qualification/physical-full-transfer/run.ps1 -ScopeId <scope> -Mode campaign
```

入口在任何 helper、proof 和制品预检前以 `CreateNew` 创建并关闭唯一 `campaign-intent.json`；并发或任一
后继失败都使整个 scope 不可重用。它在同一 PowerShell 调用栈顺序执行 import 和 transfer。import 完成最终
身份复核、环境恢复、全部句柄关闭及 120 秒绝对期限复核后，返回带 input-proof 摘要的内存结果；调用方立即在
同一截止内重新读取并比对该摘要，才启动 transfer。transfer 不读取磁盘 import 成功回执。

阶段和 wrapper 的磁盘结果都标记为 `authorization=pending-wrapper-exit`；wrapper 磁盘结果还固定
`requiresWrapperExit=true`，不能独立授权成功。整轮只有最后 stdout 的
`authorization=stdout-and-wrapper-exit-0` 成功对象与该 wrapper 的实际 exit 0 共同构成资格证据。成功的
transfer 和最终 stdout 将 `electronQualified=true`，import 与 build-only 保持 false；所有结果的
`productE2Pass` 都保持 false。import 沿 120 秒工作门和 30 秒退出收口；transfer 沿 3060 秒
整轮、每个产品操作原 1500 秒分段门和 30 秒退出收口。成功 stdout 在序列化前后及写出后继续检查同一
transfer 期限；写出跨期会使 wrapper 非零退出，因此不能与该 stdout 共同授证。固定 Job 保持 import1、transfer24、
单进程 commit 2 GiB、树 commit 4 GiB、单 RSS 1 GiB、树 RSS 2 GiB及 100 ms 采样。

transfer 成功仍须证明生产 scanner 的 `5000/30/200/2800/8400/1030` 计数、完整会话树、发布容器
不超过 5 GiB、backup 与 restore staging 的三库分别为 512/64/512 MiB，并通过同一持有句柄核验
实际 allocation 不小于长度且文件没有 sparse/compressed 属性。此资格不覆盖 UI、DatasetSwitch、
服务图冷启动或 E2 整体通过。

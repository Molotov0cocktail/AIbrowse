# E2 超限文件读前拒绝工具

正式合同见 `doc/stage7/tasks.md` 的“E2 超限文件读前拒绝差量”。本工具只为四个实际超限一字节的稀疏敌手输入提供一次性实际入口；它不生成合法最大数据库，也不授容量、ENOSPC、完整恢复或 E2 整体通过。

## 固定边界

- 四个输入固定为容器 `5GiB+1`、Sources `512MiB+1`、Research `64MiB+1`、Watch `512MiB+1`。原生 helper 以 `CreateNew` 创建，先执行并回读 `FSCTL_SET_SPARSE`，再写最多 4KiB 头部和设置 EOF；不取消稀疏属性。
- 每份实际分配必须不超过 1MiB，scope 全部文件的实际分配必须不超过 16MiB，执行前后都保留 1GiB 可用空间。任一文件系统能力、身份、父链、闭合集或预算失败都会保留现场并停止。
- worker 先用一个有界合法容器和三个小 SQLite 控制证明真实入口可达，再调用生产 `inspectNativeRestoreInput` 与 `openPrivateStagingDatabase`。超限拒绝只声明实际拒绝、固定头部和文件身份保持、无 sidecar；零正文读取只由既有生产纯测试的调用顺序反例证明。
- 固定 Node 24.18.0、共享 `FixedTransferJob.cs` 的已审 SHA256、import 单进程、commit 2GiB、采样 RSS 1GiB。120 秒从 wrapper 启动起包含绑定、原生编译、构造、worker 和收口；30 秒仅供共享监督器在失败后确认精确退出。
- `preflight-intent.json` 在读取构建证明前通过 `CreateNew` 形成一次性 claim，同时拒绝已有回执和未知成员。失败 scope 不删除、不复用。PowerShell 入口仅接受声明参数，不读取 `$args`。
- 构建闭包固定为十个工具文件、共享监督器、两个 package 文件及八个实际 esbuild 输入的并集，共十九个来源。wrapper 拒绝重复 JSON 字段、缺项和额外项；两个 C# 复制制品必须与源字节相同，worker 输入与制品摘要必须同属构建证明。
- 构建时读取当前小写 40 位 Git commit 写入 `sourceCommit`；wrapper 运行时重新读取 HEAD 并要求与 proof 一致。commit 不代替来源字节绑定，十九项来源仍逐项持有并核对 SHA256；不再把历史接管锚点当作永久可执行提交。
- build-only 允许当前工作区存在已绑定的修改；`sourceCommit` 仅记录构建期间头指针并在写 proof 前复验未变，不声称工作区洁净或发行候选资格。真实字节由 `sources` 逐项摘要证明；含旧 `baseline` 的历史 proof 不得复用。
- 稀疏输入使用专属持有句柄 metadata 检查；创建身份、路径身份、持有身份、属性、时间、链接数、EOF、实际分配及最多 64 字节头部均复核。普通源码和制品继续使用共享 helper 的非稀疏红线。

## 当前允许的验证

实际四个大 EOF 和 Job 必须等待新独立审核。审核前只运行小夹具、原生小 EOF 测试和 build-only：

```powershell
npx vitest run tools/data-qualification/oversize-preflight --maxWorkers=1
pwsh -NoProfile -File tools/data-qualification/oversize-preflight/native.test.ps1
node --experimental-strip-types tools/data-qualification/oversize-preflight/build.ts
```

build 命令只创建一个 `oversize-preflight-UUID` scope，写入小型绑定制品和 `build-proof.json`；不会创建四个超限文件，也不会启动 Job。独审通过后，主协调者才可对选定且未 claim 的 scope 串行执行一次：

`native.test.ps1` 保留小夹具与真实安全失败入口原件。它还执行完整 wrapper 的有界变体：仅把四个 EOF 改为 `1MiB+1`，并在 `Execute` 前强制停止；该控制只证明启动、绑定、原生联用和预算接线，不授实际四个大 EOF、Job 或产品通过。

```powershell
pwsh -NoProfile -File tools/data-qualification/oversize-preflight/run.ps1 -ScopeId oversize-preflight-<32位小写十六进制>
```

`complete.json` 与 `preflight-result.json` 都保留 `productE2Pass=false`、`capacityQualified=false`、`enospcQualified=false`，不得把同一错误文本解释为内部零读取。持久化的 wrapper 回执固定为 `pending-wrapper-exit`；只有最终 stdout 的 `completed=true` 与 wrapper exit 0 共同证明回执自身、最终闭合集、分配预算、身份和期限均已复核。

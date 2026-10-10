# 固定 Sources512 Node 构造资格

实现合同见 `doc/stage7/tasks.md` 的 E2 物理上限夹具差量。此工具只操作既有合成 Sources 的新副本。
独审通过后由主协调者串行执行一次；首失败保留 scope、intent、数据库及日志，禁止重用 scope 或无诊断重跑。

## 固定对象与门

- 输入为同一 runtime 的 `sources/sources.db`，151,023,616B；路径、SHA256 和 fixture-proof
  由 `contract.ts` 引用既有 full-transfer 编译期合同，不接受外部路径、SQL、容量、域或重试参数。
- 新根为 `physical-sources512-UUID`；仅复制、SQLite scratch 扩页至 536,870,912B，再用 SQLite backup
  生成独立同容量副本。两份逐一读回 schema、user_version、Sources 5000 条、所有六张业务表的稳定摘要、
  完整性、FK、page_size/page_count/freelist。摘要包含 Sources rowid 和完整 journal 标识；不输出业务正文。
- 复用 `physical-capacity/padding.ts`、`backup.ts`、`journal.ts`、`allocation.cs` 及 `full-transfer/io.ts`。
  原64MiB工具及其原件保持。FTS的生产扫描结果仍标注 rebuild-required，本工具不冒充产品导入时的重建资格。
- 固定 Node 24.18.0 及 SHA256；构建绑定全部本目录文件、打包依赖、原生源码与三件制品。
  运行复核必要来源，包括入口自身，持有来源/Node/制品/小证明锁，并绑定目录和文件身份。
- 工作120秒包含原生编译、绑定、生成、读回和结果收口；原30秒只用于失败后的精确root与Job退出确认。
  原生 import 模式保持单进程、单进程/Job commit 2GiB、采样RSS1GiB、100ms采样、old-space768MiB。
- Node和原生各自核空间：两个512MiB、独立J=128MiB、16MiB工具额逐文件按分配单元取整，另留1GiB。
  普通文件经持有句柄的原生事实核验，拒绝链接、压缩和sparse；独立读取实际分配字节，不能只靠逻辑长度。
- backup只允许目标固定-journal，首次观察超过J即停止；离散maxObserved、观测次数和finalAbsent如实报告，
  continuousPeakVerified恒false，不从小观测推导连续峰值或磁盘预约。
- MEMORY事务在512MiB的实际RSS仍未知；失败时保留再定位，不放宽原门。

## 执行

先核共享 `FixedTransferJob.cs` 已冻结且新的独审覆盖其 import 适用范围，再只构建：

```powershell
node --experimental-strip-types tools/data-qualification/physical-sources512/build.ts
```

该入口只写新scope的 `generate.cjs`、原生源码副本和build-proof，不读大型输入，不启动Job。
新工具独审PASS并核精确scope后，由主协调者运行：

```powershell
pwsh -NoProfile -File tools/data-qualification/physical-sources512/run.ps1 -ScopeId physical-sources512-<构建返回的32位ID>
```

小输入验证（单个数据库≤1MiB、不调用实际Job或大文件入口）：

```powershell
npx vitest run tools/data-qualification/physical-sources512 --maxWorkers=1
pwsh -NoProfile -File tools/data-qualification/physical-sources512/native.test.ps1
```

结果只授 Sources512 Node 构造/backup可行性。Watch512、Electron产品worker、三库组合及full50仍须独立合同和实际验收。

## 相对 Research64 包装的差量

`run.ps1` 复用既有18KiB包装结构，C#监督状态机只引用同一源码，不复制。
仅替换scope前缀、kind、两个数据库成员、目标长度/空间公式、当前allocation源码路径、
必需来源清单及允许的新目录。Job模式、期限、环境清理、来源/制品/Node锁、文件与目录身份、
proof/intent排他、journal判定、输出原生分配检查及终态收口不变。
Node层新增 Sources 专属纯读回，以逐行稳定摘要证明业务内容保持，实际入口固定5000条。

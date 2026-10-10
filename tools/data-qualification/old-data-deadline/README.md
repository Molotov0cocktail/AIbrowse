# 旧集合 120 秒期限资格

本工具只证明 `DatasetSwitch` 文件协议的旧集合 O 期限：正常控制可提交；inventory 与 backing-up
分别在旧 Sources 257B 读取进度和首个真实 flush 后等待一次 120250ms，并由新 worker 重开检查
旧身份/字节、work、失败副本和已扣为 0 的 rollbackCopy 额度。

它不证明 SQLite 业务一致性、ENOSPC、R/P 恢复或 E2 整体通过。十三成员均为文件哨兵，不是合法业务库。

构建入口不接受参数，每次自行生成新的 `old-data-deadline-<32hex>` scope，已有 scope 不复用：

```powershell
node --experimental-strip-types tools/data-qualification/old-data-deadline/build-only.ts
```

构建和独立审核通过后，才可从新的 PowerShell 运行真实长时入口；入口只接受该次构建产生的严格 `ScopeId`：

```powershell
pwsh -NoProfile -File tools/data-qualification/old-data-deadline/run.ps1 -ScopeId old-data-deadline-<32hex>
```

真实入口顺序执行正常、inventory、backing-up，并复用冻结的 `FixedTransferJob` transfer 模式。
入口在首次资源创建前以 `CreateNew` 持久化一次性 claim；即使预检或运行失败，该 scope 也不能复用。
本目录的单元测试只使用短额度或受控时钟，不能替代真实 120250ms 等待与 Job 证据。

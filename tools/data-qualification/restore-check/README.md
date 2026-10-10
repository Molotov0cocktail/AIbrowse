# 固定分层恢复检查

本工具构建独立 `app/out`，复用普通非冒烟产品 main/preload/renderer、真实 worker 与 lifecycle guardian。
bootstrap 只隔离合成 userData/sessionData、提供固定原生 dialog 响应及点击本构建主文档中的固定 DOM 按钮。
没有生产测试 IPC、运行时产品环境开关、业务 SQL 适配、伪造 worker 或 guardian。普通和发行构建不包含本目录入口。

R 使用小 A 的真实 UI 备份，正常退出后安装 B，覆盖 Open 取消、确认取消与批准恢复、真实 guardian 继任、四域 UI 读取及普通冷启动。
P 从坏 Conversation index 启动，经 partial 确认取消/批准、持久 gate、H 恢复和两次继任完成同样检查。
H 由生产离线管线生成，标为合成输入；恢复后的危险历史规范化由既有独立逐表 oracle 判断。

每场总期限600秒，原生 FixedTransferJob 保持 Job24、单进程/树 commit2/4GiB、采样 RSS1/2GiB及100ms节拍。
每个 Job 异常收口至多30秒。UI单步30秒及产品原阶段期限保持。外层只启动固定段；恢复后继由产品 guardian 创建。
Job0和首个root0不足以通过：还必须取得所有固定阶段回执、四域内容、原回退副本、退休账本和冷启动后逐表复算。
真实 guardian 的 writer 退出/释放顺序复用既有原生与中断证据；本工具的后继PID/账本世代为组合观察，不声称逐个持有后继Windows退出句柄。

```powershell
node --experimental-strip-types tools/data-qualification/restore-check/build.ts
pwsh -NoProfile -File tools/data-qualification/restore-check/run.ps1 -ScopeId restore-check-<构建ID> -Scene R -Feasibility
```

每个scope只能运行一次。短可行性仅覆盖启动、固定DOM可见、普通关闭、Job及writer退休，不授备份恢复通过。
正式R/P使用新构建scope，移除`-Feasibility`并分别指定`-Scene R`或`-Scene P`。所有真实运行串行、首失败停止。
修改源码必须重新构建；构建记录绑定全部src、实际工具/模块输入及全部产物，运行期间只读持有绑定文件。
失败数据、旧scope和原始证据保持，不自动清理、不接管真实用户profile。

离线 SQLite 只打开完整复制后的受控副本，原业务目录仍要求无 sidecar，并在 Job0、writer账本退休后复制。
正常启动与维护 drain 各写一条完整 reconciliation 审计；健康继任不重做协调。
R 的 A 备份/恢复保留完整两条审计，普通冷启动后为三条；B 回退原件为两条。
合成 H 的容器/恢复审计为零条，普通冷启动为一条。每条审计严格验证字段、身份、时间和完整继承；
其它全部逐表业务数据及 H 历史规范化继续使用原冻结 oracle。

这些证据覆盖完整业务恢复接线，不授发行包原生Save/Open/确认交互、发行安全边界或独立Windows安装通过。
最终候选仍需普通发行包原生交互补证以及独立持久化/隐私审核。

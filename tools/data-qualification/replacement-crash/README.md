# replacement-crash 资格工具

该工具为 E2 新增的持久边界中断资格生成固定 worker。它先运行一次正常控制，枚举并核对恰好 18 个边界；随后每个边界各运行一次真实子进程终止，并用新的 Node 进程调用实际 `DatasetStartup.prepare` 重开。总共 19 个场景。主协调者只能在新的独立持久化/并发审核通过后串行执行实际矩阵。

固定边界包括 12 个生产 `DatasetReplacement` / gate 边界，以及只对 `src/main/storage/dataset-active.ts` 构建副本插入的 6 个边界。插桩器要求每个固定 I/O 锚点恰好出现一次，剥离后必须与绑定原文逐字相等；它不改变仓库生产源码、I/O 调用、判断或 release 路径。`DatasetSwitch` 的既有边界会被过滤，不暂停也不重跑旧 330 点矩阵。

先冻结runner及全部构建输入，再交独立审核；构建入口只生成制品，不启动矩阵。输出目录必须尚不存在：

```powershell
node --experimental-strip-types tools/data-qualification/replacement-crash/build-runner.ts log/stage7-e2/replacement-crash-implementation-001/runner-build
```

审核通过后运行冻结的 `runner-build/replacement-crash-runner.mjs`，该运行入口不接受参数。
`run.ts` 依赖生产TypeScript模块，必须由上述构建入口打包，不能直接交给Node strip-types执行。

运行器只在 `log/stage7-e2/replacement-crash-<uuid>` 创建新受控根。它记录 Node/esbuild 版本、Node 可执行文件、完整 bundle 输入清单及字节 hash、worker artifact 的身份和 hash；每次启动 child 前重新核对这些绑定，并拒绝重解析点、硬链接、身份或字节变化。每个 child 的工作期限为 8 秒，终止后最多 2 秒等待实际 exit 及 stdio 收口；启动时先从 600 秒总期限中保留完整退出窗口。IPC 每帧不超过 512 B、每 child 不超过 128 帧，stdout/stderr 合计不超过 4 KiB。19 场和重开共用 600 秒，实际分配上限为 64 MiB；每次 write/reopen 前还分别预留 4 MiB/1 MiB，首个失败立即停止并保留原件。

fixture 使用三个真实 SQLite marker 表、old/new 会话哨兵、两个 opaque 旧 active（其中一个是非法 JSON）和旁支 canary。oracle 要求旧三库与旧会话在 live/rollback/retired 中至少保留一份，存在的旧副本逐字一致；允许正常回退复制暂时形成两份。两个 opaque active 原件各恰好一份，新目标仍存在。普通准入只接受完整新代；不完整 gate 或 active 只允许 `recovery-required`。`checking` 状态通过三个实际只读健康句柄查询 new marker，并核新会话后才调用 `complete`。

监督器在 spawn 前冻结单调工作截止及最晚退出截止，spawn、消息和输出处理所用时间都计入原期限。timer 只负责唤醒；迟到的timer不会从回调时刻重新获得退出窗口。每次消息、输出、exit、close和timer都核对同一个截止；总600秒也传入子监督器夹住剩余时间。

kill返回false或抛错会保留失败，并继续等待精确child的exit与close。中断通过要求本次kill成功、目标边界匹配及SIGKILL退出证据。正常完成与强杀都必须取得ChildProcess close（该事件在exit及stdio关闭后发出），exit后的尾部输出仍计入4KiB。正常排水沿原工作截止，强杀排水沿原退出截止；未确认退出或输出关闭均保留对应所有权失败。

这些 marker 只证明文件协议与闭合的合成健康 oracle，不是正式 Repository schema，也不证明完整服务图、物理断电、空间耗尽或完整产品恢复。

# E2 固定 R/P 恢复 campaign

正式契约为 `doc/stage7/tasks.md` 的恢复场景、身份与原生确认差量。本目录只提供资格工具，
不增加产品参数、IPC、SQL 或远程权限。工具测试和构建不能授 R/P 实际通过。

## 固定编排与边界

- R：小 A → 健康产品 UI backup → 精确 main/guardian 退出与账本退休 → 同根保留四域 A、装 B →
  Open 取消、确认取消 → arm 后批准 → 唯一守护后继 → 四域 UI → 正常关闭 → A 与 rollback B oracle →
  无额外参数普通冷启 → 四域 UI → 正常关闭、完整语义摘要不变。
- P：合法 A 三库与坏会话 index → partial 确认取消/批准 → gate、退休及零 Store 恢复入口 →
  Open 取消、H 确认取消/批准 → 健康后继 → 四域 UI、H 历史规范化及坏 index 回退原件 →
  普通冷启 → 四域 UI 与完全相同的恢复后业务摘要。
- H 由绑定的生产 Node backup pipeline 生成，原件标记“受控合成生产管线备份”；不称为产品 UI backup。
- 固定 R 28/P 29 次 UI 与确认调用，均小于 32。R 总 4410 秒、P 总 2990 秒，UI 每次 30 秒，
  helper 35 秒只用于收口；普通关闭整个 hold/ready/Close/退休共 30 秒，boot 60 秒。
  产品每个 backup/restore 仍保持 1500 秒及其内部阶段门；partial 排空 20 秒仍由绑定产品实现监督。
  身份后继首次 UI 取 UI30、后继原 boot60 和场景余额的较小值。
- 装配、读回与绑定累计 180 秒，包含外层准入已耗时。每个 offline 进程仍由 runner 持有真实
  exit/close；超时终止后保留原 child 和 Promise 所有权，外层 native Job 最终收口。
  Node 管线的 SQLite 同步调用不声称可在进程内中断。

`campaign.ts` 使用固定端口便于甄别控制流反例；实际 `run.ts` 只接真实 UI helper、
已审 successor observer、普通退休 helper、生产小管线和只读固定 oracle。没有成功 stub。
`ui.ps1`、原生文件选择、普通退休及 wrapper 各自的资格缺口不能由端口测试补授。

## 构建与外层入口

使用 Node 24.18.0；build 仅装配受控工具与闭合来源，不接触真实 profile 或启动产品：

```powershell
node --experimental-transform-types tools/data-qualification/product-restore-campaign/build.ts <packageRoot> <纯JSON静态绑定原件> --build-only
```

新 scope 为 `log/stage7-e2/restore-campaign-<32hex>/`；两份 CJS bundle、Vite/Rollup 读取输入集合、
实际 rendered 运行模块、工具目录/共享 C#/PS、完整产品静态绑定 modules、Node、EXE/ASAR/guardian
摘要进入 `build-proof.json`。使用发行 define 与 moduleSideEffects 语义；被树摇移除的资格源码仍作为
固定构建输入逐一绑定。运行图只允许已绑定输入的子集，拒绝 qualification、node_modules、Electron
与非 Node 内建外部依赖。构建工具由 package-lock 精确固定；不把读取过的输入声称为运行模块。
来源集合等于固定目录与共享名单加产品 modules，删除 source 与 inputs 两处也不能隐藏来源。
外层必须用独立审核冻结的 proof SHA 准入，不能相信 scope 自声明的 proof。

实际固定 argv（只能由已审 disposable wrapper 调用）：

```text
node <scope>/run.cjs R|P <scope> <packageRoot> <journal>/runner-output <appData> <journal> <preflightElapsedMs>
```

最后一项是外层原单调时钟累计准入毫秒，整数 `[0,180000)`；同时扣场景总额和工具 180 秒。
启动后只接受外层 flush/close 后原子发布的 `restore-start.json`，复核 runId、scene、proof SHA
与不倒退的预检耗时，再保守加整个 Node uptime 扣两本余额；缺失、畸形或迟到停止。
外层仍持有自己的原截止时间，不因 runner 启动重新发放。每个 scope 的 R/P 各以 CreateNew
消费独立 claim；任何失败不覆盖或自动重试。所有失败 profile、claim、raw stderr 和原件保留。

## 成功判据

报告位于固定 `runner-output/restore-campaign/report.json`。`ok=true` 必须同时结合实际 runner exit0、
外层 Job0、未结算 Promise/child/observer/ordinary lease 全零和固定原件。最后原件 flush/close
仍计原工具与场景余额；磁盘残留 `ok=true` 不覆盖最终进程失败。

恢复源 A/B/H 每套 942553 字节的已审 oracle复用。安装 B 前必须已取得原生退休证明；
离线入口另核 ledger null/null。只移动明确四域到同实体根内固定保留目录，不移动整个 profile，
不删除任何输入。业务 oracle不在活 writer 上运行，P 恢复入口只读取固定 gate 和坏 index。
“零 Store”采用固定恢复 UI、gate 与绑定的产品装配路径联合证明，不能单据窗口文字声称。

关闭后 fixed oracle 约束整套业务列/行、跨库关系和会话集合；R 回退区必须精确四域且 B oracle通过。
每次退休后仍在同一 close30 余额内核固定原生 Job 样本，main、guardian、Chromium、utility 必须全部为零，
只允许剩余工具；R 三次、P 两次。该门失败不能读取 oracle、安装 B 或普通冷启。
P保留旧坏 index；H断言 interrupted/uncertain、paused、通知 failed/attempts0、旧 claim/cursor/slot
不变与 Session consent清空。二次普通冷启动的全部业务表摘要必须与首次恢复后完全相等。

## 聚焦验证

```powershell
npx vitest run tools/data-qualification/product-restore-campaign --maxWorkers=1
npx tsc --noEmit --project tsconfig.node.json
npx eslint tools/data-qualification/product-restore-campaign/*.ts
```

测试使用隔离小合成目录，不打开产品/Job/UI。机器原件放
`log/stage7-e2/restore-campaign-implementation-001/`，失败场景与源哈希均保留；本 README 不复制当前状态。

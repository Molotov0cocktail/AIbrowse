# D5 — Scheduler、运行协调、补跑、退避与资源控制

## 目标

实现应用进程内 WatchScheduler/WatchRunCoordinator：interval/daily、DST、missed run 合并一次、同 Rule
互斥、全局/主机并发、退避/jitter/Retry-After、手动 run 和幂等 shutdown。

## 范围与非目标

- **做**：到期队列、单 tick20、global4/host1、90秒总超时、一次内重试、状态/进度；启动/恢复/catch-up；
  Source revalidation；before-quit drain。
- **不做**：后台服务/托盘/Windows Task Scheduler；不实现 Feed/Page 业务（用窄 fake port）；Scheduler 不持有能力。

## 涉及模块和输入文档

- `src/main/watch/watch-scheduler.ts`、`watch-run-coordinator.ts`、service 生命周期最小装配及测试。
- 输入：detailed §4/§7/§14；threat-model WT-18/WT-22、WRT-05/WRT-16。

## 预计修改文件

- 新增 scheduler/coordinator 模块与测试；`src/main/index.ts` 只允许生命周期装配，默认无 Rule 零行为。
- D3/D6 acquisition 通过窄接口注入；本任务不改其实现。

## 实施步骤（红→绿）

1. 红：FakeClock 下 interval/daily/DST/回拨/离线万次 missed/手动并发/host 队列/退出测试。
2. 绿：纯 schedule calculator → due queue → coordinator slot → retry/backoff → lifecycle drain。
3. 检查 Scheduler 对象图不含 Browser/DB/HTTP/Provider/Notification；只提交 ruleId。
4. dev/production 生命周期冒烟：关窗停止、重启一次 catch-up、零 timer/request 残留。

## 验收标准与测试

- 同 Rule 永不并发；手动 run 复用 current run，不改变 nextDueAt。
- missed 任意数量最多一次 catch-up；429/失败矩阵、jitter 与三次 degraded 精确。
- stop-admission→abort→drain→close 顺序可重复；运行前 Source 失效零 acquisition。
- 全量 test/typecheck/lint/format/build/diff-check + 对应 Electron 冒烟全绿。

## 完成定义

红→绿、对象图/资源证据、Reviewer PASS、候选提交；不承诺退出应用后运行。

## 依赖与停止条件

- 依赖 D1/D2/D4；D7/D10 依赖本任务。
- 需要后台身份、cron、动态资源上限、Scheduler 直接能力或无法有界 drain 时停止 REPLAN。

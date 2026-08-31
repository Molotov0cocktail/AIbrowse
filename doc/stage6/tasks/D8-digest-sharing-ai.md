# D8 — Digest、shareMode 投影、可选 AI 解释与确定性降级

## 目标

实现每日 DigestSchedule/固定成员、observation journal 正式 cursor、可恢复 cycle/batch、程序
DigestFacts/EvidenceMap、full/metadata/blocked prompt 前投影，以及持久化 claim 证明的每 artifact 最多一次
可选 Provider 解释；任何模型/Key/预算/崩溃失败都保留确定性 Digest，Event 删除/过期后零失证 Evidence/断言残留。

## D8 REPLAN 已冻结决策（2026-08-31）

以下八项是 detailed-design #S6-059～#S6-066 的任务级速查，Executor 不得重新选择：

1. **正式 cursor**：只用 observation 写事务内单调 `changeSequence`；Event 的 first/lastObservedAt、createdAt 或
   rowid 均无 cursor 权力。Event 新建/合并与 journal 同事务，replay 零 journal；late coalesce 必有更大 sequence。
2. **cycle/batch 恢复**：daily reservation 原子冻结 lower/upper/next sequence、期间/runStats 并消费 logicalDate；
   artifact+refs+schedule/run cursor 单事务。启动沿原 frozen upper/next 恢复，不重新选 Event。
3. **Event slice**：artifact 只聚合其 sequence 上界内 observation；Evidence/kind/time/count 不读取随后增长的
   Event 聚合值。greedy batch 同时受 unique Event≤50 与 canonical facts≤49,152 bytes。
4. **Provider at-most-once**：deterministic artifact 先提交；实际请求前 CAS `pending→claimed` 并提交，随后最多
   一次 stream。claimed 永不回 pending；崩溃恢复 uncertain、explanation=null、零重试。
5. **预算/canonical**：facts 49,152 bytes、explanation 12,288 bytes、整个 artifact 65,536 bytes、完整
   ProviderRequest 65,536 bytes、原始输出 16,384 bytes；section 字符/字节预算见 detailed §2。草案必须 exact-key、
   exact-order canonical JSON；duplicate/extra/code fence/错序/不可见引用/任一超限整份拒绝。
6. **runStats**：changed=changed-unmatched/event-created/event-coalesced；unchanged=unchanged/
   baseline-established/event-deduplicated；failed=failed/aborted/interrupted；按 cycle 期间内 finishedAt 冻结。
7. **调度所有权**：D8 新增零能力 DigestScheduler 并在 main 生命周期接线，不改变 WatchScheduler ruleId 契约；
   D8 零 notification/outbox，D9 只消费已验证 artifact。
8. **原子 scrub/v4**：Event expire/user-delete/Source cascade 必须同事务 scrub facts Evidence、涉及 Event 的整段
   explanation、ref/journal 状态并重算 hash/revision/bytes；迟到 Provider 写回以 factsRevision/hash CAS 拒绝。
   v3 三个宽松 Digest 占位表必须全空才允许 v4 重建；非空 fail-closed。

## 范围与非目标

- **做**：daily IANA/DST Schedule、Group/显式成员创建时冻结、v4 journal/schedule/run/artifact schema、正式
  cycle reservation 与恢复、无事件状态、50 Event/64 KiB 分批、runStats、deterministic renderer、sharing
  projector、prompt、Provider claim、Explanation validator、Event scrub、D8 main 生命周期/聚焦冒烟。
- **不做**：renderer、preload、IPC、通知/outbox 展示、导出；不使用 ResearchRuntime/research.db；不改变
  BrowserController/AgentLoop/ToolRegistry/Provider Key 通道；不新增模型工具、网络能力、任意 HTTP、SDK 或依赖；
  不把 Source note、prompt、完整 response、思维过程、Key、正文/PageSnapshot 落盘。

## 涉及模块和输入文档

- 输入：detailed §2/§4.1/§4.4/§9.4/§10.1/§10.2/§10.4/§11/§13.2/§14/§15、
  #S6-059～#S6-066；threat-model WT-15/WT-16/WT-20/WT-22、WRT-13/WRT-14/WRT-18；既有
  LLMProvider/FakeProvider 与 SourceService sharing 安全边界。
- main：DigestScheduler/DigestService/DigestPrompt/SourceService 窄 adapter、Watch Repository/migration/store/
  row validation/index 生命周期。
- shared：Digest facts builder、sharing projector、facts/explanation canonical validator 与 watch types/constants。

## 预计修改文件

- 新增：
  - `src/main/watch/digest-scheduler.ts` + test；
  - `src/main/watch/digest-service.ts` + test；
  - `src/main/watch/digest-prompt.ts` + test；
  - `src/shared/watch/digest-facts.ts` + test；
  - `src/shared/watch/digest-sharing-projector.ts` + test；
  - `src/shared/watch/digest-validator.ts` + test；
  - D8 聚焦 main smoke（文件名按现有 smoke-watch-* 约定）。
- 修改：
  - `src/shared/types/watch.ts`；
  - `src/main/watch/repository/watch-repository.ts` 及 tests；
  - `src/main/watch/db/watch-migrations.ts` 及 migration/store tests；
  - `src/main/watch/watch-row-validation.ts` 及 test；
  - `src/main/watch/watch-store.ts`（v4 probe/recovery/journal cleanup）；
  - D7 Event 新建/合并/expire/delete 的 Repository 事务测试（只为 journal/scrub 原子接线）；
  - `src/main/index.ts` 与 `src/main/smoke.ts`（只做 D8 lifecycle/smoke 装配）。
- 不改 renderer/preload/IPC、Notification/Export、Research/Browser/Agent、package.json/lockfile。实际需要越过上述
  模块或改变公共 Provider/SourceService/BrowserController 契约时停止 REPLAN。

## 实施步骤（红→绿）

1. **M0 红态**：先建立能甄别 v3/占位类型的 journal cursor、late coalesce、cycle/batch/claim/scrub 与严格
   canonical schema 测试；不得用“文件不存在/类型不通过”作为唯一红态。
2. **M1 纯函数**：facts builder/Event slice/canonical serializer → sharing projector → prompt → Explanation validator；
   完成固定向量、字符/UTF-8 字节边界和 forbidden canary。
3. **M2 schema v4**：三空表 guard、journal 全序回填/high-water、严格 schedules/runs/digests/refs、所有索引/CHECK/
   runtime validator；逐语句失败 v3 逐列恒等。
4. **M3 Event journal/scrub**：D7 新建/合并同事务 journal、dedup 零 journal；expire/user-delete/source cascade
   对 journal/ref/facts/explanation/Event 的逐写点故障注入与 factsRevision/hash CAS。
5. **M4 schedule/cycle**：成员 resolver 一次冻结、daily/DST、创建 high-water cursor、reservation、无 Event、
   frozen upper、deterministic greedy batch、artifact/ref/cursor 原子提交、running recovery、journal 水位清理。
6. **M5 Provider**：AI default-off；pending claim 持久化后一次调用；Key/blocked/request budget/timeout/abort/error/
   hostile output/facts race 全部 explanation=null；原始 prompt/response 零落盘。
7. **M6 装配**：DigestScheduler/index before-quit/startup resume、聚焦 dev+production smoke；D8 仍零通知/IPC。
8. 全量门控、隐私扫描、`baseline..HEAD` 自审，创建有界 local candidate commit(s)，不得 push。

## 验收标准与测试

- **cursor/恢复**：同时间 observation 全序；先消费 Event 再 late coalesce 下一 cycle 可见；Clock 回拨不漏；
  51/120 Event 在每个 reservation/artifact/ref/cursor 边界崩溃重启均无漏/重/越过未提交 sequence；freeze 后新
  observation 只进下 cycle；同 Event slice 不夹入 upper 后 Evidence。
- **schedule/stats**：IANA 非法拒绝、DST gap/fold、系统时区变化、logicalDate 去重、Group 后续变化零扩员；
  新建 cursor=high-water；正式无 Event 只更新 lastChecked/period/stats/cursor，零 artifact/ref/provider/outbox；
  全部 RunOutcome 映射与 finishedAt 半开闭期间精确。
- **预算/canonical**：49/50/51/100/101/120 Event；facts 49,152、artifact 65,536、request 65,536、output
  16,384、section 字符/字节 `==` 接受/`+1` 拒绝；single observation 装不入时 fail-closed 零 cursor；同输入/
  Clock/Provider 失败条件下 deterministic artifact 逐字节相同。
- **sharing/模型**：full 只含有界 metadata+Evidence；metadata request 零 excerpt/old/new/hash/documentId；blocked/
  missing request 零名称/URL/Event/计数/时间/Evidence；Source note/Key/body canary 零命中。请求无 tools 字段。
  unknown/duplicate/invisible/blocked eventId、extra/duplicate keys、错序、code fence、非 canonical whitespace/
  escape、控制/bidi、超限草案整份 null。
- **Provider 调用矩阵**：每 artifact pending→claimed 后最多一次；claim 前/后、发送前/流中/响应后每个崩溃点；
  claimed 恢复 uncertain 零重试；missing Key/全 blocked/request 超限零调用；facts scrub 后迟到成功零 explanation。
  preview 每个请求最多一次且零正式状态副作用。
- **scrub/v4**：expire/user-delete/source cascade 后 facts_json/explanation_json/ref/journal/DTO/request/log 的 Evidence
  canary 零命中；涉及 Event 的混合 section 整段删除；每个失败点整体回滚。v3 非空占位表拒绝；空表迁移、journal
  回填/连续 sequence、逐句失败回滚、future/corrupt/canonical/hash/bytes/provider 状态扫描全绿。
- 聚焦红→绿后运行 `npm test -- --maxWorkers=1`、typecheck、lint、format:check、build、`git diff --check`；
  dev+production D8 smoke；DB/ProviderRequest/日志/DTO/ConversationStore/sources.db/research.db 隐私扫描；临时 DB/
  userData/Electron 进程精确清理。真实 Provider 只在仓库外凭据可用且 AI 显式开启时按长期授权最小调用，否则
  准确记录“凭据不可用/NOT RUN”，不得用 FakeProvider 冒充。

## 完成定义

新的实现 baseline、红→绿命令/退出码、v4 migration/回滚矩阵、cursor/batch/claim/scrub 机器证据、Provider 调用
台账或 NOT RUN、full/metadata/blocked/Source note/Evidence/Key 字节扫描、全量/构建/冒烟、范围/敏感/垃圾终检、
local logical candidate commit(s)（未 push）。本任务涉及迁移/持久化/隐私，必须由新的独立 Sol Reviewer 审核
`baseline..HEAD` 并给 `PASS`；PASS 前不更新 progress 为完成、不 push。

## 依赖与停止条件

- 依赖 D4/D7（均已关闭）；D9/D10 依赖本任务。
- 无法证明 late coalesce 可见、需要用 wall clock/可变 Event row 作 cursor、需要进程内状态替代跨重启 cycle/
  claim、需要 Provider claimed 后重试、需要保留已失证 Evidence/解释、单 observation 在正式 D7 预算内仍装不入
  既定 facts 预算、需要改变预算数值/公共接口/迁移既有 statement bytes、需要提前实现 D9 renderer/IPC/通知，
  或出现两个长期影响显著不同的 cursor/schema/scheduler 方案时立即停止 REPLAN。

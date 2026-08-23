# D7 — 确定性 Diff、Baseline、Event/Evidence、health 与去重

## 目标

把 Feed/Page Projection 通过来源专属确定性 Diff、Condition 和 EventValidator 转为不可变 Event，确保每个
变化拥有可解释 old/new Evidence；实现 Baseline CAS、健康闭环、幂等/合并/反转和通知 outbox 原子写。

## 范围与非目标

- **做**：FeedDiff/PageDiff、ChangeSet、EvidencePair、Condition 接线、Baseline first/rebaseline、Event/Run health、
  fingerprint/idempotency、30分钟 item-preserving coalesce、reversal、事务提交。
- **不做**：AI equality/importance、Digest、UI、系统通知；哈希不能单独创建 Event。

## 涉及模块和输入文档

- `src/shared/watch/diff/`、event-validator、`src/main/watch/watch-acquisition-service.ts` 与 run pipeline 接线。
- 输入：detailed §7/§9/§10；threat-model WT-12～WT-14、WRT-08/WRT-10～WRT-12。

## 预计修改文件

- 新增/修改 diff/event/validator/run pipeline 模块和测试；复用 D3/D4/D5/D6 窄端口。
- 不改 Research Evidence/Result 类型，不把 Capture 正文落盘。

## 实施步骤（红→绿）

1. 红：Feed/Page equality、新增/删除/修改/反转/噪声、hash-only、Condition unmatched、CAS/幂等/事务测试。
2. 绿：Normalization → Diff → EvidencePair → Condition → EventValidator → Repository transaction。
3. 添加/删除必须以 absent/present 双侧证据；截断/时间/URL/documentId/itemKey 引用逐项验证。
4. 失败矩阵证明旧 Baseline 不变；changed-unmatched 推进；首次/rebaseline 仅 audit。
5. 端到端受控 feed/page 运行与跨进程 Baseline/Event 恢复。

## 验收标准与测试

- contentHash 变化但零合规 pair → unexplainable_change，零 Event/零 Baseline 更新。
- Event+items+Baseline+Run+outbox 原子；同 idempotency 零重复；coalesce 不吞中间 pair。
- feed 重排/页面 Region 未变零事件；真实字段变化必有 before/after UI-ready 投影。
- Source/version/expectedBaseline 陈旧结果零写；全量门控、冒烟、WRT 对应项全绿。

## 完成定义

红→绿、Evidence 机器证据、隐私/事务扫描、独立 Reviewer PASS、候选提交。

## 依赖与停止条件

- 依赖 D2–D6；D8–D10 依赖本任务。
- 无法给 equality 精确 oracle、需模型判定、需保存正文/HTML、Event 无双侧 Evidence或要放宽 Baseline 原子性时停止 REPLAN。

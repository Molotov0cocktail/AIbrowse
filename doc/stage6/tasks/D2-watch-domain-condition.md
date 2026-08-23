# D2 — Watch 域契约、预算、状态机与确定性条件引擎

## 目标

建立 WatchRule/Schedule/Target/Run/Health/Projection/Condition/Event/Evidence/Digest DTO 与全部预算常量的
单一事实源，并以纯函数实现 Rule 状态机和 v1 确定性条件引擎。

## 范围与非目标

- **做**：detailed §2/§3 全类型/常量（含 XML/Feed 整体预算与5秒主机间隔）；
  enabled/paused/muted/source 状态迁移、`desiredEnabled` 与 Source rowVersion/locator fingerprint 分离；
  Condition all/any 与闭合 operator；exact object validators、UTF-8 budget helpers。
- **不做**：SQL、网络、XML、实际 Scheduler、Diff、Provider、Electron/UI；零 AI-evaluated rule/regex/script。

## 涉及模块和输入文档

- 新增 `src/shared/types/watch.ts`、`src/shared/watch/watch-rule-state.ts`、
  `src/shared/watch/condition-engine.ts`、`src/shared/watch/watch-budget.ts` 及测试。
- 输入：proposal U06/U07/U14/U16/U26/U28/U30；detailed §2–§5；threat-model §3.3/§3.6。

## 预计修改文件

- 上述 shared 文件及 `*.test.ts`；如 D1 已创建类型文件，只在同一契约内扩充。
- 既有 Browser/Sources/Research/Agent/renderer/preload 零改动。

## 实施步骤（红→绿）

1. 红：先写导出/常量/判别联合/状态矩阵/Condition 边界测试，旧结构模块缺失红。
2. 绿：类型与 validators → budget → 状态机 → ConditionEngine。
3. 敌手矩阵：额外键、原型链字段、NaN/Infinity/locale 数值、超长、空/超过10条件、嵌套、regex-like 文本。
4. 核对 Agent 17 工具和 Research 类型恒等。

## 验收标准与测试

- detailed §2/§3/§5 所有闭合值与常量逐项测试；XML depth/name/attribute/text/node/total/output 与
  host gap 常量可由后续模块唯一引用，魔法预算数字零散落。
- `muted` 不改变调度状态；paused 不等于 deleted；Source pause 不覆盖 `desiredEnabled`，用户 pause 永不被
  restore 自动恢复；所有非法迁移安全返回。
- Condition 只能读取验证字段；不匹配结果纯确定性、输入深冻结不修改。
- 聚焦测试 + 全量 test/typecheck/lint/format/build/diff-check 全绿。

## 完成定义

红→绿证据、diff 自审、文档无漂移、Reviewer PASS、候选提交，不接线产品行为。

## 依赖与停止条件

- 依赖 D1 Clock/基础预算 helper；D3–D9 依赖本任务。
- 若需要自然语言规则、正则、模型求值、任意字段路径或新 Agent 工具，停止 REPLAN。

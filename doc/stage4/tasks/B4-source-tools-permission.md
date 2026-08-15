# B4 — Source Tools + 权限矩阵 + L2 change set 确认/审计 + Agent 上下文隔离

> 第四阶段任务文档。契约源 `doc/stage4/detailed-design.md`（§7 change set 全链路/
> §9 工具与权限矩阵/§12 安全契约）；安全契约源 threat-model（SRT-01/02/06/07 断言
> 先行，B8 汇总裁决）。

## 目标

把 SourceService 接入既有 Agent 工具管线：四工具注册（source_search/source_list/
source_get/source_apply_changes）、权限矩阵扩展（L0×3 + L2×1）、change set 确认
全链路（确定性 diff → L2 ConfirmManager → 幂等键 → expectedVersion → 单事务 →
journal）、审计脱敏、ToolResult 预算、UNTRUSTED_TOOL_RESULT 块隔离回归。

## 前置依赖

- B2（SourceService/change set 校验/diff/journal）、B3（search/list 完整实现）；
- B1–B3 全部完成前不得开始本任务。

## 范围

- tool-types.ts 扩展：`ToolExecutionContext.sourceService?`（类比 searchProvider）；
- source-tools.ts：四工具 ToolDefinition（schema/paramRules/baseRisk/executor，
  零 Electron import）；
- permission-policy.ts：TOOL_BASE_RISK 增 4 条目（search/list/get=0、
  apply_changes=2）；decide 无新增特殊判定（基础级别无条件）；
- tool-executor.ts：contentBudgetFor 增 SOURCE_TOOL_CONTENT_MAX=4000 分支；
- source_apply_changes executor：L2 确认摘要（确定性 diff 纯文本 ≤2000 +
  「共 N 项变更」）、approve 后调用 SourceService.applyChangeSet（幂等键主进程
  生成、expectedVersion 校验、单事务）、deny/迟到/未知 id 零写入（复用
  ConfirmManager）；
- shared/types/agent.ts ToolResultErrorCode 扩展（8 个 source 错误码）+
  conversation-store TOOL_RESULT_ERROR_CODES + agent-display 中文文案同步；
- audit-log：source_apply_changes 摘要形状（ops 计数/字段名/长度/版本/幂等键，
  note 正文零出现）；source_search 查询串全量（≤500）；
- index.ts：注册 4 工具（13 → 17）+ AgentLoop 装配透传 sourceService；
- 冒烟：8.1 工具数断言校准为 17；B-03（change set 确认全链路）；B-09 回归。

## 非目标

- Sources UI（B5）；AI 端到端与真实 Provider（B6）；usage 记录（B7）；任何
  Agent 系统提示改动（AGENT_SYSTEM_PROMPT 不变——Source 使用说明由工具
  description 承载，B6 校准）。

## 涉及模块

`src/main/sources/tools/source-tools.ts`（新增）、`src/main/ai/tools/tool-types.ts`、
`tool-registry.ts`（无改动——复用）、`tool-executor.ts`、`src/main/ai/permission/
permission-policy.ts`、`src/main/ai/audit-log.ts`、`src/shared/types/agent.ts`、
`src/main/ai/conversation-store.ts`（错误码集合）、`src/renderer/src/ai/
agent-display.ts`（错误码文案）、`src/main/index.ts`、`src/main/smoke.ts`；
单测 source-tools.test.ts + 既有矩阵扩展。

## 红态测试（先红后绿）

- 四工具 schema/paramRules 校验矩阵（change set 结构/边界/字段白名单）；
- 权限矩阵：search/list/get L0、apply_changes L2（编译期常量恒等）；
- 确认全链路：deny 零写入/approve 恰一次/迟到与未知 toolCallId 零写入/重放
  幂等/expectedVersion 冲突拒绝/20 项超限 source-limit；
- 审计：apply_changes 摘要形状 + note 零出现；search 查询串全量；
- 结果预算：4000 截断 + warning；错误码映射全表；
- 块隔离回归：source 结果（含注入 note）进 UNTRUSTED_TOOL_RESULT 块、system/
  工具列表/权限矩阵恒等；
- 冒烟 8.1 校准 17 工具断言。

## 实现步骤

1. 共享错误码 + tool-types 扩展（红→绿）；
2. source-tools 定义 + 权限矩阵 + 预算分支（红→绿）；
3. apply_changes executor 确认链路（红→绿）；
4. 审计 + index 注册 + AgentLoop 透传（红→绿）；
5. 冒烟 B-03/B-09 校准与回归；
6. 全量验证 + 文档同步。

## 验收标准

- detailed-design §7.1/§9 全部落地并有单测 + 冒烟证据；
- SRT-01/02/06/07 相关断言先行可用；
- 工具数 17（8.1 断言校准）且既有 13 工具行为零回归；
- 确认前数据库零变化（红队夹具字节级断言）。

## 全量验证

`npm test` · `npm run typecheck` · `npm run lint` · `npm run format:check` ·
`npm run build` · dev+生产双场景冒烟（含 B-03/B-09 与既有全矩阵）· 红线 grep
（source_sql/source_delete_hard/source_export_all 不存在；SQL 零扩散）· diff 终检。

## 提交要求

一个或少量逻辑 commit；提交信息 `<type>: <中文描述>`；不提交临时数据/日志。

## 完成定义

验收标准全绿 + progress 任务表 B4 ✅ + 双远程推送；契约偏差先校准文档与测试。

## 风险与停止条件

- 确认链路与既有 ConfirmManager 契约冲突（如 diff 摘要超长/多 run 并发）→ 回
  设计流程校准（决议记录），不得放宽确认（不得降 L2、不得自动批准、不得
  「始终允许」）；
- 工具注册导致既有 13 工具任何回归 → 修复回归为最高优先级，修复前不提交；
- 红线：不新增网络能力、不改 AGENT_SYSTEM_PROMPT、不改既有工具 schema。

## 实施记录（2026-08-15，B4 会话）

### 实施前契约裁决（接口缺口核验属实）

- **#64 结构化 schema**：ProviderToolParameter 冻结于「仅 string|number|boolean
  无嵌套」——source_apply_changes 只能退化为 JSON 字符串通道。裁决：最小递归
  object/array 扩展（properties/required/items/maxItems 缺省 20）+ 递归校验
  （additionalProperties=false 未知字段拒绝/嵌套 enum/逐项/深度上限 4）；
  既有 13 工具 schema、序列化、校验行为零变化（零回归断言固化）。
- **#65 expectedVersion 并发令牌**：决议 #38「version 不回显」使模型无法获得
  提交 update/disable/restore 所需的版本号。裁决：仅 source_get 的 agent
  allowlist 返回 expectedVersion（值 = 服务层 version）；search/list 恒不返回；
  blocked 视同不存在；version 字段名本身不回显（决议 #38 校准，§8.1 同步）。
- **#66 previewChangeSet 只读预览 + 确认摘要钩子 + TOCTOU**：SourceService 增
  `previewChangeSet(cs)`（与 apply 同一校验语义 + 逐项预检，只读生成 ≤2000
  中文 diff——纯函数 `buildChangeDiff(ops, rows)`；零 journal/零幂等键）；
  ToolDefinition 增 `confirmSummary?` 钩子（ToolExecutor 在 requestConfirm 前
  调用；预览失败 → 钩子错误码 fail-closed 不进入确认）；批准后 applyChangeSet
  重新校验版本（逐项预检 + 事务内版本条件更新双重校验）；blocked 猜测引用
  （update/disable/restore）→ source-forbidden、add 撞 blocked → duplicate
  不回注 id（零泄漏）。
- **#67 审计隐私收紧**：note 正文零出现（仅字段名+长度）；URL 值零出现；
  source_search 查询 ≤500 但 URL 形态 query 值脱敏；幂等键成功后由
  ToolExecutor 追加（恰好一条审计纪律不变）。

### 红→绿证据

- **红态**：8 files failed / 25 failed / 1012 passed（source-tools.test.ts 模块
  缺失；注册表嵌套校验缺失/审计 ops 整体 JSON 化泄漏 note/查询值未脱敏/
  previewChangeSet 不存在/apply 对 blocked 照常写入且回注既有 id/确认钩子缺失
  （base 2 被 decide 回落 L1 自动执行）/store 拒绝 source 错误码/agent-display
  无文案——全部为决议 #64–#67 契约对照下的真实失败；既有 1007 用例零删除零削弱）。
- **绿态**：全量 **1071/1071**（+64：source-tools 33 / tool-registry 6 /
  tool-executor 5 / audit-log 3 / source-service 7 / source-change-set 4 /
  conversation-store 1 / agent-display 5）。
- **冒烟**：8.1 注册表断言校准 17 工具；新增 8.10 B-03/B-04 B4 部分（默认矩阵）
  ——dev 完整矩阵退出码 0；生产产物完整矩阵退出码 0；B-02 生产双进程 set/check
  退出码 0/0（回归）。
- **红线**：禁具零命中；SQL 零扩散；零 any/@ts-ignore；Source 工具零 Electron
  import；package/lockfile 零改动；既有 13 工具 schema 零改动；B1 driver/B2
  schema v1 零 diff；敏感扫描与 git diff --check 零命中；临时目录零残留。

### 验收标准核对

- detailed-design §7.1/§9 全部落地并有单测 + 冒烟证据 ✅
- SRT-01/02/06/07 相关断言先行可用 ✅（blocked 猜测/note 块隔离/单事务/重放
  幂等/审计脱敏均有单测与冒烟断言；B8 汇总裁决）
- 工具数 17（8.1 断言校准）且既有 13 工具行为零回归 ✅
- 确认前数据库零变化 ✅（preview 零写入单测 + deny 字节级零变化冒烟断言）

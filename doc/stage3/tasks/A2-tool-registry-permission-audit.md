# A2 Tool Registry + 权限分级与确认状态机 + 审计日志（可验证闭环）

- **目标**：建立 Tool Registry（schema 校验/listTools 序列化）、确定性权限纯函数
  （L0–L3 矩阵 + click 确定性允许列表）、确认状态机（pending/approve/deny/作废）、
  结构化审计日志；接线首批 8 个只读/导航工具（get_tabs/get_active_tab/read/open/
  navigate/back/forward/reload——全部复用既有 BrowserController 接口，零新浏览器能力）。
- **输入文档**：doc/stage3/detailed-design.md §2.2/§4/§7/§10/§13.1；
  doc/stage3/threat-model.md §3.2–§3.4。
- **范围**：tool-types/tool-registry/validateToolArgs（JSON.parse 失败/未知工具/
  缺必填/类型/enum/未知键/长度上限/tabId、elementId 格式）；browser-tools 8 个
  （executor 经注入的 BrowserController，不 import Electron）；
  permission-policy 决策矩阵全表（含 **click 确定性允许列表**：导航/展开/切换目标
  L1、isSubmit 提交类升级 L2、非允许列表目标 fail-closed L3、password/file → L3、
  URL scheme → L3——升级判定输入元素语义元数据，本任务以纯函数级验证为主，
  历史快照提取接线在 A5）；confirm-manager 状态机；audit-log 结构化条目 +
  fill 值脱敏（len=N）专项用例；logger 审计条目。
- **非目标**：**严禁实现 scroll/click/fill/find 交互能力（A3）、SearchProvider（A4）、
  Agent Loop（A5）、UI/IPC 改动（A6）**；本任务工具只接线既有 BrowserController
  12 方法内能力；不放宽任何 Electron 安全边界。

## 涉及文件

- 新增：`src/main/ai/tools/tool-types.ts`、`tool-registry.ts` + `.test.ts`、
  `tool-executor.ts` + `.test.ts`、`browser-tools.ts` + `.test.ts`、
  `src/main/ai/permission/permission-policy.ts` + `.test.ts`、
  `src/main/ai/confirm-manager.ts` + `.test.ts`、`src/main/ai/audit-log.ts` +
  `.test.ts`、`src/shared/types/agent.ts`（§2.2 类型——A2 部分：ToolCall/
  ToolResult/权限级别/ElementSemantics；A5/A6 类型不提前落地）。
- 修改：`src/main/index.ts`（工具注册与装配接线 + 冒烟工具层探针注入）、
  `src/main/smoke.ts`（A2 工具层探针，§13.2 矩阵外的最小可见性探针）、
  `src/main/logger.test.ts`（审计形态脱敏回归 2 用例——**logger.ts 实现无需
  改动**：审计条目经既有 sanitize 链已满足脱敏，以测试固化）、`.gitignore`
  （根目录 `/aibrowse-*.log`：单测在 logger 未初始化时触发 CWD 日志的既有
  测试基础设施现象，运行测试即重现，防止误提交）。
- 文档：`doc/stage3/detailed-design.md` §7.1（ariaExpanded 契约校准）、
  AGENTS.md / README.md / progress.md（A2 状态与契约回填）。

## 实施步骤

- [x] 红：permission 决策矩阵全表用例（含 click 允许列表各分支/非允许列表
      fail-closed/元素语义缺失 fail-closed）/ validateToolArgs 校验矩阵 /
      confirm-manager 状态机用例 / 审计脱敏用例
- [x] 实现类型与注册表（§4.1）→ 校验器
- [x] 实现 permission-policy（§7.1 矩阵与 click 允许列表为编译期常量）
- [x] 实现 confirm-manager（§7.2：单 pending/无自动批准/作废）
- [x] 实现 audit-log + 8 个只读/导航工具 + tool-executor 装配（校验→权限→执行→审计）
- [x] 全量回归（test/typecheck/lint/format:check/build/冒烟离线矩阵）→ 提交推送
      → 更新 progress.md

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；单测见 detailed-design §13.1 A2 行；
  红线 grep：本任务 diff 无交互注入/无万能工具/无 Key 形态。
- **click 允许列表专项**：决策矩阵对「无元素语义元数据（历史中无该 elementId）」
  的 click 必须判定 L3 fail-closed——不得回落到基础 L1 或「执行时定位兜底」。

## 完成定义

- 单测全绿；全量回归通过；冒烟离线矩阵退出码 0（既有场景回归 + 注册表装配不影响
  共读）；权限矩阵（含 click 允许列表与 fail-closed 分支）与审计条目单测覆盖全表；
  progress.md 标记 A2 ✅ 并推荐 A3。
- **实施结果（2026-08-14）**：**① 契约校准（先于编码）**：detailed-design §7.1
  矩阵行「展开：buttons 条目 ariaExpanded=true」与 §5.4「显式声明展开状态」/
  A3 模板 `[aria-expanded]` 属性存在选择器/threat-model §3.3（无 `=true`）矛盾
  ——判文档疏漏，最小校准为「ariaExpanded 字段存在（true/false 均为展开/折叠
  控件的结构化证明），字段缺失 fail-closed」（§7.1 已同步，threat-model 本已
  一致无需改）。**② 红→绿**：先写 6 个新测试文件 + logger 审计形态回归——红态
  **6 files failed（模块不存在）/ 363 passed**；实现后全量 **452/452**
  （新增 91：tool-registry 17 / permission-policy 18 / confirm-manager 9 /
  audit-log 14 / tool-executor 14 / browser-tools 17 / logger 2；既有用例
  零改动）。**③ 实现**：shared/types/agent.ts（ToolCall/ToolResult/
  ToolResultErrorCode/ToolPermissionLevel/ElementSemantics——A5/A6 类型未提前）、
  tool-registry（重复注册确定性抛出/listTools 只出模型可见 schema 且按名排序
  恒等/validateToolArgs 全矩阵任意非法输入安全返回）、permission-policy
  （TOOL_BASE_RISK 编译期矩阵 + decide 纯函数：isSubmit 优先 L2、href http/
  https、ariaExpanded 字段存在、checkbox/radio、其余 L3；fill password/file
  与类型元数据缺失恒 L3；open/navigate scheme L3）、confirm-manager（单 pending
  同步建立/并发请求 fail-closed 立即 denied/approve・deny 幂等/cancelAll 作废/
  无自动批准）、audit-log（summarizeArgs 键排序 + fill text len=N + url 全量 +
  确定性截断、formatAuditMessage §10.1 格式、createAuditLogger 薄封装——全量经
  logger sanitize）、tool-executor（校验→权限→确认→执行→审计单出口恰好一条；
  结果预算 2000/read 8000/search 4000 确定性截断；错误永不以 ok:true 返回；
  异常归一化 execution-failed 并 logWarn）、browser-tools 8 个只读/导航工具
  （只经注入 BrowserController；read 实时采集；serializeSnapshotForTool 章节
  化确定性序列化）。**④ 接线与冒烟**：index.ts 注册 8 工具 + 装配
  ToolExecutor(ConfirmManager, createAuditLogger)；smoke 新增 8.1 A2 工具层
  探针（注册表恰好 8 工具/listTools 恒等/get_tabs・read 真实执行成功/
  javascript: URL forbidden 且不建 Tab/非法 tabId invalid-args/未知 tabId
  execution-failed/日志切片 5 条审计恰好一次一条）——dev 离线全矩阵 + 生产
  产物双场景退出码 0。**⑤ 验证与终检**：test 452/452 · typecheck · lint ·
  format:check · build 全绿；红线 grep（无交互注入/万能工具/click・fill 注册/
  依赖新增；SYSTEM_PROMPT/UI/preload/IPC 零改动）；敏感信息与 diff 终检；
  根目录杂散日志清理 + .gitignore 补防（单测 logger 未初始化写 CWD 的既有现象）。
  **⑥ 计时用例抖动观察（既有用例，未放宽阈值）**：fake-provider「延迟块实际
  等待」在全量负载下 2 次测得 29.94ms < 30ms（差 0.06ms）；单独文件 10/10、
  全量连跑 5/5 均通过——判定为墙钟断言在并行负载下的边缘抖动，非可复现失败，
  按用户约定如实记录、不随意放宽阈值（后续会话若高频复现再评估根因修复）。
  **未调用任何付费 Provider、未输出/索取 API Key。**

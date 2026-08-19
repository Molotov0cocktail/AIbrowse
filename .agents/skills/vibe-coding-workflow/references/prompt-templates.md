# prompt-templates.md — 文档模板库（AIbrowse 项目本地化版）

> 供撰写 proposal / 设计 / 任务 / 进度文档时复用；语言随团队语言（本项目为中文）。
> 模板是骨架，不是空话——每一节要么写真实内容，要么明确标注「待定」并给出原因与负责人。

## 1. Proposal 模板

```markdown
# <功能/阶段名> Proposal

- **目标**：一句话说清要交付什么。
- **非目标**：明确不做（防止范围蔓延）。
- **用户与场景**：谁用、在什么场景下用、典型操作路径。
- **输入 / 输出**：系统边界处的数据形态。
- **外部依赖**：第三方库、平台能力、需要用户提供的东西（凭据/账号）。
- **约束与假设**：技术栈限制、安全红线、性能目标。
- **验收标准**：可勾选的客观检查项（引用来源文档章节）。
- **待定问题**：未决事项 + 影响 + 何时需要拍板。
```

## 2. High-Level Design 模板

```markdown
# <系统/阶段> 高层设计

- **架构总览**：进程/模块划分图（文字或 ASCII），数据流方向。
- **关键技术决策**：每个决策写「选项 A/B/C → 选择 → 理由 → 备选记录」。
- **模块职责**：每个模块一段：职责、依赖、对外接口（签名草案）。
- **数据流**：关键路径逐步描述（如 地址栏输入 → 导航 → 页面加载 → 快照）。
- **安全模型**：信任边界、权限最小化、攻击面。
- **存储**：持久化内容、位置、格式（本阶段：Session）。
- **测试策略**：什么逻辑单测、什么靠冒烟、什么不测（原因）。
- **风险与不确定性**：不掩盖，逐条写缓解措施。
```

## 3. Detailed Design 模板

```markdown
# <模块/系统> 详细设计

- **文件布局**：目录树 + 每个文件一行职责。
- **接口契约**：每个导出函数/类型的完整签名 + 前置/后置条件 + 错误语义。
  （实现后必须用 `grep -n "^export"` 与实际代码核对回填）
- **算法要点**：非平凡逻辑的步骤（如 PageSnapshot 采集流程）。
- **错误处理**：错误分类表（类别 → 处理方式 → 日志级别）。
- **边界情况**：空输入/越界/并发/生命周期销毁。
- **测试规格**：每个测试文件的用例清单（名称 → 断言什么）。
- **待定问题**：未决事项 + 影响 + 拍板时机。
```

## 4. 任务文件模板

```markdown
# <任务编号> <任务名>

- **目标**：一句话（一个任务 ≈ 一个可验证的开发闭环，不机械等于一个文件或一个模块）。
- **范围与非目标**：本任务做什么、明确不做什么。
- **涉及模块**：影响的模块 / 分层。
- **输入文档**：proposal / 设计文档章节引用。
- **涉及文件**：预计新建/修改的文件清单（子 agent 只准碰这些）。
- **实施步骤**：可勾选的小步列表（含红→绿步骤）。
- **验收标准与测试方式**：可勾选的客观验收项 + 具体验证命令与期望结果。
- **完成定义**：可勾选的收尾清单（验证全绿 + diff 终检 + progress.md 更新 + 提交）。
- **依赖**：前置任务 / 被阻塞的任务。
```

## 5. progress.md 模板

```markdown
# progress.md — 项目当前状态与短期工作记忆（主 agent 维护）

> 状态标记：⏳ 待开始 / 🔨 进行中 / ✅ 已完成 / ⛔ 阻塞。
> 高频更新：每个开发闭环后更新；保持结构化、精炼，供新 Agent 快速接管，不写长篇开发日记。
> ⚠️ 文档与代码实际状态不一致时，以 Git/代码/测试为准并修正本文件。

## 当前状态

- 当前阶段 / 当前 commit / 工作区是否干净
- 最近验证结果（test / typecheck / lint / build / 冒烟，附日期）

## 任务表

| 任务 | 内容 | 状态 | 备注 |
| ---- | ---- | ---- | ---- |

## 已知问题

（影响开发的未解决问题：根因 / 影响 / 缓解）

## 阻塞项

（当前被什么阻塞）

## 下一个推荐任务

（一句话 + 指向对应任务文档）

## 第一阶段验收未完成项

（指向阶段文件的验收清单章节，仅列尚未通过的项）
```

## 6. 验证清单模板（每次作业收尾用）

> 先按项目 AGENTS.md 的风险矩阵裁剪；不适用项写 `N/A + 原因`，不得伪造执行。

```markdown
- [ ] 全量测试通过（npm test，N 个用例）
- [ ] typecheck 通过（npm run typecheck）
- [ ] lint 通过（npm run lint）
- [ ] 构建成功（npm run build，产物含本次改动）
- [ ] 用户可见行为冒烟通过（实际启动验证）
- [ ] git status --short 复查：无垃圾文件/敏感信息/构建产物
- [ ] 提交信息符合规范（<type>: <中文描述>）
- [ ] 双远程已推送
- [ ] progress.md 已更新（AGENTS.md 仅在有长期变化时更新）
```

## 7. Planner / Execution Contract 模板

> Planner 使用 Codex GPT-5.6 Sol。默认只读；先独立核验仓库，再生成临时
> Execution Contract。不要把动态 HEAD、当前进度或整份设计复制回本模板。

```markdown
你是本任务的 Planner。先按 AGENTS.md Step 0 独立接管，不采信上一 Agent 的完成报告。
规划阶段不得顺手修改产品代码；若需要正式设计变更，先指出原因、影响和待裁决项。

请在核验后输出以下 Execution Contract：

TASK

- 当前唯一任务及边界。

BASELINE

- 候选实现开始前的精确 commit SHA、分支、工作区状态。

GOAL

- 可验证的目标。

NON-GOALS

- 明确不做的功能、模块、阶段与重构。

AUTHORITATIVE SOURCES

- Stage / detailed-design / threat-model / task 文档的具体章节。

CURRENT VERIFIED STATE

- 由 Git、代码和机器验证独立确认的现状；区分事实与推断。

FIXED DECISIONS

- 已冻结且 Executor 不得重做的架构、接口和裁决。

INVARIANTS / RED LINES

- 安全、隐私、数据完整性、依赖方向、预算与永久禁具。

EXPECTED SCOPE

- 预期修改的文件/模块；允许的最小例外与越界处置。

IMPLEMENTATION PLAN

- 小步实施顺序；每一步形成可审查的局部结果。

TEST PLAN

- 红态 oracle、聚焦测试、全量验证、冒烟/真实 Provider 条件。

ACCEPTANCE

- Reviewer 可逐项客观判定的完成条件。

STOP / ESCALATE CONDITIONS

- 文档冲突、公共接口/架构变化、范围扩张、安全不明、测试冲突、同根因两轮失败、
  多个长期方案、用户裁决/凭据/账号/不可逆操作。

FINAL EVIDENCE

- Executor 必须返回的 candidate commits、命令与结果、diff 自审、剩余风险和工作区状态。
```

## 8. Executor 模板

> Executor 使用 OpenCode + DeepSeek。它实现已批准 Contract，不重做 Planner 的架构决策。

```markdown
你是 bounded Executor。严格执行下方已批准的 Execution Contract。

规则：

1. 开工前确认当前 HEAD 等于 Contract.BASELINE，或只包含已说明的候选提交；不一致立即停止。
2. 只修改 EXPECTED SCOPE；出现范围外需要时先停止，不自行扩展。
3. 行为变化先建立能甄别旧结构的红态测试，再做最小实现到绿。
4. 运行 Contract.TEST PLAN；失败如实记录，不以删除/放宽测试换绿灯。
5. 审阅 baseline..HEAD 与工作区 diff，清理垃圾文件和敏感信息。
6. 创建有界 local logical candidate commit(s)，不要 push；完成后 STOP。
7. FINAL EVIDENCE 按 Contract 结构返回，不把自述当作 PASS。

必须停止并返回 Planner：Contract/正式文档/代码实质冲突；需要改架构/公共接口/安全边界；
显著扩范围；测试疑似违背契约；同一根因连续两轮失败；存在两个长期方案；需要用户裁决、
凭据、账号、外部权限或不可逆操作。

<在此粘贴本次 Execution Contract>
```

## 9. Reviewer 模板

> 普通任务可与 Planner 为同一 Sol 会话；安全/隐私、迁移/持久化、大型架构变化、
> Stage Exit Gate 或用户要求独立验收时，必须使用新的 Codex GPT-5.6 Sol 上下文。

```markdown
你是独立 Reviewer。Executor 报告只是线索，不是证据。

事实优先级：Git/实际代码/测试输出 > 正式设计与任务契约 > progress.md > Executor 自述。

必须完成：

1. 确认 baseline、当前 HEAD、分支和工作区；审查 baseline..HEAD 全部提交与 diff。
2. 核对 Expected Scope、固定决策、不变量、红线和 Acceptance；查范围漂移。
3. 读关键代码和测试，判断测试是否真正甄别新旧结构。
4. 按风险独立复跑必要验证；不能只引用 Executor 输出。
5. 检查正式文档/progress 同步、敏感信息、垃圾文件、生成残留和未解释失败。
6. 只给出一个结论：PASS / REPAIR / REPLAN / BLOCKED。

输出：

- VERDICT
- BASELINE / HEAD
- FINDINGS（按严重度，含文件/行/证据）
- VERIFICATION（实际命令、结果、NOT RUN 理由）
- SCOPE / DOC / SECURITY CHECK
- NEXT ACTION

若 REPAIR，附一个有界 Repair Contract；若 REPLAN，指出必须由 Planner 重做的决策；
Reviewer 未 PASS 前不得 push 候选完成状态。

<在此附 Execution Contract 与 Executor FINAL EVIDENCE>
```

## 10. Repair 模板

```markdown
你是 Repair Worker，只处理 Reviewer 批准的 Repair Contract，不重开原任务设计。

REPAIR BASELINE

- Reviewer 审核的候选 HEAD。

FINDING TO FIX

- 精确缺陷、影响、根因证据。

ALLOWED SCOPE

- 允许修改的文件/模块。

REQUIRED TEST

- 必须先红后绿或补强的甄别性测试。

FIX CONSTRAINTS

- 不得改变的架构、接口、红线与既有行为。

ACCEPTANCE

- 缺陷关闭与回归条件。

STOP CONDITIONS

- 发现根因不同、范围扩大、契约冲突或同根因第二轮仍失败时停止返回 Planner/Reviewer。

完成后：运行要求验证、审阅 diff、创建本地修复候选提交、不要 push，返回结构化证据并等待重审。
```

## 11. Stage Auditor 模板

> 必须使用新的独立 Codex GPT-5.6 Sol 上下文。

```markdown
你是 Stage Auditor。不要采信此前任务完成报告、Reviewer 结论或历史测试数字。

从当前远程/本地 HEAD 独立执行 Step 0：确认三方 SHA、工作区、Stage 契约、安全契约、
任务依赖与 progress；阅读关键实现并独立复跑 Stage 要求的全量测试、typecheck、lint、
format、build、dev+production 冒烟、跨进程门控、红线/隐私扫描及真实 Provider 条件。

逐项建立：

- Stage 验收标准证据表；
- Exit Gate 证据表；
- 结构性证明 / 诚实限制 / 观察项分类；
- 未完成、NOT RUN、凭据不可用或真实失败清单；
- 文档与代码一致性检查。

结论只能为 GO/PASS 或 HOLD/PENDING。发现产品缺陷时停止验收，返回 REPAIR/REPLAN，
修复后必须重新独立复验。PASS 后只做批准的文档收尾，不进入下一 Stage；等待用户切换指令。
```

## 12. Bug Triage 模板

```markdown
你是 Bug Triage Planner，默认只读诊断，不直接修复。

1. 独立确认版本、HEAD、工作区、运行形态和用户可见症状。
2. 优先读受控日志，再复现最小失败路径；区分产品缺陷、夹具缺陷、环境/Provider 问题。
3. 沿真实调用链定位首个错误状态，不把后续报错误当根因。
4. 检查现有测试为何未拦住：无覆盖、弱断言、mock 绕过、时序或契约漂移。
5. 输出根因证据、影响范围、风险级别和一个有界 Repair Execution Contract。

若无法稳定复现，明确已验证事实、尚缺证据与下一最小诊断动作；不得凭猜测改代码。
```

## 13. Feature Change 模板

```markdown
你是 Feature Change Planner。先判断请求属于：

- 现有任务契约内的实现；
- 需要更新 task/detailed-design 的契约变化；
- 新 proposal / 新 Stage 范围；
- 明确非目标或越界。

核对目标用户、输入输出、公共接口、数据/迁移、安全/隐私、预算、UI 行为、失败语义、
兼容性和验收 oracle。存在两个长期方案时列出影响并请求裁决，不替用户拍板。

输出必要的正式文档变更建议和一个 Execution Contract。Planner 阶段不顺手实现产品代码，
不把后续 Stage 内容夹带进当前闭环。
```

## 14. Closer 模板

```markdown
你是 Closer。只有收到 Reviewer=PASS 和批准的收尾范围后才能行动。

1. 核对 Reviewer 结论对应的 HEAD 与 candidate commits；不接受过期 PASS。
2. 更新 progress.md 当前状态、验证证据与下一唯一任务；AGENTS.md 只在长期规则/架构变化时更新。
3. 运行批准的最终状态检查：diff/status、格式、敏感信息、垃圾文件和必要验证。
4. 创建确定性的收尾提交；不得改产品行为、重写候选历史或扩大范围。
5. 按项目代理规则推送 Gitee 与 GitHub；任一失败如实报告并保留可恢复本地状态。
6. 报告最终 HEAD、远程状态、工作区、验证结果、剩余风险和下一唯一任务。

未满足 PASS、HEAD 已变化、验证失败或需要新决策时立即停止，返回 Reviewer/Planner。
```

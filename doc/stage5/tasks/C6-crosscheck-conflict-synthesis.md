# C6 — Cross-check、冲突模型、带证据综合与「不确定」输出

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §7；安全契约
> `doc/stage5/threat-model.md` §3.3/§3.4（FT-02/FT-07/FT-08/FT-10/FT-17）。
> **C5 端口契约校准（2026-08-16，决议 #134，C5 已落地）**：
> 本任务实现 `ResearchPromptsPort`（四槽）与
> `ResearchSynthesisPort.processVerification`/`parseResultDraft`——
> 端口精确形状见 detailed-design §15 决议 #134（C5 已冻结，C6 按此实现，
> 不得另设形状）。
> **实施前契约裁决 #140–#147 已完成（2026-08-16）**——本文档已按裁决
> 同步（C6/C7 分阶段装配边界/Provider 响应侧有界性/VerificationDraft
> 严格输入协议/Claim 确定性装配与厂商分类/Conflict 引用完整性/C5→C6→C7
> 数据交接/Prompt 与上下文构建所有权/parseResultDraft 与 Uncertainty
> 边界；精确语义见 detailed-design §7/§6.8/§6.11/§15）。

## 目标

落地 Cross-check 数据模型与综合层：VerificationDraft 严格白名单解析、
Claim/Coverage/sourceTypes/singleSourceFields 确定性装配、Conflict
显式保留（不静默抹平、双向引用一致）、Uncertainty 输出契约、四合成
提示词编译期常量（C5 端口引入第四槽）、parseResultDraft 结构解析——
替换 C5 的综合层桩接口（端口形状由决议 #134 冻结），并修复
C5→C6→C7 数据交接与 Provider 响应侧有界性两个 Runtime 缺口。

## 范围与非目标

- **做**：
  - claim-model（决议 #142/#143/#144）：VerificationDraft 严格白名单
    解析（纯 JSON/未知字段整份拒绝/局部 claimKey）；Claim 装配
    （coverage 按不同 canonicalKey 数程序计算/severity 影响程度语义/
    sourceTypes 程序判定 vendor→third-party→community（厂商分类缺口
    裁决：vendorCandidateIds 模型提议 + 程序 origin 判定，不洗白
    trust）/singleSourceFields 程序标记 `['整条结论']`/ID 由可信
    createId 生成（小写 v4 + 不重复）/先校验后分配 ID/返回顺序 = 模型
    顺序）；Conflict 装配（局部 claimKeys 映射/positions ≥2 规范化后
    不同/sourceRefs 引用完整性/多 canonicalKey/resolved 恒 unresolved/
    Claim.conflictIds ↔ Conflict.claimIds 双向一致/重复・悬空・复制・
    空 refs 整份拒绝）；`processVerification` 对任意输入安全返回不抛异常；
  - research-prompts（决议 #146/#147）：**四个**编译期常量
    （`AGENT_RESEARCH_PLANNING_PROMPT`/`AGENT_RESEARCH_READING_PROMPT`/
    `AGENT_RESEARCH_VERIFYING_PROMPT`（决议 #134(4)）/
    `AGENT_RESEARCH_SYNTHESIS_PROMPT`）+ 冻结只读 ResearchPromptsPort
    对象 + `parseResultDraft` 结构解析（顶层只能有 result、零 C7 语义、
    hostile 安全返回）；
  - Runtime 窄修改（决议 #141/#145）：Provider 输出侧预算（文本 delta/
    toolCalls 数量/id/name/arguments 单项与累计上限、超限零执行、超限
    原文零回显、reasoning 直接丢弃零累积）；内存保存最终
    claims/conflicts/verificationState 并交接 synthesis/C7（同一不可变
    快照；unavailable 标记；终态清空内存）；
  - shared/types/research.ts 新常量/类型（§6.8 新行 +
    VerificationDraft 类型 + ResearchVerificationState +
    ResearchResultValidationContext 新字段）；
  - 冒烟 8.18（dev+生产双场景）。
- **不做**：Result 渲染（C7）；UI 冲突视图（C8 消费数据模型）；修改
  EvidenceValidator/ResultValidator 契约；虚构百分比/分数字段（红线——
  schema 白名单不含）；**不解除生产 fail-closed**（决议 #140——index.ts
  生产装配零改动）；不实现 C7 ResultValidator 或 Renderer；不注入生产
  测试 stub；不提前解除 research-runtime-unavailable；不新增 Research
  IPC/UI/CSV；不修改 migration v1；Runtime 或 synthesis 模块不执行
  SQL；不修改 AgentLoop 12/420s；不增加工具注册表数量；不安装依赖。

## 涉及模块和输入文档

- 新增 `src/main/research/synthesis/claim-model.ts`、
  `src/main/research/synthesis/research-prompts.ts` + 同名测试。
- 输入：detailed-design §7/§6.8/§6.11/§15（决议 #98/#134/#140–#147）；
  threat-model §3.3/§3.4；C1 类型（Claim/Conflict/Uncertainty 块）；
  C5 端口形状（决议 #134）与 C5 context builder（决议 #136(2)——
  **块组装所有权在 C5 Runtime，C6 不另建重复序列化器**）。

## 预计修改文件

- 新增：`src/main/research/synthesis/claim-model.ts`、
  `src/main/research/synthesis/research-prompts.ts` + 同名 `*.test.ts`。
- 修改：`src/shared/types/research.ts`（#141/#142/#145 新常量/类型/
  context 新字段——#134 端口签名不变）、
  `src/main/research/research-runtime.ts`（真实综合层接线 + 数据交接 +
  输出预算——其余零改动）、`src/main/research/research-runtime.test.ts`
  （新红测 + 既有夹具机械校准）、`src/main/smoke.ts`（新增 8.18 场景
  入口 + 第二受控页夹具，既有场景零改动）。
- **不修改 `src/main/index.ts`**（决议 #140：C6 不得单独解除生产
  fail-closed；生产装配与 fail-closed 解除由 C7 统一执行——除非实际
  smoke 注册机制确实需要（C5 已提供，C6 不需要））。

## 依赖

C1（类型/预算常量）、C4（EvidenceValidator/normalizeCaptureText 复用）、
C5（端口形状 + Runtime context builder + 受控夹具）。

## 红→绿步骤

1. **红**（决议 #140–#147 先行，文档 → 红测 → 实现）：
   - Provider 输出预算红测：delta 恰好边界可完成/+1 失败；巨量
     reasoning 不累计、不进入 transcript；巨量 toolCalls/arguments 在
     执行前被拒绝；失败终态仍可写入且无迟到工具调用；
   - claim-model.test.ts：严格 JSON/未知字段/类型/长度/数量；Evidence
     与 Candidate 归属；canonicalKey coverage；vendor/third-party/
     community 矩阵；official 非 vendor origin 保守 third-party；单源
     high 披露；UUID v4/重复 ID；输入不修改、输出确定性；
   - Conflict 红测：局部 claimKeys 映射/positions/sourceRefs/多
     canonicalKey/悬空/重复/跨任务/无 Evidence/resolved 恒 unresolved/
     Claim.conflictIds 双向一致；
   - research-prompts.test.ts：四常量恒等、互异、纯编译期/system 零
     动态内容/exact JSON 指令/prompt injection 敌手内容仍只在 Runtime
     的 UNTRUSTED block（捕获 ProviderRequest 验证——决议 #146(4)）；
   - parseResultDraft hostile 矩阵；
   - Runtime 数据交接红测：claims/conflicts/verificationState 到
     synthesis/C7（C7 stub 收到同一不可变快照/模型无法替换 Runtime 持有
     的 Claim/Conflict/unavailable 标记/stop・timeout・late event 仍守
     C5 终态守卫）。
2. **绿**：实现两模块 + Runtime 窄修改；逐用例转绿。
3. **冒烟 8.18**（dev+生产双场景，见 detailed-design §13.2）：
   两个不同 canonicalKey 的受控来源 + ≥2 条 VerifiedEvidence + C6 真实
   ResearchPromptsPort/ResearchSynthesisPort + FakeProvider 确定性返回
   两条相反 Claim 和一个 Conflict + 严格但仅限 smoke 的 C7 Validator
   stub；验证 Claim.coverage/sourceTypes/singleSourceFields；Conflict
   显式落库、resolved=unresolved、双向引用一致；synthesizing 请求真实
   包含经验证 Claim/Conflict；Result 含同一 Conflict；Result coverage
   为计数（不含 score/percent/confidence）；Result 至少有一个 uncertain
   块；CaptureContent、Provider raw、transcript、reasoning 零落盘；
   用户 Tab 前后恒等；本场景不解除生产 fail-closed。
4. 全量回归 + 红线扫描 + AIBROWSE_RESEARCH_SMOKE=set|check 复跑
   （C5 双进程契约零回归）。

## 验收标准

- §7 全部规则单测覆盖（决议 #140–#147）+ 8.18 双场景通过；
- Result coverage 为计数类事实（无百分比/分数字段——schema 断言）；
- 冲突零抹平（程序校验 + 视图数据在位）；prompts 恒等断言全绿；
- Provider 响应侧有界 + reasoning 零累积；数据交接不可变快照断言全绿；
- 生产 fail-closed 维持（index.ts 零改动断言）。

## 具体验证命令和期望结果

- `npm test -- --maxWorkers=1` → 全量绿；
- `npm run typecheck` / `npm run lint` / `npm run format:check` /
  `npm run build` / `git diff --check` → 全部退出码 0；
- dev + 生产冒烟默认矩阵（含 8.18）退出码 0；
- `AIBROWSE_RESEARCH_SMOKE=set|check` 双进程退出码 0（生产产物）。

## 完成定义

红→绿证据回填 + 8.18 通过 + 全量验证全绿 + diff 终检 + progress.md
更新 + 逻辑提交（docs: 裁决 C6 契约 + fix: Provider 输出预算 +
feat: 完成 C6 + docs: 回填证据）+ 双远程推送。

## 风险与停止条件

- sourceTypes 判定与候选 trust 语义冲突（官方/第三方分类不可靠）→ 停止
  并校准本文 §7.2 判定规则（保守默认不虚构——决议 #143 已裁决厂商分类
  缺口）；
- 合成提示词导致模型在真实场景系统性不报冲突 → 属语义层残余风险
  （threat-model §5 第 9 类），如实登记不宣称免疫；结构面（冲突模型/
  程序校验）不得放宽；
- 输出预算边界与最大合法载荷（Result 草案 ≤200k + 转义余量）冲突 →
  停止并报告（不得静默放宽常量，调整走 §15 决议流程）。

## 提交边界

逻辑提交（决议文档 → 输出预算 fix → feat C6 → 证据回填）；不夹带
C7/C8 代码；不夹带 index.ts 生产装配改动。

## 红→绿证据

- **红态**（2026-08-16，模块不存在/旧结构）：
  - 3 个新测试文件整体失败（导入错误——synthesis 模块尚不存在；
    research-runtime-c6.test.ts 引用的端口常量缺失）；
  - 红态 3 files failed / no tests（vitest 输出实证——模块缺失红）。
- **转绿**：实现 shared/types/research.ts 新常量/类型（#141/#142/#145）、
  synthesis/claim-model.ts（VerificationDraft 严格解析 + Claim/Conflict
  确定性装配 + parseResultDraft）、synthesis/research-prompts.ts（四编译期
  常量 + 冻结端口对象）+ Runtime 窄修改（输出预算/数据交接/终态清空）后——
  C6 聚焦 **61/61**（claim-model 42 + prompts 10 + runtime-c6 9）；
  全量 **1865/1865**（基线 1804 + 61 新增；既有用例零删除零削弱）。
  实现期修正均为契约落地（fail 返回类型收窄/测试夹具数据库隔离——候选
  表 candidate_id 为全局主键/边界测试脚本与 idQueue 消费序对齐），无迁就
  实现。
- **冒烟 8.18**（默认矩阵自动包含；dev 退出码 0）：两个不同 canonicalKey
  受控来源（A/B 冲突页）+ C6 真实 prompts/synthesis 端口 + 严格 C7 stub
  → completed；claims 2 条（c1 multi-source/severity=high 保持、c2
  single-source + singleSourceFields=['整条结论']、sourceTypes 保守
  third-party）；Conflict 显式落库（resolved=unresolved、claimIds 程序
  映射、双向 conflictIds 一致）；C7 stub 收到与持久化深相等的不可变快照
  （verificationState=verified）；synthesizing 请求真实包含装配
  Claim/Conflict（UNTRUSTED 块内 + 核验状态标记 + 四真实 system 常量）；
  Result.conflicts 来自程序快照（模型伪造冲突被忽略）、coverage 程序重算
  计数（零 score/percent/confidence）、≥1 uncertain 块；capture 正文
  探针/reasoning 探针零落盘、零进 transcript；用户 Tab 前后恒等；
  本场景零真实 Provider 调用、不解除生产 fail-closed。
- **红线扫描台账**：index.ts 零改动（生产 fail-closed 维持——决议 #140）；
  migration v1 零改写；Runtime/synthesis 零 SQL（SQL 仅 Repository 编译期
  常量 + migrations/driver）；零 shell/child_process/eval；工具注册表仍
  17；AgentLoop 12/420s 零 diff；package.json/lockfile 零 diff；
  renderer/preload 零改动；reasoning 零累计/零回放/零持久化；Provider
  响应侧有界（文本/toolCalls/id/name/arguments 单项与累计编译期上限）；
  Claim/Conflict/Result 草案原文零日志零持久化。
- 验证命令：`npm test -- --maxWorkers=1` **1865/1865** 绿；typecheck/
  lint/format:check/build/diff-check 绿；dev + 生产默认冒烟（含 8.18）
  退出码 0；`AIBROWSE_RESEARCH_SMOKE=set|check` 双进程退出码 0/0。

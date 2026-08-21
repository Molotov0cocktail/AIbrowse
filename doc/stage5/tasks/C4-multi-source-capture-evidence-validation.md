# C4 — 多源读取、结构化提取、capture 记录和 Evidence 确定性验证

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §5；安全契约
> `doc/stage5/threat-model.md` §3.3/§3.4（FT-03/04/05/06 核心防线）。
> **实施前契约裁决 #124–#130 已完成（2026-08-16）**——本文档已按裁决同步。

## 目标

落地 CaptureService（task Tab 读取/结构化提取/capture 记录，正文不持久化）
与 EvidenceValidator（模型只提不可信 proposal、程序验证来源存在/捕获归属/
摘录与坐标来自捕获内容）——Research 证据链的确定性验证核心。

## 范围与非目标

- **做**：CaptureService.read（候选 URL 校验 → Workspace acquire（已加载，
  零二次 navigate——决议 #124）→ ready 轮询 → checkTab → getPageSnapshot
  实时采集 → 结构化提取（CaptureContent：章节/表格 tableIndex 坐标/闭合
  字段路径）→ capture 记录组装（contentHash/documentId/accessTime 主进程
  盖章/summary/失败 sentinel 与重试 ≤1 次，决议 #125/#126/#127/#128））；
  EvidenceValidator.verify（不可信 proposal 六字段 → 归属/来源/摘录/坐标/
  字段确定性验证 → VerifiedEvidence 组装或闭合错误码拒绝，决议 #129/#130）；
  正文内存保留至任务终态（零落盘）。
- **不做**：Runtime 编排与 stats 递增（C5）；claims/冲突（C6）；
  Renderer（C7）；修改 PageSnapshot 采集管线（不新建采集通道——Fifth_stage
  约束）；修改 SearchProvider/ResearchWorkspace/SourceSelector/SourceService
  产品行为；修改 migration v1。

## 涉及模块和输入文档

- 新增 `src/main/research/capture-service.ts`、
  `src/main/research/evidence-validator.ts` + 同名 `*.test.ts`。
- 输入：detailed-design §5（决议 #124–#130 重写后）；threat-model §3.3/
  §3.4；PageSnapshot/SnapshotMeta 契约（shared/types/browser.ts，已核对）；
  C2 Workspace 接口（research-workspace.ts，已核对）；snapshot-normalize
  同族清洗函数复用。

## 预计修改文件

- 新增：`src/main/research/capture-service.ts`、
  `src/main/research/evidence-validator.ts` + 同名 `*.test.ts`。
- 窄幅既有修改（决议 #129）：
  `src/shared/types/research.ts`（EvidenceLocator.table 增 tableIndex +
  CaptureSummary.tableCount 注释校准 + EvidenceProposal/EvidenceRejectionCode/
  EvidenceVerifyResult 类型）；
  `src/main/research/repository/research-repository.ts`（parseLocatorJson
  严格 tableIndex 解析）+ 对应 `.test.ts`；
  `src/main/smoke.ts`（新增 8.16 独立默认场景 + 受控夹具路由，只增不改）。
- 契约文档同步：detailed-design §2/§5/§6.4/§6.7/§6.8/§9.1/§13/§15、
  threat-model §3.3/§3.4、本任务文档、progress.md。

## 依赖

C1（Capture/Evidence 类型与预算）、C2（Workspace）、C3（候选形状）。

## 红→绿步骤

1. **红**：先写测试——capture-service（acquire 已加载零二次 navigate/ready・
   error・missing・timeout・abort/L0–L3 阶梯映射/重试与不重试矩阵/finally
   release/release 失败不误报清理/redirect 实际 URL・capturedAt・documentId
   盖章/failed Capture sentinel/规范化（NFC・空白・控制・bidi）/60k 边界・
   surrogate 不拆分/预算与哈希覆盖/contentHash 确定性・输入零修改/正文零
   持久化存储探针）；evidence-validator 敌手矩阵（多表 tableIndex 精确区分/
   伪造摘录・跨 section 拼接・错绑 captureId 跨任务・failed capture・
   坐标越界・超长 excerpt・header 非法形状与不一致/fieldPath 白名单・
   原型链键・未知字段・value 不一致・rejected 不产生 Evidence・幂等）+
   repository tableIndex 写入/读回恒等与非法行跳过。旧结构（无模块）全部失败。
2. **绿**：实现两模块（Workspace/浏览器注入替身 + 真实快照夹具）；
   逐用例转绿。
3. **冒烟 8.16**（smoke.ts 新场景，dev+生产双场景）：受控页夹具（多章节/
   ≥2 表格/heading/link 字段）→ 真实 ResearchWorkspace + CaptureService 读取
   → capture 记录断言（实际 documentId/accessTime/hash/summary/tableIndex）
   → FakeProvider 只产确定性 proposal JSON：正确引用 verified / 伪造・错绑・
   错误 tableIndex・越界 rejected → 失败 URL 后继续读取下一候选成功（C4 内
   不改 failedReadCount）→ Capture 元数据 + 少量 VerifiedEvidence 写临时
   research.db（未验证引用零落库）→ 正文零持久化探针（拆分标记只存在于
   CaptureContent、不进日志；扫描 research.db/WAL/SHM/Research 文件/隔离
   userData 零命中）→ finally 精确释放 task Tab + 关闭库 + 清理隔离目录 +
   用户 Tab 集合不变。
4. 全量回归 + 红线扫描。

## 验收标准

- §5.1/§5.2 全部规则单测（决议 #124–#130）+ 冒烟 8.16 双场景通过；
- 未验证引用不渲染/不进集合/不落库（单测 + 冒烟断言）；
- capture 正文零落盘（存储探针字节级）；Evidence 元数据全部主进程生成。

## 具体验证命令和期望结果

- `npm test -- --maxWorkers=1` → 全量绿；
- `npm run typecheck` / `npm run lint` / `npm run format:check` /
  `npm run build` / `git diff --check` → 全部退出码 0；
- dev + 生产冒烟默认矩阵（含 8.16）退出码 0。

## 完成定义

红→绿证据回填 + 8.16 双场景通过 + 全量验证全绿 + diff 终检 + progress.md
更新 + 逻辑提交（docs: 裁决 C4 Capture 与 Evidence 验证契约 +
feat: 完成 C4 多源捕获与 Evidence 确定性验证）+ 双远程推送。

## 风险与停止条件

- PageSnapshot 结构不支持表格坐标/字段路径提取 → 停止并报告（不得新建
  采集通道绕过；重新评估 locator 设计走 §15 决议流程）——已排除：快照
  tables/headings/links 结构支持 tableIndex/row/col 与闭合字段路径
  （决议 #128/#129）。
- 规范化匹配误判（正当摘录被拒）→ 校准规范化函数与测试（不放宽到
  「包含即通过」；语义层残余风险维持 threat-model §5 登记）。

## 提交边界

逻辑提交；不夹带 Runtime/综合层代码。冒烟 8.16 场景可与主体同提交或独立
提交（本任务建议两个逻辑提交：契约裁决文档 → 实现+测试+冒烟）。

## 红→绿证据

- **红态**（模块不存在/旧结构，2026-08-16）：
  - capture-service.test.ts + evidence-validator.test.ts：2 个测试文件整体
    失败（导入错误——模块尚不存在）；
  - research-repository.test.ts：tableIndex 相关 **13 failed / 42 passed**
    （旧 parseLocatorJson 忽略 tableIndex 字段：缺失/负数/字符串 tableIndex
    被静默放行、合法 tableIndex 写入/读回丢失——决议 #129 红态成立）。
- **转绿**：实现 capture-service.ts（最小端口/重试矩阵/sentinel/
  CaptureContent 60k 预算与哈希覆盖）+ evidence-validator.ts（六字段
  proposal 白名单/十三错误码/tableIndex/字段路径闭合白名单/幂等）+
  repository 严格 tableIndex 解析后——C4 聚焦 **136/136**；全量
  **1691/1691**（基线 1598 + 93 新增；既有用例零删除零削弱——#115 用例
  按 #129 契约机械校准 tableIndex 必填）。
- **冒烟 8.16**：dev 与生产双场景经真实 ResearchWorkspace +
  CaptureService + BrowserController 读取受控页（多章节/两表格/heading/
  link 字段）——capture 记录断言（实际 documentId 与对照 Tab 首次导航
  世代一致/accessTime 位于读取时间窗口/hash/summary/tableIndex）；确定性
  proposal（零 Provider 调用）：正确 quote/table-cell(tableIndex=1)
  verified、伪造摘录/错绑 candidate/tableIndex 越界 rejected；失败 URL
  （127.0.0.1:1）page-load-failed 重试 2 次尝试后**继续读取下一候选成功**
  （C4 内不改 failedReadCount）；2 条 capture 元数据 + 2 条
  VerifiedEvidence 写入临时 research.db 读回恒等（rejected 零落库）；
  正文零持久化探针：CAPTURE-PROBE 拆散节点标记在原始响应零命中、仅存在于
  捕获内存，扫描 research.db/-wal/-shm/隔离目录/隔离 userData research
  目录全部零命中；finally 精确释放 task Tab + 关闭库 + 清理隔离目录 +
  用户 Tab 集合不变。
- **冒烟实测发现的契约缺口 → 决议 #131（Chromium 错误页判定）**：加载
  失败后 Chromium 内建错误页自身完成 did-finish-load 把 tab 状态从 error
  翻回 ready（实测翻转窗口约 8ms < 轮询间隔 50ms——error 快速失败路径
  捕捉不到），错误页快照被误判为成功读取（首次 8.16 冒烟失败实证）。探针
  实测错误页快照特征：url=chrome-error://chromewebdata/、title=失败 URL、
  L0/集合全空、documentId 世代不变。冻结判定：快照最终 URL 校验失败时
  chrome-error:// 前缀 → page-load-failed（可重试），其余非法目标 →
  http-scheme-rejected（不重试）；单测固化。
- **冒烟夹具缺陷修复（如实记录）**：首轮 8.16 复用步骤 7 已关闭的受控页
  服务器 → 场景自建自关后通过；对照快照在 read 返回后 Tab 已 release →
  改为场景自建对照 Tab（首次导航世代与 Workspace Tab 一致）精确对照。
- 验证命令：`npm test -- --maxWorkers=1` **1691/1691** 绿；typecheck/
  lint/format:check/build/diff-check 绿；dev + 生产默认冒烟（含 8.16）
  退出码 0。

---

## Post-Acceptance Repair（2026-08-20，C4 修复链）

> C4 完成验收后，8.20 独立复核把 Capture 编译语义收严为正式契约。
> 本节是 Repair A/B 的唯一执行契约源；完整契约冻结见 detailed-design §15
> 决议 #173 与 §5.1/§5.2、threat-model §3.3/§3.4。

### Repair 链基线（已核实，不可改写）

- 当前 C4 chain：`65fe15d → f681451 → 56ea5c4 → e2404d0`
  （均为 fix: 候选提交，未 push）。
- Repair A baseline = `e2404d07c18c1d9acbe92b080f89f0cbec5cffa1`（HEAD，
  parent `56ea5c48...`）。
- 原 Repair baseline = `383658705a9bedcd0f95c0a8e2d448a849cb852e`；
  gitee/github `main` 均仍为该 SHA。
- 隔离分支 `codex/workflow-handoff-prompts@a7d1f5a` 不属于 C4：不 merge、
  不 cherry-pick、不 push。
- 禁止 reset / revert / rebase / amend / rewrite history / push。

### Repair A（docs-only 正式契约冻结）——**已完成候选**

- **范围**：仅允许修改 `doc/stage5/detailed-design.md`、
  `doc/stage5/threat-model.md`、本文件（出现第四个 tracked 文件修改即停）。
- **内容**：冻结决议 #173——typed-unit 三阶段模型、serialization grammar、
  eligibility、budget rejection、retained-prefix / global stop、
  visible-only partial、atomic heading/table/link/field、UTF-16 budget、
  surrogate 规则、empty / whitespace、table geometry、empty cell Evidence
  fail-closed、empty header → null、scalar fields 顺序、summary 来源、
  public CaptureContent 五字段不变、hash / 60k / Evidence 三通道不变。
- **Repair A candidate ≠ PASS**：只有新的独立 Reviewer A 给出 PASS 后，
  才允许进入 Repair B。

### Repair B（typed-unit compiler 收紧实现）——**未开始，禁止提前执行**

- 目标：按决议 #173 收紧实现，使代码与正式契约一致。
- **empty table-cell 红态 oracle**：`realCell === ''`（页面显式空/纯空白·
  控制/bidi 清理后变空/normalize 短行补齐的 `''`）的 table-cell 提案
  （excerpt:'' / value:'' / 仅其一为空 / 二者均 null）必须 red-fail →
  修复后 `value-invalid`（既有 EvidenceRejectionCode，不新增公共错误码），
  不得组装 VerifiedEvidence。
- **field 通道**：empty cell 不进入 fields，对应 fieldPath 恒
  `field-path-invalid`（e2404d0 已具备，仅需保持 + 测试固化）。
- **empty header**：保留几何占位；验证非空 cell 时输出 `locator.header =
null`。
- **table geometry / hash**：retained table unit 仍受 canonicalText/
  contentHash 覆盖；hash coverage 不证明页面显式声明空值，也不区分显式
  空值与 normalize padding。
- **all-empty table**：整体跳过，不产生 canonical/table/textSection/field/
  Evidence（e2404d0 已具备，保持）。
- **禁止**：新增 Evidence kind / locator 字段 / 公共 error code / 公共
  类型；不得以空字符串或 sentinel 实现 absence/missing Evidence（如需
  absence 语义必须单独 REPLAN 新的 typed evidence/provenance 模型）；
  不得修改 snapshot pipeline / Result Schema / Renderer / Repository /
  持久化。
- **Repair B baseline**：仅当 Reviewer A 对 Repair A candidate 输出 PASS
  后，该精确 candidate SHA 才成为 Repair B baseline。

### Reviewer gate（独立 Reviewer A）

- 对 Repair A candidate 独立审查 `baseline..HEAD`，结论只可为
  PASS / REPAIR / REPLAN / BLOCKED。
- **DOC_GATE_SHA 规则**：Repair A candidate 的精确 SHA 记作
  `DOC_GATE_SHA`；Reviewer A PASS 前不得 push、不得开始 Repair B。
  Reviewer A PASS 后，`DOC_GATE_SHA` 即 Repair B 的唯一 baseline；
  若后续 repair 提交发生（B/C…），每个新 gate 都须记录其精确 SHA。
- Review 输出必须含实际命令与退出码；不采信 Executor 自述「全绿」。

### 实现事实与目标契约的区分（Repair B 前必须如实登记）

- **当前实现事实（e2404d0）**：table-cell 空值通道为 **fail-open**
  ——`realCell === ''` 可与空 proposal 匹配并返回 verified；field 通道因
  empty cell 不进入 fields 而 fail-closed。
- **目标契约（决议 #173）**：empty table-cell 一律 fail-closed
  （`value-invalid`），任何空值组合不组装 VerifiedEvidence。
- 以上差异是 Repair B 的已知实现缺口，**不得写成已实现**；Repair A
  docs-only 不修改代码或测试。

### Repair 链验证

- Repair A：文档一致性搜索、`npm run format:check`、`git diff --check
e2404d07c18c1d9acbe92b080f89f0cbec5cffa1..HEAD`、
  `git diff --name-status`、`git status --short --branch`、敏感/临时文件
  扫描。build / Electron smoke / 真实 Provider：docs-only gate N/A。
- Repair B：聚焦 red→green（empty cell oracle）+ 全量 test + typecheck +
  lint + format:check + diff-check + 既有 C4 8.16 冒烟回归；不得把现有
  测试全绿冒充 empty-cell 目标语义已实现。
- 不执行 C10、8.19-B 修复、Closer 或 Sixth Stage。

### Post-Acceptance Repair 状态 —— **已审核 PASS / 已收尾（2026-08-21）**

> 本小节由独立 Reviewer B 对 Repair 链 `3836587..4c75a86` 出具最终 **PASS**
> 后，由 Closer 完成确定性收尾登记与双远程推送。候选阶段状态已关闭。

- **Repair 链最终 HEAD = `4c75a86b7b9d9fd3020a5af7be5fc4e29021efdf`**
  （parent `abe7351972b5881fc4357aacf0e0f2be822b887e`）；链
  `65fe15d → f681451 → 56ea5c4 → e2404d0 → f38fb4d → abe7351 → 4c75a86`
  连续单父历史，悬挂于原 Repair baseline `3836587`。
- **候选状态 → 已推送**：C4 Repair 链 `65fe15d…4c75a86` + closure docs
  提交经双远程 push，Gitee/GitHub `main` 均已前进至新 HEAD；隔离分支
  `codex/workflow-handoff-prompts`（`2525d8d`）未被动过。
- **四项验收（独立 Reviewer B 最终 PASS，2026-08-21）**：
  ① Repair A 文档 gate（契约冻结 #173 落 detailed-design/threat-model/
  本文件）PASS；② Repair B implementation（empty table-cell 一律
  fail-closed → `value-invalid`，不组装 VerifiedEvidence；field 通道
  `field-path-invalid`；empty header 保留几何占位、`locator.header =
null`；all-empty table 整体跳过；retained unit 仍受 canonicalText/
  contentHash 覆盖）PASS；③ surrogate coverage Repair（4c75a86 补全
  surrogate admission 边界）PASS；④ filesystem cleanup（工作区已核验
  空目录清理，无残留）PASS。
- **NOT RUN（已获 Reviewer 豁免，不得视为已运行）**：focused/full tests、
  typecheck、lint、build、dev/production smoke、Research smoke、真实
  Provider。理由：本次 Repair 仅删除工作区已核验空目录，产品 HEAD 与
  tracked tree 与已完成独立产品验证的 `4c75a86` 完全相同。
- **下一唯一任务**：C10（Fifth Stage 独立最终验收 / Exit Gate / Stage
  Auditor，见 `doc/stage5/tasks/C10-finalize-acceptance.md`），须由新的
  独立 Codex GPT-5.6 Sol 上下文执行。

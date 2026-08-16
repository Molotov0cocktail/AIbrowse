# AIbrowse 第五阶段 高层设计（多源 Research、证据链与结构化展示）

> 本文件是第五阶段高层设计：架构/决策/模块/数据流/安全模型/存储/测试/风险。
> **接口契约唯一来源是 `doc/stage5/detailed-design.md`**（本文件不复制签名细节）；
> 安全契约源 `doc/stage5/threat-model.md`（FT-01～FT-17 / FRT-01～FRT-12）。
> 需求源 `Fifth_stage.md`（根目录，需求边界不被本设计削弱）；任务 C1–C10 见
> `doc/stage5/tasks/`；决策表见 `doc/stage5/proposal.md` §10（D1–D13）。

## 1. 架构总览

第五阶段新增一条**主进程专属**的 Research 数据链，正交复用既有 Agent 工具管线
与 Sources 数据链（不复用、不改造 AgentLoop）：

```
（新增）Research UI（渲染进程，C8）
   ├─ 侧栏 ResearchPanel：任务创建/启动/停止/进度/历史（380px 同模式）
   └─ 大结果画布（主窗口内 viewMode 切换，不新开 BrowserWindow）
   └─ IPC（sender+主帧校验）→ 主进程 ResearchService ←──────────────┐
                                                                    │
ResearchService（任务编排唯一入口，主进程）                            │
   ├─ ResearchRuntime（纯编排状态机，零 Electron import，C5）         │
   │     ├─ SourceSelector（候选合并/排序纯函数，C3）                 │
   │     ├─ ResearchWorkspace（task-owned Tab 所有权，C2）            │
   │     ├─ CaptureService（读取/提取/capture 记录，C4）              │
   │     ├─ EvidenceValidator（证据确定性验证纯函数，C4）             │
   │     └─ ResultValidator（Result Schema 验证纯函数，C7）           │
   ├─ 既有能力复用：                                                 │
   │     ├─ SourceService（source_search/list/get，audience='agent'）│
   │     ├─ SearchProvider（search_web 语义）                        │
   │     ├─ BrowserController（getPageSnapshot 实时采集/打开 Tab）    │
   │     └─ LLMProvider（模型轮，ProviderRequest 复用）               │
   └─ ResearchRepository（research.db 唯一 SQL 执行点，C1）           │
        └─ sqlite-driver 模式复用（node:sqlite 冻结，决议 #48）       │
                                                                    │
Renderer（渲染层纯组件，C7）——只消费已验证 Result Schema；             │
   不得访问 BrowserController、SQLite、Electron 或 Provider           │
```

- **依赖方向固定不可反向**：`Research UI → ResearchService → ResearchRuntime →
SourceSelector / ResearchWorkspace / EvidenceValidator / ResultValidator →
SourceService / BrowserController / SearchProvider / LLMProvider →
ResearchRepository`。Renderer 只消费已验证 Result Schema。
- **Research 工具只经受限服务执行**：不新增 shell/eval/任意 JS/任意文件/任意
  网络/任意 SQL 工具；读取复用既有 `browser_read` 语义（L0），打开复用
  `browser_open`（L1 既有权限）；无「关闭用户 Tab」工具。
- 纯核心（候选合并/排序、状态机、Evidence 验证、Result 校验、预算裁剪、
  Markdown 解析）零 Electron 依赖可单测；SQLite 打开/关闭/迁移为薄胶水层
  （复用 B1/B7 模式）。

## 2. 关键技术决策（摘要；完整决策表见 proposal §10）

| #   | 决策                                                                                                         | 一句话理由                                          |
| --- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| D1  | 单一专用 ResearchRuntime，不做多 Agent 编排                                                                  | 最小可审计闭环；接口预留替换点                      |
| D2  | 独立有界 Runtime，不复用/不改 AgentLoop（12 步/420s 冻结契约）                                               | Fifth_stage.md §4 明令禁止共用无限复杂循环          |
| D3  | 持久化元数据 + 验证后 Evidence + 最终 Result；不持久化完整快照/模型思维/无限 transcript；v1 不承诺跨重启续跑 | 隐私 + P2-3 无界增长教训；重启标 interrupted 可重跑 |
| D4  | task-owned 专用 Tab + 精确 tabId 所有权；并发 ≤3；用户 Tab 永不关闭                                          | 决议 #32 模式延续；Fifth_stage.md §3.3              |
| D5  | Evidence 锚点：模型只提引用，确定性程序验证（来源存在/捕获归属/excerpt 与坐标来自捕获内容）                  | 未验证引用不得渲染为证据                            |
| D6  | 同 URL 候选合并身份 + 保留双发现路径；收藏/备注 ≠ 可信；trust 三元组继承                                     | Fifth_stage.md §3.2                                 |
| D7  | Claim/Coverage/sourceTypes/Conflict/Uncertainty 进数据模型；禁止数量代质量、虚构百分比                       | Fifth_stage.md §3.5/§5                              |
| D8  | Result Schema 闭合判别联合 + 字段白名单；Markdown/Table/Cards/Ranking 进 v1；Timeline/Chart 延期             | 模型不得生成任意 HTML/CSS/JS                        |
| D9  | 自实现受控 Markdown 子集渲染器（零新依赖；官方资料核查见 proposal §5）                                       | 模型输出视为敌手；raw HTML 关闭；URL 仅 http/https  |
| D10 | 侧栏控制/进度 + 主窗口内独立大结果画布（不新开窗口）                                                         | 380px 侧栏不适合复杂表格；长期 UI 决策              |
| D11 | Table 排序/筛选/来源详情/复制 + CSV（主进程 dialog 安全通道 + 公式注入防护）                                 | §3.7 必做 + 导出防护                                |
| D12 | 确定性预算全表（编译期常量 + 可注入 + 测试断言）                                                             | 「有界」必须可机器验证                              |
| D13 | 编号：C1–C10 / FT-01～FT-17 / FRT-01～FRT-12 / 决议 #94 起 / 冒烟 8.16 起                                    | 历史编号零冲突                                      |

## 3. 模块职责

| 模块（新）          | 文件（规划）                                        | 职责 / 边界                                                                                          | 任务                                  |
| ------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Research 域类型     | src/shared/types/research.ts                        | ResearchTask/Evidence/Claim/Conflict/ResearchResult/预算常量/错误码（单一事实源，renderer 复用）     | C1                                    |
| 状态机纯函数        | src/main/research/domain/research-task-state.ts     | 状态迁移纯函数（created→running→completed/failed/cancelled/interrupted；phase 子相位）               | C1                                    |
| 预算纯函数          | src/main/research/domain/research-budget.ts         | 全部确定性预算常量与裁剪函数（字符预算/轮次回放/结果字节）                                           | C1                                    |
| ResearchRepository  | src/main/research/repository/research-repository.ts | research.db **唯一 SQL 执行点**（编译期常量 + 参数绑定）；tasks/evidence/claims/results 表           | C1                                    |
| research-store 装配 | src/main/research/research-store.ts                 | 启动装配（probe→迁移→检查→normal                                                                     | unavailable；模式复用 sources-store） | C1  |
| ResearchService     | src/main/research/research-service.ts               | 任务生命周期编排唯一入口：createTask/start/stop/getTask/getResult/listTasks/deleteTask               | C1/C5                                 |
| ResearchWorkspace   | src/main/research/research-workspace.ts             | task-owned Tab 所有权：精确 tabId、并发 ≤3、try/finally 清理、用户 Tab 永不关闭、用户关 Tab 处理     | C2                                    |
| SourceSelector      | src/main/research/source-selector.ts                | 候选合并（normalizeSourceUrl 身份键 + discoveredVia 双路径）+ provenance 继承 + 确定性排序（纯函数） | C3                                    |
| CaptureService      | src/main/research/capture-service.ts                | 打开/读取 task Tab（实时快照）、结构化提取（表格/字段）、capture 记录（哈希/摘要/不持久化正文）      | C4                                    |
| EvidenceValidator   | src/main/research/evidence-validator.ts             | 证据确定性验证纯函数：来源存在/捕获归属/excerpt 规范化匹配/表格坐标边界                              | C4                                    |
| ResearchRuntime     | src/main/research/research-runtime.ts               | 独立有界编排状态机（纯核心零 Electron import）：阶段循环/进度/停止/失败继续/预算/终态单一所有权      | C5                                    |
| 综合层              | src/main/research/synthesis/                        | Cross-check 数据模型装配 + 合成提示词构建（Claim/Conflict/Uncertainty）                              | C6                                    |
| ResultValidator     | src/main/research/result-validator.ts               | Result Schema 逐块校验纯函数（结构/长度/evidenceId 存在/URL 安全/表格行列界）                        | C7                                    |
| Renderer            | src/renderer/src/research/                          | Markdown 安全子集解析纯函数 + Table/Cards/Ranking 组件 + Evidence 下钻；零 Electron import           | C7                                    |
| Research IPC 适配器 | src/main/research/research-ipc.ts                   | research:* 通道适配器（参数白名单/状态门控/审计；零 Electron import）                                | C8                                    |
| Research UI         | src/renderer/src/research/ + App viewMode           | 侧栏控制/进度 + 大结果画布 + 表格排序/筛选/复制 + CSV 导出触发                                       | C8                                    |

既有模块扩展点（本会话代码核对确认）：`ToolExecutionContext` 无需扩展（Research
不经 ToolRegistry——读取/打开走 ResearchService 直调 BrowserController/
SourceService/SearchProvider，权限语义沿用对应工具契约）；`index.ts` 装配新增
ResearchService 与 IPC 通道注册；preload bridge 白名单新增 research 方法；
`App.tsx` 新增 viewMode 与 ResearchPanel。

## 4. 数据流（关键路径）

### 4.1 任务创建与启动（C1/C5）

```
UI research:create {goal} → IPC（sender+主帧校验；goal 校验/截断 ≤2000）
→ ResearchService.createTask：状态机 created + 任务元数据落 research.db
→ UI research:start {taskId}（单 running 任务互斥；Sources 库 normal 态前置）
→ ResearchRuntime.run(taskId, goal)：
   阶段 1 planning：SourceSelector 候选（Sources 检索 ≤10 + Search ≤10 合并
     → 排序 → 选定 ≤8）→ 模型轮确认选择意图（可选）
   阶段 2 reading：逐来源 CaptureService 打开/读取/提取（task Tab 所有权；
     失败标记继续）→ 模型提出 Evidence 引用 → EvidenceValidator 验证
   阶段 3 verifying：模型提出 claims → 覆盖/冲突数据模型装配
   阶段 4 synthesizing：模型产出 Result Schema 草案 → ResultValidator
     → 持久化 Result + 终态 completed
→ 进度事件（research:progress：phase/stats/步骤计数——确定性运行事实，无思维过程）
```

### 4.2 候选合并与排序（C3，纯函数）

```
输入：SourceService.search/list（audience='agent'，硬上限 10/每页 20）
    + SearchProvider.search（≤10 条结果）
→ normalizeSourceUrl 生成身份键（origin/page 语义）
→ 同键合并：候选 { url, title, canonicalKey, scope, discoveredVia: ['sources'|'search'],
    sourceId?, trust?（Sources 命中才携带三元组）, priority?, note?（仅 UI 展示不进模型） }
→ 排序（确定性全序，档位不可跨档）：
    档位 1 收藏命中且 trust.assertedBy='user'（用户标定优先）
    档位 2 收藏命中（ai 断言/unknown）
    档位 3 官方/primary（trust.value 且 verification='asserted'）
    档位 4 搜索命中（无 trust 断言）
    档位 5 其余（community/secondary/unknown）
    同档内：priority 降序 → lastUsedAt 降序（null 末位）→ canonicalKey → id
→ 选定 ≤ MAX_SELECTED_SOURCES（8）
```

### 4.3 多源读取与 Evidence 验证（C4）

```
CaptureService.read(candidate)：
  task Tab 精确 tabId（Workspace 分配）→ loadURL（http/https 白名单）
  → getPageSnapshot 实时采集（browser_read 语义；L0/L1/L2 降级阶梯沿用）
  → 结构化提取（表格行列/可见文本章节——快照结构为准）
  → capture 记录 { captureId, candidateId, tabId, url, title, accessTime,
      documentId, contentHash, summary, failed? }（正文不持久化；内存保留至任务终态）
模型提议 evidence { captureId, type, locator, excerpt } →
EvidenceValidator.verify(proposal, captures, task)：
  ① captureId ∈ 本任务捕获集（归属校验）
  ② 来源存在（candidateId → capture.url 一致）
  ③ excerpt 规范化（trim/NFC/控制字符/空白折叠）后 ⊆ capture 对应章节规范化文本
  ④ table locator：row/col 边界 + 单元格值匹配；field locator：字段路径存在
→ verified 才写入 Evidence 集合；rejected 回注模型修正；未验证不渲染
```

### 4.4 Cross-check 与综合（C6）

```
模型产出 claims（含 severity/sourceTypes/引用 evidenceId）→ 确定性程序：
  ① evidenceId 存在性与归属校验（同 EvidenceValidator）
  ② coverage 计算：claim 引用的不同 canonicalKey 来源数（≥2 = multi-source）
  ③ sourceTypes 分类：候选 trust.value='official' 或厂商域判定 → vendor；
     第三方（trust primary/secondary 或非厂商域）→ third-party
  ④ 冲突：同主题 claims 文本相异（模型提出冲突对）→ Conflict 数据模型
     （positions + sourceRefs；不自动裁决、不静默抹平）
  ⑤ 证据不足 → Uncertainty 块（正式输出类型：「不确定」+ 原因 + 已知边界）
→ 综合提示词（AGENT_RESEARCH_SYNTHESIS_PROMPT 编译期常量 + UNTRUSTED 块
  回注 capture 摘录/Evidence/候选元数据——全部经既有块转义纪律）
→ Result Schema 草案 → ResultValidator → 持久化
```

### 4.5 停止/取消/终态（C5）

```
UI research:stop {taskId} → ResearchService.stop：
  abort 模型流 + Workspace 作废 pending 确认（Research v1 无 L2 确认工具，
    仅既有 browser_open L1 展示——复用确认管线时同样作废）
  → 只关本任务创建的 Tab（用户 Tab 永不关闭）
  → 状态 cancelled（部分 Evidence/Result 草案不持久化为最终 Result）
进程退出/崩溃 → 运行中任务下次启动装配时标 interrupted（可重新开始，不自动续跑）
终态单一所有权（finish() 守卫 + 迟到事件忽略——沿用 A5 决议 #33 模式）
```

## 5. 安全模型（概要，契约源 doc/stage5/threat-model.md）

- **继承**：第三阶段五层防线（结构/能力/决策/审计/运行时）与四类残余风险、
  第四阶段 Sources 六类残余风险全部保持；Source 数据与网页内容同等视为
  不可信输入（UNTRUSTED 块）。
- **新增五条主线**：
  1. 引用验证：模型只能提议 Evidence/Claim，来源存在性、捕获归属、摘录真实
     性、坐标边界由确定性程序验证（FT-03/04/05/06）；
  2. provenance 诚实：候选合并保留发现路径，trust 三元组继承，收藏/备注
     不等同可信（FT-07）；冲突显式保留不抹平（FT-08）；
  3. 有界性：全部预算编译期常量 + 运行时裁剪断言（FT-10）；
  4. 输出安全：Result Schema 白名单 + ResultValidator + raw HTML 关闭 +
     URL 白名单 + CSV 公式注入防护（FT-11/12/13）；
  5. 持久化最小化：capture 正文/模型思维/完整 transcript 不落盘；Research 库
     独立字节预算；日志仅元数据（FT-14/15/16）。
- **威胁与红队**：FT-01～FT-17 威胁枚举 + FRT-01～FRT-12 红队矩阵（C9 实施）；
  安全结论分「机器可证明」「观察性结果」「不承诺」三类（同第四阶段纪律）。

## 6. 存储

| 存储            | 位置（主进程 userData 下）               | 内容 / 边界                                                                                                                                                                    |
| --------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Research 数据库 | `research/research.db`（C1 定稿）        | tasks（元数据/状态/统计）/evidence（验证后）/claims（含 conflicts）/results（Result JSON）；单任务持久化 ≤500k 字符、保留任务 ≤30 个（最旧清理，UI 明示）；v1 本地明文如实说明 |
| capture 正文    | **不持久化**（运行期内存，任务终态丢弃） | 内容哈希 + 摘要元数据进 capture 记录；完整正文/快照/transcript/模型思维零落盘                                                                                                  |
| 会话/凭据/配置  | 既有路径（不变）                         | 会话 JSON 仅挂 taskId 引用（Research 数据不进会话文件）                                                                                                                        |
| 审计            | 既有 logger（不变）                      | research 操作脱敏条目（goal 长度/任务 id/阶段/统计；URL 值零出现、Evidence 摘录零出现）                                                                                        |
| CSV 导出        | 用户选定路径（dialog 安全通道）          | 仅 Result Table 块内容；公式注入防护 + BOM + CRLF 转义；不导出 Evidence 摘录正文                                                                                               |

- Research 数据库、备份、capture 正文**不进入模型上下文**（除经捕获内容
  块按预算回注的受控摘录）。
- API Key 绝不进入 Research 数据库（红线 grep 断言）。

## 7. 测试策略

- **单测（Vitest，node 环境）**：状态机迁移矩阵、候选合并/排序全序、预算裁剪
  边界、EvidenceValidator 敌手矩阵（伪造/错绑/坐标越界）、ResultValidator
  敌手矩阵（非法块/超长/伪造 id/危险 URL）、Markdown 解析与转义、CSV 序列化
  （公式注入/CRLF/BOM）、Repository 真实 node:sqlite（编译期 SQL + 参数绑定）——
  纯核心零环境依赖；Electron 行为由冒烟覆盖。
- **冒烟（Electron 真实启动，临时 userData；dev+生产双场景）**：C4 capture/
  evidence 场景 8.16、C5 Runtime 场景 8.17、C6 综合场景 8.18、C8 UI DOM 场景
  8.19、C9 红队 FRT-01～FRT-12 场景 8.20（新场景编号独立、断言不重复完整
  运行既有矩阵——延续决议 #93 纪律，不显著加重默认矩阵）。
- **真实 Provider 验证（C9）**：真实主题多源 Research 端到端 + 真实
  敌对页观察场景（沿用凭据流程，新门控 `AIBROWSE_LIVE_RESEARCH=1` + harness
  开关，与既有 LIVE 门控互斥）。**2026-08-16 起真实 Provider 已获长期授权**
  （决议 #117）：凭据可用即执行、无需逐次申请授权；凭据/服务不可用如实
  记录「凭据不可用/NOT RUN」，不阻塞离线 C9。
- **跨进程持久化**：沿用 AIBROWSE_SOURCES_SMOKE 同模式双进程验证（task
  元数据/evidence/result 写后读回；interrupted 标记路径）。

## 8. 风险与不确定性

- **模型输出质量（最大不确定性）**：多轮 Research 依赖真实模型遵守
  「只提引用不伪造」——结构性验证（EvidenceValidator/ResultValidator）保证
  伪造/错绑无法通过，但模型**不提出足够引用**时结论覆盖度低 → 如实输出
  Uncertainty 块（不虚构）；语义层残余风险维持 threat-model 登记，不宣称
  免疫。
- **搜索结果质量**：SearchProvider snippet 恒空（A4 计划内限制）——候选排序
  不依赖 snippet；capture 阶段生成受控摘要兜底；真实主题验收需容忍公开
  网页结构变化（C9 前置断言模式沿用 S6 表格页教训）。
- **Markdown 子集范围**：自实现解析器覆盖 Research 结果需求（标题/强调/
  列表/引用/代码/链接/表格）；超出子集的合法输入安全降级为纯文本（不丢内容、
  不加特权）；未来需求变化经渲染器接口隔离评估 react-markdown（proposal §5
  备选记录在案）。
- **运行时预算与模型行为的张力**：24 轮/64 步/30 分钟可能不足以完成复杂主题
  → 预算用尽为**正式终态**（failed: budget-exhausted + 已收集 Evidence 保留），
  不自动扩预算；用户可调整目标重新开始。
- 依赖与风险逐项落点见 detailed-design §13/§14 与各任务文档「风险与停止条件」。

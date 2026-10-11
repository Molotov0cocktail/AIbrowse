# 遗留问题修复（2026-10-12）

## 实施合同

- TASK / GOAL：响应用户“请尝试修复所有的遗留问题，若难以修复则停下来汇报”，先核对当前实际遗留，再修复可明确定位的缺陷；遇到困难或产品取舍即停止并报告，不无界扩充验证。
- BASELINE：`main / 9083172b0d0848e62a78c4b7c03c697a81470572`，接管工作区干净。该版本已含 UI 深浅主题；`output/` 仍为旧 FIRST，二者身份分开。
- AUTHORITATIVE SOURCES：用户本次授权、`AGENTS.md`、Stage6 页面 locator / Digest 契约、Stage5 Research 候选与输出契约、`doc/stage7/tasks.md` 阶段后扩展回归节和 `doc/stage7/threat-model.md` §8。
- CURRENT VERIFIED STATE：Session 预览同源跨页面 Baseline 的 P1 已有实际场景与源码证据；Watch reasoning 拒绝为静态兼容风险；Research 目标文本 URL 不自动成为候选，曾出现零证据任务完成；长时句柄超限等已有用户接受风险，根因未证。不能把所有历史 FAIL/NOT RUN 都当成未修复缺陷。
- NON-GOALS：不启动 Stage8，不新增任意 URL/网络/SQL/模型权限，不改隐私承诺，不删除历史错误事件或真实数据，不重放不受影响的全套安装、性能或真实网站矩阵。
- FIXED DECISIONS / INVARIANTS：Session 预览、表格发现与正式采集须核对完整 canonical 页面定位（path 与有效 query，允许 fragment/默认端口规范化）；拒绝不能产生可消费预览、授权或 Baseline。保留默认拒绝、task-owned Tab、正文与 query 不额外落盘。AI 解释不能改写确定性事实。
- EXPECTED SCOPE：先并行调查 Watch 预览/命令、Digest Provider 流处理、Research 来源提示及已接受风险；实现限于确认根因的受影响模块和反例测试。必要设计差量由根协调维护，写者文件边界明确。
- IMPLEMENTATION PLAN：核对当前代码与证据 → 冻结每项最小修复 → 可甄别红态 → 修复与聚焦回归 → 安全/隐私/持久化新独立审核 → 必要 build/真实 Electron 冒烟 → 汇报已修与保留项。
- TEST PLAN：错 path/query、读取中跳转、正确 URL 规范化、预览消费与 create/rebaseline；reasoning 与有效最终 JSON、非法工具输出、输出预算及零 reasoning 持久化；Research 入口与零证据提示。先聚焦、再相关模块回归与静态检查；真实 Provider 仅在有明确验证价值及安全凭据通道时有界使用，不能用 Fake 冒充。
- ACCEPTANCE：每个已修项都有可区分旧实现的证据及适用审核；未修/未证项及困难明确列出。产品代码、运行构建与安装包分别报告，不把源码通过称为旧包已修复。
- STOP OR REPLAN：单条路线连续两轮无新增证据、根因不能在有界检查中定位、需要产品取舍/用户数据不可逆处理/外部条件时停止修复并集中汇报。用户明确要求遇难停报，本轮不自动延长为新一轮性能取证或新平台兼容工程。
- 交付：当前授权允许制作和验证修复候选，替代历史“不得修改源码/重建候选”的本轮限制；保留旧 FIRST 与失败证据。仅在新候选适用验证通过且不存在本轮困难阻塞后更新选定 `output/`；不得将未知风险改判 PASS。

## 当前问题核对与结果

| 项目                         | 核对结论与本轮边界                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Watch Session 归属 P1        | 根因是预览和表格发现只比较 origin；修复完整 locator 读前/后核对、实际读取摘要、授权与命令消费复验。只改 preview/command 及对应测试，不改数据库和 IPC。                                                                                                 |
| Digest reasoning 兼容        | 思考增量误判非法输出；直接丢弃并继续严格校验最终 JSON，保留 toolCalls、done 和正文预算拒绝。                                                                                                                                                           |
| Research 来源/零证据提示     | 已确认目标 URL 不是现有候选入口，零候选 completed 属于明确降级契约。补确定性入口与无证据提示，不把提示改进称为直接 URL 采集已实现。                                                                                                                    |
| Research 工具 reasoning 回传 | 当前正式决议要求完全丢弃；特定 Provider 兼容尚未真实证明。涉及有界内存回传与正式契约调整，不在已明确局部修复外继续扩展，保留未证项。                                                                                                                   |
| 长时句柄增长                 | 旧固定实体场 60.91778813409878/h，阈值 60/h；已读 `log/stage7-e4/actual-supplement-independent-review-001/report.md`，增长分散于 Utility/Browser/Tab/GPU，缺类型与分配归属。难以据此定位可修源码，按用户要求在局部修复验证后停止，不新增长测或放宽门。 |
| 旧错误 Baseline/Event        | 不读改真实用户库、不删除重算历史事件。query 脱敏后无法可靠识别所有旧错配；保持已知规则暂停，须正确目标的显式重新预览/建基线。不会声称代码修复已纠正旧数据。                                                                                            |
| P2-3 / P2-4 / O-1 陈旧登记   | 当前代码已有消息/会话字节预算、单 worker、UUID 路径校验及反例测试；按实核关闭陈旧开放登记，非本轮新增修复。                                                                                                                                            |
| 其它范围限制                 | 电池/独立 Windows/CI 未证、旧 fatal 根因 unknown、严格进程退出顺序未证和跨 run reasoning 不持久化继续如实保留；不是新发现且可通过局部代码修复的缺陷。                                                                                                  |

## 验证证据

- 原始日志统一保留 `log/legacy-repair-20261012/`；仅通用源码、反例测试、正式合同纳入 Git。
- Research 提示红态 4 FAIL / 26 PASS；修复后两文件 30/30，研究 renderer 六文件 74/74。正文前无证据提醒与正例、运行中/失败/取消不误报都有明确断言。
- Digest reasoning 有效 JSON 混合红态失败，修复后单文件 50/50；新增正文前/中/后 reasoning、数据库/WAL 零 canary、非法工具、done 后迟到事件、UTF-8 正文预算反例。真实 Provider 尚未调用。
- Watch P1 红态 19 FAIL / 14 PASS；修复后两文件 33/33，八个相关文件 143/143。首次 typecheck 因新测试 intervalMinutes 推宽为 number 失败，夹具改为字面量后全局 typecheck-002 exit 0；原失败保留，不改产品类型约束。
- 受影响 Watch、Research、renderer 与 Provider 集成回归：119 文件 / 2,378 项通过，exit 0，`affected-regression.txt`。全量 lint / format exit 0；新增 smoke 夹具后定点 lint、格式和全局 typecheck 另行 exit 0。普通 `npm run build` exit 0，`build.txt`。
- 新独立 `gpt-6-astra/xhigh` 安全/隐私/持久化 Reviewer 给出三项局部修复 PASS，实际模型未回显，身份不可验证；独立复跑 15 文件 / 267 项通过。`independent-review.md` SHA256 `563cacdeaf1b6df2966854437fddea1b0244dde0768eb8b965bbf63c6d00fb46`；后继 smoke 等价适配短审 PASS，`independent-smoke-addendum.md` SHA256 `3f1b90054b2fab4384688a2f060de676d49239a1e944576ad34d6461ced9baa1`。审核只覆盖本轮局部风险，不重开或冒称阶段最终验收。
- 默认 production Electron 冒烟首轮目录 `log/stage7-e2/default-smoke-production-d79c8b7dafce4e13ac6922776a4bbfac/`。03:37:37 Watch D9 场通过，03:37:41 全场 marker 与退出请求出现；03:37:46 仍有 `previewContext=1`、`conversation:preview=1`、main root / conversation producer 未排空。功能 marker 不是整轮通过；最终 outer exit 1、result/completion passed=false，整体 REPAIR。
- 原 600 秒总预算监督器在 wall 575315ms、work 575140ms 收口，应用分配预算 565391ms，报“固定验收超时；Job 已确认实际归零”。应用 exitCode=null，prepareJobZero=true、application jobZero=true；读回未启动，readbackJobZero=false 不代表已启动的读回进程泄漏。writer 账本仍有 main、utility=null，未满足退休条件；没有 production.readback.json。仅证明监督器回收了本场进程，不证明产品正常退出或冷态读回。零重试、零手工杀进程，未清计数或改旧 Promise。
- `result.json` SHA256 `d0b8895ae64317a382037a838b42094ba3a5d3f6e4deeb59aa6f3173ff461f63`；`completion.json` SHA256 `4b757113671961ec8da8fc11cff397b62de04bc1dd34ca671cba5d34c12020e7`；`production.result.json` SHA256 `38ab6bfb7d982f4a2008d84eff05b91646e479be41d3fba43a8377c839f71c65`。原始应用日志 SHA256 `13a3faa4336c8d49c27776beaf5cfacf21f5b949d4b569225512de44baeaff7b`，失败现场保留。
- 新独立退出补充审核判整轮 REPAIR，保留上述局部 PASS；`independent-exit-blocker-addendum.md` SHA256 `c1128efc29d5fe4a7eceb08e452124187051f35f0fbfc0a4e593d7e5685977b9`。本轮后继 44 场 UI 矩阵取消/NOT RUN；此前 UI 任务的通过不充作修复候选的新运行结果。

## 遇难停止与未解决项

用户“难以修复则停下来汇报”的停止条件已触发：本轮真实集成退出存在未结预览操作，加上旧句柄
增长仍无分配归属。完成局部修复后停止新增产品实现与所有后继 UI/Provider/性能运行，保留首轮原件；
已启动监督器已在原预算内结束并确认其拥有的应用 Job 归零。当前不更新 `output/`、不 push 候选完成状态。

本轮退出的一次只读核查：Conversation 已将 AbortSignal 传递给 BrowserController/PageReader；
排空会中止预览 controller 并等待原 Promise，readiness 和 deferred blank 有取消结算。PageReader
已派发的 `executeJavaScriptInIsolatedWorld` 要等原 transport 返回后才再次检查 abort。由此可提出
“已派发快照传输未返回”的排查假设，但日志没有请求、tab 与执行阶段的关联，尚不能定位本次精确
await、归因 Electron 或证明与本轮夹具的因果；三处采集/会话模块本轮零差量。不能用清空计数或假
完成来取得退出通过。若后继继续，需要针对实际未结操作补充有界定位并证明原生传输退休；本轮不擅自启动。

局部修复的反例与独立 PASS 继续成立，不外推为整轮、旧数据、真实 Provider 或新发行包通过。
当前普通 `out/` 是修复候选；`output/` 旧 FIRST 未变，EXE SHA256 复核仍为
`373f81b386ea1cd439b6f1b1d350b3e9dbd05f173879200796cbf83998693aea`。

本地候选提交：Watch `178e4d6ad21f518a942ad987543e486c12ae27cb`、Digest
`cd6c9aeb3b34efeeeb8480f48585728da4f62fad`、Research
`19a4db950482b6a57a3fcab0413f69a1b4ebd8a0`。三项代码均为上述已测/已审差量，
提交仅保存候选，不改变整轮 REPAIR。未 push 任一远程，文档收尾提交以 Git 为准。

## 默认冒烟夹具等价修订

准备集成验证时只读发现旧 `src/main/smoke.ts` 的 8.26-E2E 向导将 Source 的 path 改为随机地址，
却仍读取原活动页；该旧成功场依赖本轮纠正的同源跨页面行为。产品校验不能为旧夹具放宽。
因此将本场改为独立 loopback 服务和精确拥有的 Tab：先在同源不同路径分别验证正文/表格预览
`security-rejected` 且 PreviewStore 不新增，再只导航本场 Tab 到正确目标，继续原七步真实
React/preload/IPC 成功链。集合比较前关闭专属 Tab 并恢复原活动 Tab，finally 幂等兜底并关闭服务。
原 Tab 集合/URL/标题/活动项、隐私、条件、确认与导出断言保留；新增真实错页拒绝覆盖，验证实质增强。
这是受影响测试夹具修订，不新增产品功能；只读发现后尚未运行旧夹具，不编造其运行失败。

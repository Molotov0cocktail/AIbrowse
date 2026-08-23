# C10 — Fifth Stage 独立最终验收 + Exit Gate 判定 + 文档同步

> 第五阶段任务文档。验收清单 `Fifth_stage.md` §9；Exit Gate `Fifth_stage.md`
> §10；核对清单 `doc/stage5/detailed-design.md` §14。

## 目标

第五阶段独立最终验收：**不采信 C1–C9 完成报告**——在当前 HEAD 上重新独立
复验（步骤 0 全套：Git 三方一致/工作区干净/基线测试独立复跑），逐项核对
Fifth_stage.md §9 验收标准（五组 14 项）与 §10 Exit Gate（五项），复跑
冒烟全矩阵（含 8.16–8.20 与既有回归），红线 grep 独立复核，文档与代码
一致性核对，总 Exit 决策（GO/PASS 或 HOLD/PENDING）。完成后**停止**：
不实现 RSS/Watch/Sixth Stage 任何代码，等待用户指令。

## 前置依赖

C1–C9 全部完成；真实 Provider 验收状态按 C9 台账如实计入判定。

## 范围

- §9 逐项证据表（Research/Evidence/Rendering/UX/Engineering 五组，每项
  证据来源：单测/冒烟场景/审计条目/源码核对——独立复验不抄报告）；
- §10 Exit Gate 逐项判定：
  1. Research 在若干真实主题上能稳定完成（真实 Provider 维度——**决议
     #117 长期授权**：不得再因「未授权」判 HOLD；只能因真实验证未完成、
     凭据/服务不可用或验证失败而如实 HOLD/PENDING）；
  2. Evidence 已成为数据模型的一部分而非 UI 装饰；
  3. Sources + Search 的选择逻辑经过实际反馈；
  4. Renderer schema 稳定；
  5. Research 不依赖无限上下文或无限 Agent steps（预算断言）。
- 全量验证独立复跑（test/typecheck/lint/format:check/build + dev+生产
  双场景冒烟 + 双进程门控）；
- 红线 grep 独立复核（禁具/万能工具/SQL 边界/Key 形态/Renderer 隔离）；
- 文档同步：Fifth_stage.md §9 勾选与 §10 判定块、progress.md、AGENTS.md
  （§1/§5 速查回填）、README、各任务文档完成定义回填、threat-model §4.1
  证据分类。

## 非目标

- Sixth Stage 任何设计与代码；修改历史阶段文档结论；为通过验收放宽
  任何标准（离线 FakeProvider 不替代真实验证）。

## 涉及模块

无新代码（纯验收 + 文档闭环）；若复验发现真实缺陷 → 回对应任务修复后
重新复验（本任务不直接改产品代码）。

## 红态测试

- 独立复验发现任何与 C1–C9 报告不一致处 → 按「Git/代码/测试为事实」
  原则修正文档并裁决验收项（不得采信报告）。

## 实现步骤

1. 步骤 0 独立核对（HEAD/双远程 ls-remote/工作区/基线独立复跑）；
2. §9 逐项证据表 + §10 逐项判定；
3. 冒烟全矩阵独立复跑（8.16–8.20 + RT/SRT 回归 + 双进程）+ 红线 grep +
   隐私扫描；
4. 文档一致性核对与同步；
5. 总 Exit 决策 + progress 更新 + 最终报告（改了啥/验证了啥/剩余风险/
   下一个唯一任务）。

## 验收标准

- §9 全组 PASS（或如实 HOLD/PENDING + 缺口清单——真实 Provider 维度按
  决议 #117 长期授权：不得因「未授权」判 HOLD；真实验证未完成/凭据·服务
  不可用/验证失败才如实 HOLD/PENDING 并登记缺口）；
- §10 全项判定有证据；总 Exit 决策明确（GO/PASS 或 HOLD/PENDING）；
- 全量验证全绿；文档与代码一致；
- 完成后**停止**：progress 下一推荐任务唯一指向用户指令（Sixth Stage
  前需求澄清，不擅自进入）。

## 全量验证

`npm test -- --maxWorkers=1` · `npm run typecheck` · `npm run lint` ·
`npm run format:check` · `npm run build` · dev+生产双场景冒烟 · 双进程
门控 · diff 终检 · 敏感信息扫描（验收闭环本身零代码改动则按附 A 纯文档
免 build/冒烟重跑——独立复跑已覆盖）。

## 提交要求

文档同步 commit（若有）；提交信息 `<type>: <中文描述>`；不提交临时
数据/日志。

## 完成定义

Exit 决策 + 证据回填 + 文档同步 + 双远程推送 + 最终报告；C10 后无后续
任务（等待用户指令）。

## 独立验收与完成记录（2026-08-23）

### 基线与范围

- Remote baseline：`bf65507d1001025b3ac857875e15f5683f764ced`。
- 独立 Stage Auditor 批准产品 HEAD：
  `c1aafd963f4952c81933ab2d873d154fe1b2741b`；审核结束时工作区 clean，
  本地 `main` 相对 Gitee/GitHub 各领先 3 个候选提交。
- Auditor 结论：Reviewer / Stage Auditor = `PASS`；Fifth Stage Exit Gate =
  `GO/PASS`。
- C10 Closer 仅同步本文、`Fifth_stage.md`、`doc/tasks/progress.md`、
  `doc/stage5/threat-model.md`、`AGENTS.md` 和 `README.md`；`src/`、
  `package*.json`、依赖与产品行为零修改。C1–C9 任务文档均已有完成定义，
  未发现需要修复的状态漂移。

### Auditor 实际命令与结果

| 验证               | 命令或门控                                                                                                                                                | 结果                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 聚焦测试           | `npx vitest run src/main/browser/content-visible-ipc.test.ts src/main/smoke-ui-atomic.test.ts --maxWorkers=1`                                             | 2 files / 34 tests PASS，退出码 0                            |
| 全量测试           | `npm test -- --maxWorkers=1`                                                                                                                              | 97 files / 2226 tests PASS，退出码 0                         |
| 静态与构建         | `npm run typecheck` · `npm run lint` · `npm run format:check` · `npm run build`                                                                           | 全部退出码 0                                                 |
| 默认 Electron 冒烟 | `AIBROWSE_SMOKE=1` 的 dev 与 production 两种运行形态                                                                                                      | 退出码 0/0                                                   |
| 跨进程门控         | `AIBROWSE_SESSION_SMOKE=set\|check` · `AIBROWSE_SOURCES_SMOKE=set\|check` · `AIBROWSE_SOURCES_UI_SMOKE=set\|check` · `AIBROWSE_RESEARCH_SMOKE=set\|check` | 四组全部 0/0                                                 |
| Fifth Stage 场景   | 8.13、B-05、8.19-B、8.20 FRT-01～FRT-12                                                                                                                   | 全部通过                                                     |
| 隐私扫描           | 6 类 canary × 10 扫描面                                                                                                                                   | 60 条期望全部符合                                            |
| 真实 Provider      | 3 个真实主题完整 Research                                                                                                                                 | 全部 `completed`，共 28 次 HTTP；真 Key 九个检查表面零命中   |
| 红线复核           | Tool/Research 子集、AgentLoop、Electron 隔离、SQL、Renderer 边界                                                                                          | 17 工具、Research 六工具、12 步/420 秒及全部安全边界均无回退 |

Auditor 结束时无遗留进程或本轮临时目录。C10 是纯文档闭环，因此 Closer 复用上述
批准 HEAD 的全量测试、构建、冒烟和真实 Provider 证据，不重复高成本验证，也未再次
调用真实 Provider。

### Closer 纯文档验证

- `npm run format:check`：首次只发现本文 Prettier 漂移，精确格式化本文后全仓复跑
  退出码 0。
- `git diff --check`：退出码 0。
- 文档一致性脚本：§9 恰好 14 项全部勾选；C1–C9 九份任务文档均存在「完成定义」；
  progress 下一唯一动作与停止边界一致，退出码 0。
- 范围与敏感信息终检：仅 6 个批准文档；`src/`、`package*.json`、依赖、日志、
  临时目录、凭据、用户数据和机器专属配置零新增，退出码 0。

### §9 与 §10 判定

- `Fifth_stage.md` §9 五组 14 项全部 `PASS` 并已勾选。
- §10 五项 Exit Gate 全部 `PASS`：真实主题稳定完成；Evidence 已进入正式数据模型；
  Sources + Search 选择逻辑经过实际反馈；Renderer Schema 稳定；ResearchRuntime
  具有确定性有限预算，不依赖无限上下文或无限步骤。
- 真实主题 `conflicts=0` 只登记为语义观察：程序能保证已提交 Conflict 的结构和引用
  完整性，但不能保证模型识别出所有语义冲突，不宣称完全免疫。
- 总 Exit 决策：`GO/PASS`。C10 完成定义已满足；收尾提交
  `docs: 完成第五阶段最终验收闭环` 后双远程推送，并停止在 Fifth Stage。

**最终状态**：Fifth Stage 已完成并停止；等待用户明确下一步指令，未进入 Sixth Stage。

## 风险与停止条件

- 复验发现未记录的真实缺陷 → 停止验收流程，回缺陷对应任务修复（或新
  任务），修复后重新复验——不得带缺陷判定 GO/PASS；
- 证据缺口无法补齐 → HOLD/PENDING + 缺口清单与补证建议（同 A7/B9
  先例）；**不得设计或实施 Sixth Stage**。

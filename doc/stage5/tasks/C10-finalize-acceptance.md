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
  1. Research 在若干真实主题上能稳定完成（真实 Provider 维度——未授权
     则 HOLD 同第四阶段先例）；
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

- §9 全组 PASS（或如实 HOLD/PENDING + 缺口清单——真实 Provider 未授权
  按第四阶段 B9 先例处理：询问一次、不授权则 NOT RUN 如实登记）；
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

## 风险与停止条件

- 复验发现未记录的真实缺陷 → 停止验收流程，回缺陷对应任务修复（或新
  任务），修复后重新复验——不得带缺陷判定 GO/PASS；
- 证据缺口无法补齐 → HOLD/PENDING + 缺口清单与补证建议（同 A7/B9
  先例）；**不得设计或实施 Sixth Stage**。

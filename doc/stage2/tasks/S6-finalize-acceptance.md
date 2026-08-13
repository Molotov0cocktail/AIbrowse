# S6 第二阶段收尾与验收（可验证闭环）

- **目标**：Second_stage.md §9 验收清单逐项核对 + §10 Exit Gate 判定 + 全量文档同步
  （契约签名 grep 回填 AGENTS.md §5、README、progress.md）+ 停下向用户报告。
- **输入文档**：Second_stage.md §9/§10；doc/stage2/detailed-design.md（契约源）；
  AGENTS.md §2 收尾纪律。
- **范围**：验收核对与文档同步；对验收发现的问题按「先修根因再改文档」处理（小缺陷在
  本任务内修复并全量回归）。
- **非目标**：**不进入 Third Stage**、不实现 Browser Agent、不写 Third Stage 详细设计
  （只按 Second_stage.md §10 在报告中提出 Third Stage 的详细设计任务建议）；
  **严禁新增 click/fill/scroll、自动搜索、多步 Browser Agent Tool**。

## 涉及文件

- 修改：`src/main/smoke.ts` + `src/main/index.ts`（真实 Provider 多网站共读冒烟场景
  `AIBROWSE_LIVE_SITES=1` 门控，§10 Exit Gate 证据）、`AGENTS.md`（§5 契约速查最终状态 +
  §6 真实 Provider 长期测试流程）、`README.md`（当前状态/真实 Provider 开发者流程/测试）、
  `doc/tasks/progress.md`（任务表/验证结果/风险分类校准）、`Second_stage.md`
  （§9 勾选 + §10 证据行）、`doc/stage2/detailed-design.md`（§13.2 多网站验证与调用规则，
  真实契约变化的最小同步）。

## 实施步骤

- [x] §9 四组清单逐项核对（AI 配置/共读/安全/Engineering），每项标注证据
      （冒烟场景编号/单测文件/审计条目/运行时日志）
- [x] 契约签名用 `grep -n "^export"` 与实际代码核对，确认 AGENTS.md §5 最终状态
- [x] 真实 Provider 多网站共读验证（§10 Exit Gate：普通文章页/长文页/表格页/selection/
      切 Tab/刷新，完整生产链路 + 真实调用；站点连通性与内容形态先经本机探测）
- [x] §10 Exit Gate 逐项判定（共读稳定性/Key 方案稳定/边界明确/注入基线测试存在/
      无「给 AI 更多权限」才能掩盖的缺陷）
- [x] Prompt Injection 风险分类校准（语义层剩余风险 → 已接受的剩余设计风险，不分配
      R 编号；开放风险仍为「无」；保留 Third Stage 前重建威胁模型的最迟复核点）
- [x] README / progress.md / AGENTS.md / Second_stage.md / S5–S6 任务文档同步
- [x] 全量回归（test/typecheck/lint/format:check/build/冒烟全场景）→ 提交推送

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A「重大版本」以下全部）；验收清单全勾且有证据链。

## 完成定义

- Exit Gate 判定通过且证据齐备；文档与代码一致；提交推送双远程；
  progress.md 标记阶段完成；**停下向用户报告**（Second_stage.md §10 格式）：
  已实现内容 / 验证结果 / 剩余风险 / Third Stage 最适合的切入点，等待用户指令。

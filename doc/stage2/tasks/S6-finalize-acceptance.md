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

- 修改：`AGENTS.md`（§5 契约速查回填 + §8 已知限制）、`README.md`（架构/测试/已知限制）、
  `doc/tasks/progress.md`（任务表/验证结果/风险归档）、`Second_stage.md`（§9 勾选 + §10 证据行）。

## 实施步骤

- [ ] §9 四组清单逐项核对（AI 配置/共读/安全/Engineering），每项标注证据
      （冒烟场景编号/单测文件/审计条目）
- [ ] 契约签名用 `grep -n "^export"` 与实际代码核对回填 AGENTS.md §5
- [ ] 真实网站共读抽查（可选联网，至少 2–3 个真实网站走 fake provider 采集路径断言
      snapshot 质量；Provider 联网验证已在 S5 完成）
- [ ] §10 Exit Gate 逐项判定（共读稳定性/Key 方案稳定/边界明确/注入基线测试存在/
      无「给 AI 更多权限」才能掩盖的缺陷）
- [ ] README / progress.md / AGENTS.md 同步
- [ ] 全量回归（test/typecheck/lint/format:check/build/冒烟全场景）→ 提交推送

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A「重大版本」以下全部）；验收清单全勾且有证据链。

## 完成定义

- Exit Gate 判定通过且证据齐备；文档与代码一致；提交推送双远程；
  progress.md 标记阶段完成；**停下向用户报告**（Second_stage.md §10 格式）：
  已实现内容 / 验证结果 / 剩余风险 / Third Stage 最适合的切入点，等待用户指令。

# T8 第三阶段收尾与验收（可验证闭环）

- **目标**：Third_stage.md §9 验收清单逐项核对 + §10 Exit Gate 判定 + 全量文档
  同步（契约签名 grep 回填 AGENTS.md §5、README、progress.md）+ 停下向用户报告。
- **输入文档**：Third_stage.md §9/§10；doc/stage3/detailed-design.md §14 核对
  清单；doc/stage3/threat-model.md；AGENTS.md §2 收尾纪律。
- **范围**：验收核对与文档同步；对验收发现的问题按「先修根因再改文档」处理
  （小缺陷在本任务内修复并全量回归）。
- **非目标**：**不进入 Fourth Stage**、不实现信源数据库、不写 Fourth Stage 详细
  设计（只按 Third_stage.md §10 在报告中提出建议）；不新增工具/权限面。

## 涉及文件

- 修改：`doc/tasks/progress.md`（任务表/验收台账/风险分类校准/下一个推荐任务）、
  `AGENTS.md`（§5 Third Stage 契约速查 grep 核对回填/§1 阶段状态）、
  `README.md`（当前状态/架构/测试计数）、`Third_stage.md`（§9 勾选 + §10
  证据行，如验收过程发生契约校准则同步 detailed-design §15）。

## 实施步骤

- [ ] §9 五组清单逐项核对（Agent/Browser Tools/Search/Permission/Engineering），
      每项标注证据（冒烟场景编号/单测文件/审计条目/运行时日志）
- [ ] 契约签名用 `grep -n "^export"` 与实际代码核对，确认 AGENTS.md §5 最终状态
- [ ] 真实网站 Agent 冒烟复核（已有 T7 证据则引用并复核）
- [ ] §10 Exit Gate 逐项判定（无频繁死循环/Tool API 稳定可复用/Permission 可扩展/
      注入红队基础测试/无放宽网页权限换成功率的技术债）
- [ ] Prompt Injection 残余风险分类校准（威胁模型 §5 三类）
- [ ] README / progress.md / AGENTS.md / Third_stage.md / 任务文档同步
- [ ] 全量回归（test/typecheck/lint/format:check/build/冒烟全场景）→ 提交推送

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；验收清单全勾且有证据链。

## 完成定义

- Exit Gate 判定通过且证据齐备；文档与代码一致；提交推送双远程；
  progress.md 标记阶段完成；**停下向用户报告**（Third_stage.md §10 格式）：
  已实现内容 / 验证结果 / 剩余风险 / Fourth Stage 的切入点建议，等待用户指令。

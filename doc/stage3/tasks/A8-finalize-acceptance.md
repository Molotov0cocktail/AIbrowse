# A8 第三阶段收尾与验收（可验证闭环）

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

- [x] §9 五组清单逐项核对（Agent/Browser Tools/Search/Permission/Engineering），
      每项标注证据（冒烟场景编号/单测文件/审计条目/运行时日志）——2026-08-14
      实施：Third_stage.md §9 逐项勾选 + PASS/BLOCKED/NOT RUN 标注（14 项 PASS、
      1 项 BLOCKED——真实网站 Agent smoke；§14 收紧项 L3 执行器层不可达 PASS）；
      证据：test 771/771 · typecheck · lint · format:check · build 全绿、
      dev 离线 + 生产产物双场景冒烟退出码 0（当日日志实证 8.4/8.5/8.6 场景
      通过行）、RT-09 红线 grep 零命中、当日日志字节扫描（sk- 形态 0/fill 原文 0）
- [x] 契约签名用 `grep -n "^export"` 与实际代码核对，确认 AGENTS.md §5 最终状态
      ——2026-08-14 实施：A1–A6 全部速查签名（agent-loop/agent-safety/agent-
      context-builder/agent-history/permission-policy/audit-log/tool-executor/
      confirm-manager/search-provider/search-tool/browser-tools/interaction-
      tools/tool-registry/tool-types/interaction-semantics/conversation-service/
      conversation-store/shared types/agent-run-state/agent-display）与
      `grep -n "^export"` 实际导出逐项一致，无偏差；§5 补 A7 红队矩阵与门控状态
- [x] 真实网站 Agent 冒烟复核（已有 A7 证据则引用并复核）——复核结论：A7 已获
      用户授权并尝试，唯一已配置 Provider（deepseek-v4-flash）对任何 tools 载荷
      返回 HTTP 400（stream 与否两形态复现，无 tools 200 正常）→ Provider/模型
      兼容性限制；本会话独立复核本地说明（%LOCALAPPDATA%\AIbrowse\S5\
      live-provider-test.md）确认未出现新的 tools 兼容 Provider 配置 → 按规则
      **不重复付费诊断、不进入询问边界**，该项标记 BLOCKED
- [x] §10 Exit Gate 逐项判定（无频繁死循环/Tool API 稳定可复用/Permission 可扩展/
      注入红队基础测试/无放宽网页权限换成功率的技术债）——5 项技术条件逐项判定：
      条件 1/2/3/4/5 均 PASS（条件 4 离线部分 PASS、RT-10 真实观察 NOT RUN）；
      **第三阶段总 Exit 决策 = HOLD/PENDING**（§9 Engineering 真实网站 smoke
      BLOCKED；不标记最终验收通过，待 tools 兼容 Provider 补验后改判 GO/PASS）
- [x] Prompt Injection 残余风险分类校准（威胁模型 §5 四类）——复核确认
      threat-model §5/AGENTS.md §8/README 均为四类（诱导式工具参数/确认疲劳/
      低风险动作累积/click 允许列表目标页内 JS 副作用），无「三类」残留
- [x] README / progress.md / AGENTS.md / Third_stage.md / 任务文档同步
- [x] 全量回归（test/typecheck/lint/format:check/build/冒烟全场景）→ 提交推送

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；验收清单全勾且有证据链——2026-08-14 实施：
  §9 离线可判项全部有证据链；BLOCKED/NOT RUN 项如实标注不伪造。

## 完成定义

- ~~Exit Gate 判定通过且证据齐备~~ → **按 2026-08-14 实施结果校准**：Exit Gate
  五项技术条件逐项判定（1/2/3/4/5 PASS，条件 4 的 RT-10 真实观察 NOT RUN），
  **总 Exit 决策 HOLD/PENDING**（§9 Engineering 真实网站 smoke BLOCKED——
  唯一已配置 Provider 不支持 tools；不伪造通过、不放宽验收标准）；
  文档与代码一致；提交推送双远程；progress.md 标记 A8 完成（总判定
  HOLD/PENDING）；**停下向用户报告**：已实现内容 / 验证结果（含 BLOCKED 项
  与证据）/ 剩余风险 / 下一任务（真实 Provider Agent 验收补验），等待用户指令。

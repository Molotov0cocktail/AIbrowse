# T7 威胁模型红队矩阵 + 安全审计 + 真实 Provider 可选验证（可验证闭环）

- **目标**：按 doc/stage3/threat-model.md §4 红队矩阵 R-01～R-10 逐项落地自动化
  断言；Third Stage 安全基线全量审计（对应 Second Stage §14 增量）；真实 Provider
  可选验证（需用户提供 Key——询问边界；无 Key 跳过并记录，不作为失败）。
- **输入文档**：doc/stage3/threat-model.md（安全契约源，§4/§5/§6）；
  doc/stage3/detailed-design.md §12/§13.2（真实 Provider 段）；
  Third_stage.md §7 关键真实场景 1–6。
- **范围**：R-01（敌对页诱导文案仅作资料/权限矩阵不变）、R-02（URL 白名单+审计）、
  R-03（提交类确认门必现、deny 无动作）、R-04（搜索结果注入 → UNTRUSTED_TOOL_RESULT
  块）、R-05（fill password 拒绝）、R-06（陈旧 elementId 安全失败）、R-07（system
  恒等+无 Key 形态）、R-08（确认序列：每 L1 独立展示、L2 独立确认、步数兜底）、
  R-09（grep 断言无 shell/eval/任意 JS/文件系统/HTTP POST/任意 IPC/SQL）；
  R-10（真实恶意网页场景）属真实 Provider 验证门控（需 Key）。
  真实验证场景：1 搜索打开最相关结果 / 2 页面找 security / 3 两页对比总结 /
  4 筛选框输入并读取结果 / 5 提交动作停等确认 / 6 恶意网页指令不执行。
  沿用第二阶段凭据流程（仓库外 DPAPI/环境变量注入/真 Key 零暴露扫描/不设固定
  调用次数/报告列调用用途）。
- **非目标**：不新增工具/不修改权限矩阵（审计发现问题按「先修根因再改文档」，
  小缺陷本任务内修复并全量回归）；不做 T8 验收收尾。

## 涉及文件

- 修改：`src/main/smoke.ts`（红队矩阵夹具与断言；真实 Provider 场景门控
  `AIBROWSE_LIVE_AGENT=1` + `AIBROWSE_LIVE_SITES` 复用）、`src/main/index.ts`
  （门控装配）、（审计发现的缺陷修复涉及文件视情况）。

## 实施步骤

- [ ] R-01～R-09 逐项审计（代码审查 + grep + 单测 + 冒烟探针），登记发现与处置
- [ ] 红队矩阵夹具落地（敌对页 HTML + 注入文案 + 断言），全量冒烟复跑
- [ ] 真实 Provider 验证（用户提供 Key 时）：真实场景 1–6 + R-10 + 真 Key 零暴露
      扫描；报告调用次数与用途（不报凭据）
- [ ] 安全基线清单逐项核对（Second Stage §14 增量 + threat-model §3）
- [ ] 全量回归 → 提交推送 → 更新 progress.md（红队结论与残余风险复核）

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；红队矩阵每项有明确断言与证据条目；
  真实调用台账报告。

## 完成定义

- R-01～R-09 全部有自动化断言且通过；R-10（如真实验证进行）通过；审计未发现
  需修改契约的缺陷（或缺陷已修复回归）；威胁模型 §5 残余风险分类校准写入
  progress.md；progress.md 标记 T7 ✅ 并推荐 T8。

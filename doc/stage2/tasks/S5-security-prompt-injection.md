# S5 安全审计与 Prompt Injection 验证（可验证闭环）

- **目标**：Second Stage 安全基线清单逐项审计 + Prompt Injection 结构断言补全 +
  真实 Provider 可选验证（需用户提供 Key）。
- **输入文档**：doc/stage2/detailed-design.md §12/§14 + §13.2 矩阵 10–12 复核；
  Second_stage.md §6/§9 安全组。
- **范围**：审计报告（登记 progress.md）；grep 矩阵（无浏览器写 Tool、无 Key 读回通道、
  Key 形态不进任何文件）；注入夹具单测/冒烟复核；剩余风险登记
  （**不声称 prompt 可保证模型语义免疫**——结构性边界是验收线，语义风险如实登记）；
  用户提供 Key 时的真实 Provider 冒烟变体。
- **非目标**：不引入新功能；不做 Third Stage 的 Agent 威胁模型设计（只预留，Third Stage
  进入时重建）；**严禁新增 click/fill/scroll、自动搜索、多步 Browser Agent Tool**。

## 涉及文件

- 修改：`doc/tasks/progress.md`（审计结论 + 剩余风险登记）、`doc/stage2/detailed-design.md`
  （如审计发现需修契约）、`src/main/smoke.ts`（真实 Provider 可选场景 + 注入夹具增强，
  env 门控）、`src/main/index.ts`（真实 Provider 冒烟装配：临时配置写入 / Key 环境变量
  读取后立即移除 / 流式 delta 计数）。审计未发现需修契约的缺陷，detailed-design 未改动。

## 实施步骤

- [x] §14 清单逐项审计实际代码（引用 §/文件/行号落审计结论）
- [x] grep 矩阵自动化核对：click/fill/scroll/搜索 Tool 不存在；Key 读回通道不存在；
      全仓库无真实 Key 形态样本
- [x] 注入夹具复核：敌对页（含「忽略之前的指令」等文案）→ system 恒等 / 单块结构 /
      无写调用 / 权限默认拒绝（矩阵 11 复跑）
- [x] 日志字节扫描断言复跑（矩阵 10）
- [x] 真实 Provider 可选验证：`AIBROWSE_LIVE_PROVIDER=1` + `AIBROWSE_TEST_API_KEY`
      （**需用户提供 Key，先询问；未经用户提供不得联网调用付费 API**）——
      固定问题真实流式一问一答断言；无 Key 则跳过并记录
- [x] 剩余风险登记（progress.md 风险与限制：语义层注入剩余风险 + 为 Third Stage 预留的
      威胁模型要求）
- [x] 全量回归 + 提交

## 测试与检查

- `npm test` / `typecheck` / `lint` / `format:check` / `build` 全绿；
  冒烟（离线全矩阵 + 可选联网变体）退出码 0。

## 完成定义

- 审计结论与剩余风险已登记；全量验证通过；diff 终检；逻辑 commit 推送双远程；
  progress.md S5 ✅。

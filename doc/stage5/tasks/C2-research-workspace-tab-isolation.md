# C2 — ResearchWorkspace 与 task-owned Tab 隔离、数量上限、取消/异常清理

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §10；安全契约
> `doc/stage5/threat-model.md` §3.6（FT-09/FT-15）。

## 目标

落地 ResearchWorkspace：task-owned 专用 Tab 的**精确 tabId 所有权**、并发
上限、取消/异常清理与「用户 Tab 永不关闭」规则——为 C4 读取提供隔离的
Tab 管理能力（BrowserController 集成胶水，零 Electron import 可单测）。

## 范围与非目标

- **做**：Workspace 模块（创建 task Tab/登记精确 tabId/并发 ≤3/释放/清理
  全部/感知用户关闭）；BrowserController 接口注入（结构最小接口）；恢复
  语义（不抢用户焦点/不重建不激活/已关闭安全无操作——决议 #32 模式）；
  取消/异常路径 finally 最佳努力清理；跨任务 tabId 引用拒绝。
- **不做**：实际读取/提取（C4）；Runtime 编排（C5）；UI 标识（C8）；
  修改 BrowserController/TabManager 产品契约（仅消费既有 createTab/
  closeTab/getTabs/getActiveTab）；用户 Tab 的任何关闭行为。

## 涉及模块和输入文档

- 新增 `src/main/research/research-workspace.ts` + 测试。
- 输入：detailed-design §10；threat-model §3.6；A4 SearchProvider 决议 #32
  临时 Tab 所有权模式（doc/stage3/detailed-design.md §6）；BrowserController
  接口（browser-controller.ts:25，本会话核对）。

## 预计修改文件

- 新增：`src/main/research/research-workspace.ts`、
  `research-workspace.test.ts`。
- 既有文件零改动（装配推迟至 C5）。

## 依赖

C1（域类型/预算常量）。

## 红→绿步骤

1. **红**：先写测试（模块缺失红）——精确 tabId 归属（createTab 返回值
   登记，绝不按位置/标题/URL/活动 Tab 推断）；清理只关本任务创建的确切 id
   （已关闭安全无操作、不关替代 Tab）；用户 Tab 永不关闭（注入含用户 Tab
   的替身，清理后用户 Tab 数不变）；并发上限 3（第 4 个创建请求安全拒绝）；
   异常路径 finally 清理；用户关 task Tab 感知（tab-closed-by-user 事件
   回调）；跨任务 tabId 引用拒绝；恢复语义（不抢焦点/不重建）。
2. **绿**：实现 Workspace（注入 BrowserController 最小接口 + 时钟）；
   逐用例转绿。
3. 全量回归 + 零既有改动确认（git diff 仅新增文件）。

## 验收标准

- §10 全部规则有单测覆盖（含敌手 createTab 返回已存在 id 不纳入清理——
  沿用 A4 敌手用例模式）；
- Workspace 零 Electron import（测试注入替身）；
- 并发上限/清理/用户 Tab 保护断言全部绿。

## 具体验证命令和期望结果

- `npm test -- --maxWorkers=1` → 全量绿；
- `npm run typecheck` / `npm run lint` / `npm run format:check` /
  `npm run build` / `git diff --check` → 全部退出码 0；
- 既有 17 工具注册表/冒烟断言零回归。

## 完成定义

红→绿证据回填 + 全量验证全绿 + diff 终检 + progress.md 更新 + 一个逻辑
提交（feat: C2 …）+ 双远程推送。

## 风险与停止条件

- BrowserController 实际行为与本设计假设冲突（如 createTab 语义变化）→
  停止并报告（不修改产品契约绕过）；
- 需要修改 TabManager/BrowserController → 停止并报告。

## 提交边界

单一逻辑提交；不夹带 C4 读取逻辑。

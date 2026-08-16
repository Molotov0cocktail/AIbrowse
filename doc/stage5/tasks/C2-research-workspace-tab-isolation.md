# C2 — ResearchWorkspace 与 task-owned Tab 隔离、数量上限、取消/异常清理

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §10（§10.1
> 精确接口，决议 #118 定稿）；安全契约 `doc/stage5/threat-model.md` §3.6
> （FT-09/FT-15）。

## 目标

落地 ResearchWorkspace：task-owned 专用 Tab 的**精确 tabId 所有权**、并发
上限、取消/异常清理与「用户 Tab 永不关闭」规则——为 C4 读取提供隔离的
Tab 管理能力（BrowserController 集成胶水，零 Electron import 可单测）。

## 范围与非目标

- **做**：Workspace 模块（创建 task Tab/登记精确 tabId/并发 ≤3/释放/清理
  全部/显式快照感知用户关闭——`checkTab` 方法，C4 读取前后调用）；
  BrowserController 最小结构端口注入（ResearchWorkspaceBrowser：
  createTab/closeTab/activateTab/getTabs/getActiveTab）；恢复语义
  （不抢用户焦点/不重建不激活/已关闭安全无操作——决议 #32 模式）；
  取消/异常路径最佳努力清理（cleanupAll drain 屏障）；跨任务 tabId
  引用拒绝（not-owned）。
- **不做**：实际读取/提取（C4）；Runtime 编排（C5）；UI 标识（C8）；
  修改 BrowserController/TabManager 产品契约；用户 Tab 的任何关闭行为；
  后台事件订阅/计时器/监听器（BrowserController 无 Tab 事件接口——
  C2 零事件零计时器，用户关闭感知全靠显式 getTabs 快照）。

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
   的替身，清理前后用户 Tab id 集合完全一致）；并发上限 3（第 4 个创建
   请求在 createTab 前确定性拒绝 + deferred create 竞态）；abort 前/
   create 期间；焦点恢复三态；closeTab false/抛错；cleanupAll 多 Tab·
   部分失败·重复·drain 屏障零泄漏；cleanup 后 acquire 拒绝；用户关 task
   Tab → checkTab 返回 tab-closed-by-user（显式快照，零事件/计时器）；
   跨任务 tabId 引用拒绝；恢复语义（不抢焦点/不重建）；零 Electron
   import 与 MAX_RESEARCH_TABS 单一事实源（源码断言）。
2. **绿**：实现 Workspace（决议 #118 §10.1 精确接口，注入
   ResearchWorkspaceBrowser 最小结构端口，AbortSignal 参数化）；
   逐用例转绿。
3. 全量回归 + 零既有改动确认（git diff 仅新增文件 + 契约文档）。

## 验收标准

- §10/§10.1（决议 #118）全部规则有单测覆盖（含敌手 createTab 返回已存在
  id 不纳入清理——沿用 A4 敌手用例模式）；
- Workspace 零 Electron import（测试注入替身 + 源码断言）；
- 并发上限/清理/用户 Tab 保护断言全部绿；
- 测试不得只断言函数被调用——必须检查最终 Tab 集合、activate/close 精确
  序列、所有权集合、返回错误与零泄漏后置条件。

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

## 完成记录（2026-08-16，红→绿证据回填）

- **实施前契约裁决 #118**（detailed-design §15）：八项契约缺口全部由
  Fifth_stage.md §9 UX、threat-model FT-09/§3.6、§10 既有条款与决议 #32
  模式唯一裁决——§10.1 精确接口定稿（WorkspaceErrorCode 十一码局部闭合
  联合/Lease 三元组/ResearchWorkspaceBrowser 最小端口/AcquireResult/
  ReleaseResult/CleanupAllResult/CheckTabResult 判别联合）；§13.1 测试行
  与本文红→绿步骤/验收标准同步（删除「事件回调」承诺与「时钟注入」要求）。
- **红态**：`npm test` 前先写 `research-workspace.test.ts`（39 用例）→
  聚焦 `npx vitest run src/main/research/research-workspace.test.ts` →
  **1 file failed（模块缺失，导入失败）**——红态可甄别证据。
- **绿态**：实现 `research-workspace.ts`（决议 #118 §10.1 精确接口；零
  Electron import；并发槽同步段检查 + drain 屏障；焦点恢复三态；
  checkTab 显式快照）→ 聚焦 **39/39**、全量 **1509/1509**（64 文件，单
  worker）。
- **测试夹具说明**：FakeBrowser 完全离线（无 Electron/无网络）；默认
  createTab 立即完成对齐真实契约（新 Tab 入表 + 自动激活）；时序用例以
  `manualCreate=true` + `completeCreate` + `waitForPending`（确定性微任务
  轮询）控制创建完成时刻；行为注入点（createOverride/closeResult/
  closeThrow/activateResult/getTabsError/getActiveError）覆盖敌手与异常
  路径。断言不只看函数调用：最终 Tab 集合、activate/close 精确序列、
  所有权集合、返回错误与零泄漏后置条件全部覆盖。
- **验证**：全量 test 1509/1509 · typecheck · lint · format:check ·
  build · git diff --check 全绿；dev + production 冒烟退出码 0（17 工具
  恒等 + SRT-01～SRT-12 全过 + RT 红队回归）；BrowserController/TabManager/
  SearchProvider 零 diff；package.json/lock 零 diff；C2 模块零 Electron/
  SQL/shell/child_process/网络；renderer/preload 零 SQL；密钥形态零命中；
  冒烟临时目录/日志/进程/根目录杂散日志全部精确清理。
- **真实 Provider**：0 次调用（C2 无真实 Provider 产品链路；决议 #117
  授权不等于强制调用）。

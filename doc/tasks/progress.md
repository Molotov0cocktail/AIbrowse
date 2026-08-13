# progress.md — 项目当前状态与短期工作记忆（主 agent 维护）

> 状态标记：⏳ 待开始 / 🔨 进行中 / ✅ 已完成 / ⛔ 阻塞。
> 高频更新：每个开发闭环后更新；保持结构化、精炼，供新 Agent 快速接管，不写长篇开发日记
> （历史细节进 git log / 任务文档）。任务粒度与文档职责见 AGENTS.md §2。
> ⚠️ 文档与代码实际状态不一致时，以 Git/代码/测试为准并修正本文件。
> ⚠️ 风险编号 R-XX 按登记顺序分配，**不得重排、不得复用**（已关闭项保留编号与结论直至自然归档）。
> 「风险与限制」只登记当前仍需关注的事项；历史细节由 Git 提交与任务文档保存，不在此重复叙述。

## 当前状态

- 阶段：第一阶段（浏览器核心）。T0 基线、T1 详细设计定稿、T2 浏览器核心、T3 浏览器 UI、
  T4 PageSnapshot 闭环、T5 收尾（安全审计 + 验收核对 + 文档同步）**全部完成**；
  第一阶段 Exit Gate 已通过（2026-08-13），**停止并等待用户指令**，不擅自进入第二阶段。
- Second Stage Entry Gate 独立定向审查（用户指令下的进入前审查，纯审查零代码改动）
  已于 2026-08-13 **通过**（无阻塞项，证据见「最近验证结果」）；**但尚未正式切换
  Second Stage**——继续等待用户指令，不提前进入 Second Stage 设计或实现。
- 路线图文档已接入（2026-08-13）：ROADMAP.md + Second_stage.md～Seventh_stage.md 入库；
  各文件职责、接管顺序与阶段切换纪律见 AGENTS.md §1/§2。
- 最近 commit 与工作区状态：以 `git log --oneline` / `git status --short` 为准。
- 技术基线：2026-08-13 验证冻结（AGENTS.md §1）；依赖精确版本固定（package.json 无 ^/~）。

## 任务表

| 任务 | 内容                                                                                             | 状态 | 备注                                                           |
| ---- | ------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------- |
| T0   | 项目基线（git/文档链/脚手架/测试基建/最小应用）                                                  | ✅   | 2026-08-13 完成，见 tasks/baseline.md                          |
| T1   | 详细设计定稿：接口契约/错误处理/preload 清单/Tab 状态机/采集算法 + proposal Q1–Q4 拍板           | ✅   | 2026-08-13 完成，定稿见 doc/detailed-design.md（§12 决议记录） |
| T2   | 浏览器核心：BrowserController + TabManager + WebContentsView + SessionManager（多 Tab 可开网页） | ✅   | 2026-08-13 完成，签名已回填 AGENTS.md §5 并与代码 grep 核对    |
| T3   | 浏览器 UI：顶部工具栏/标签栏/地址栏（URL 判断逻辑接入）/主区域                                   | ✅   | 2026-08-13 完成，R-01 同闭环关闭（见下）                       |
| T4   | PageSnapshot：PageReader + elementId + 调试面板显示 JSON                                         | ✅   | 2026-08-13 完成（含 T3 导航保护收紧，见下）                    |
| T5   | 收尾：安全审计（§11 逐项 + R-02 关闭 + elementId 敌对页审查）+ 验收清单逐项核对 + 文档同步       | ✅   | 2026-08-13 完成（4 个逻辑 commit，见下）                       |

## 最近验证结果（2026-08-13）

- Second Stage Entry Gate 独立定向审查（2026-08-13，纯审查零代码改动）：按 Second_stage.md
  §2 逐项复核——① 四模块稳定边界与 AGENTS.md §5 契约逐项一致；② PageSnapshot 真实页面探针
  （example.com/MDN 长文/w3school 表格页/cnblogs 长文/百度百科动态长文/sspai 动态首页/bing
  首页七页：长文与表格内容质量良好、L0/L1 阶梯与 warnings 正常；bing 首页文本稀薄属页面特性）；
  ③ elementId 生命周期与销毁错误处理（敌对页冒烟复跑）；④ 权限隔离冒烟复跑；⑤ 全量验证
  复跑全绿（test 89/89 · typecheck · lint · format:check · build · dev/生产/真实 URL 冒烟 ·
  Session set/check）；⑥ 本文档无阻塞级缺陷。另以同视图导航/刷新一致性探针证实无旧快照
  复用，selection 焦点保持探针证实 chrome 获得焦点后页面 selection 保留且真实采集脚本可读
  （支撑「对选中文字提问」链路）。判定：**Entry Gate 通过，无阻塞项**。审查发现的文档
  不一致（AGENTS.md §6 Session 冒烟命令缺 `AIBROWSE_SMOKE=1`）已于本闭环修复；新增
  Second Stage 设计约束三条登记于「计划内限制与延期项」。
- T5 收尾（2026-08-13）：test 89/89 ✅ · typecheck ✅ · lint ✅ · format:check ✅ · build ✅ ·
  Electron 冒烟 ✅ 全场景退出码 0：① dev 离线（含 T5 新场景）；② 生产产物（npm run start）；
  ③ 真实 URL（AIBROWSE_SMOKE_URL=https://www.bing.com/）。新增验证：
  ① **安全审计**：detailed-design §11 逐项核对实际代码全部落实（Tab/UI 安全默认值、
  IPC sender+主帧校验、preload 白名单、双权限处理器默认拒绝、监听器逐一清理）；
  ② **R-02 关闭**：Tab will-redirect 白名单 + 受控 302 冒烟（允许目标 http→http 跟随、
  禁止目标 custom:// 拦截 + 日志字节切片断言；探针实测 file:/data:/about:blank 被
  Chromium 网络层先拦、自定义协议/mailto: 真实触发 will-redirect）；
  ③ **elementId 敌对页审查**：修复同元素跨集合双 id 漂移 + 顶格烙印分配溢出两处缺陷，
  敌对页冒烟断言（重复/畸形/超大/负数/冲突烙印 → id 唯一、1–10 位数字、无歧义对应
  活 DOM 真实元素、跨快照稳定）；
  ④ **UI 端到端冒烟**：React DOM 点击/键盘事件驱动（地址栏 URL/搜索、多 Tab 新建/切换/关闭、
  后退/前进/刷新、标题随网页变化、调试面板 L0 徽标+JSON / L1 徽标+warnings 展示），
  远程页面隔离探针（window.aibrowse/process/require/electron 均 undefined）；
  ⑤ **Session 跨进程持久化**：AIBROWSE_SESSION_SMOKE=set/check 双独立进程 + 临时
  userData（HttpOnly Cookie 落盘 → 完整退出 → 新进程读回，测试后清理临时数据）。
  交付 4 个逻辑 commit：① R-02 will-redirect 加固（+logger 日志路径导出）；
  ② elementId 两处修复；③ 冒烟四场景扩展 + index 接线；④ 文档同步。
  仍不接入 LLM、CI、打包；第一阶段 Exit Gate 通过，停止等待用户指令。

- T4 PageSnapshot 闭环（2026-08-13）：test 89/89 ✅（42 基线 + 1 导航保护收紧新增 + 46
  snapshot-normalize 新增）· typecheck ✅ · lint ✅ · format:check ✅ · build ✅ ·
  Electron 冒烟 ✅ 三场景退出码 0：① dev 离线；② 生产产物（npm run start）；
  ③ 真实 URL（AIBROWSE_SMOKE_URL=https://www.bing.com/）。冒烟新增真实采集断言：
  本地受控双服务器页面实际注入只读脚本——L0 内容对照（heading/link/button/table/
  visibleText/elementId 唯一性与跨快照稳定）、L1 跨域 iframe 跳过警告、L3 未知 tabId null。
  交付内容（5 个逻辑 commit）：① T3 核查发现导航保护生产 file: 前缀语义过宽
  （同目录扩展/路径穿越可放行）→ 收紧为入口精确匹配（scheme+pathname 相等，hash/query
  变体视为同一文档）+ 冒烟三探针；② snapshot-normalize 校验纯函数（页面视为敌手）+
  46 组红绿测试；③ 只读采集脚本（IIFE 字符串，DOM lib 引用保持 TS 检查）+ PageReader
  L0–L2 阶梯接入 BrowserController；④ 调试面板（JSON + degraded 徽标 + warnings + 可收起）；
  ⑤ 冒烟采集扩展。仍未接入 LLM、未开始 T5。
- T3 浏览器 UI 闭环（2026-08-13）：test 42/42 ✅（33 基线 + 9 ui-navigation-policy 新增）·
  typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 三场景退出码 0：
  ① dev 离线（T2 场景回归 + UI 导航保护拦截 + bounds 上报生效）；
  ② 生产产物（`npm run start`，file: 入口导航保护路径）；
  ③ 真实 URL（AIBROWSE_SMOKE_URL=https://www.bing.com/，ready + 标题非空）。
  交付内容：UI 窗口导航保护（will-navigate + will-redirect 自身来源白名单，纯函数
  ui-navigation-policy + 9 用例，**bridge 扩展硬前提，与 bridge 同闭环落地**）→
  preload bridge 扩展（tabs/nav/page/ui 白名单，§3.2 定稿签名）→ 浏览器 chrome UI
  （工具栏/标签栏/地址栏/主区域 + ResizeObserver bounds 上报 + 原始输入 main 侧规范化）→
  冒烟扩展。分 4 个逻辑 commit 提交。
- 安全补丁（2026-08-13，审查发现→修复）：persist Session 权限默认放行漏洞已修复——
  `setPermissionRequestHandler` + `setPermissionCheckHandler` 双处理器默认拒绝（v1），
  策略纯函数 `permission-policy.ts` + 4 组纯测试（无 Electron mock）。test 33/33 ✅ ·
  typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅（退出码 0，离线场景）。
  同步定稿：detailed-design §7/§9/§11/§12（权限默认拒绝 + UI 窗口导航保护事件集，
  Electron 43.4.0 实证：will-navigate 覆盖页面发起导航含 location.replace；
  will-redirect 覆盖页面发起与程序化两条路径的 302；不采用 will-frame-navigate）。
- T0 基线：test 15/15 ✅ · typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅（退出码 0）
- T1 定稿（2026-08-13，纯文档任务）：基线验证复跑全绿（test 15/15 · typecheck · lint · format:check · build）；
  Electron 冒烟按验证矩阵「纯文档」豁免（代码零改动）。定稿契约依据本地 electron.d.ts（43.4.0）
  逐项核实：WebContentsView/setVisible/addChildView/executeJavaScript/fromPartition/navigationHistory 均可用。
- T2 浏览器核心（2026-08-13）：test 29/29 ✅（15 基线 + 14 tab-state 新增）· typecheck ✅ ·
  lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅ 双场景退出码 0
  （离线：多 Tab 创建/切换/关闭、最后 Tab 自动新建、dispose 幂等 + webContents 无残留；
  真实 URL：AIBROWSE_SMOKE_URL=https://www.bing.com/ 加载 ready + 标题非空）。
  冒烟首跑抓出并修复 2 个集成 bug：① closeTab 把「移除后」列表传给 selectNextActive
  （契约要求关闭前完整列表）→ 关闭活动 Tab 后邻居接管失效；② 窗口 closed 后
  BaseWindow 已销毁，removeChildView 抛 Object has been destroyed → 已加 isDestroyed 守卫。
- 规范校准：技术矩阵按官方来源（npm registry metadata + 官方文档）验证通过并冻结；
  依赖树健康（`npm ls` 无 invalid/missing peer）。

## 风险与限制

> 编号规则见文件顶部；正常后续任务、已接受的设计决议、机器环境说明不登记为风险
> （分别在任务表 / detailed-design / AGENTS.md §6）。

### 已关闭风险摘要

> 已关闭项保留编号与结论直至自然归档（不重排、不复用编号）。

- **R-01 UI 窗口导航保护缺失**（Medium，T3 内关闭，2026-08-13）：UI 窗口 preload 随任何导航
  加载，主框架被导航到远程页面即泄露 `window.aibrowse` bridge。处置：T3 先于 bridge 扩展
  落地 will-navigate + will-redirect 自身来源白名单（纯函数 `ui-navigation-policy.ts` + 用例；
  冒烟三探针实跑通过）。证据与影响详见 detailed-design §9/§12 决议 #16。
- **R-02 Tab 导航白名单未覆盖服务器重定向**（Low，T5 关闭，2026-08-13）：Tab 仅挂
  will-navigate，302 目标（如自定义协议）可绕过白名单。处置：补 will-redirect 与同一
  scheme 白名单，受控 302 实测（允许目标 http→http 放行跟随；禁止目标 custom:// 拦截 +
  日志断言；探针证实 file:/data:/about:blank 被 Chromium 网络层先拦、自定义协议/mailto:
  真实触发 will-redirect——自定义协议正是该风险的验证路径）。当前项目未注册自定义协议，
  该防护为防御纵深；结论 **Resolved**，详见 detailed-design §12 决议 #17。

### 开放风险登记

- 当前无开放风险。

### 计划内限制与延期项

（正常后续任务 / 已接受设计决议 / 明确延期，不虚构严重度与证据）

- PageSnapshot v1 仅采集主文档，跨域 iframe 内容 L1 降级跳过——已接受设计决议
  （detailed-design §12 决议 #13，快照为点时刻尽力采样）。
- 采集边界（T4 落地，非缺陷）：iframe 跨域计数为尽力采样（未加载完成的同源 iframe 可能被
  计为跨域，仅影响警告文案）；页面对主世界脚本的原型篡改可使采集返回 L2（按契约降级）；
  L2 触发路径（渲染进程崩溃/上下文失效）未在冒烟强制触发（normalize 单测覆盖 L2 形状）。
- Tab will-redirect 白名单为防御纵深（T5）：file:/data:/about:blank 等目标已被 Chromium
  网络层拦截（ERR_UNSAFE_REDIRECT），当前无自定义协议注册；未来注册 `aibrowse://` 等协议
  时该拦截点是唯一防线（冒烟已用 custom:// 目标验证 handler 真实触发）。
- 无 CI / 打包配置：第一阶段验收不要求（Second Stage 起评估 CI：lint + test + typecheck；
  打包属 Seventh Stage Product Hardening）。
- shared/url 不支持 IDN（中文域名走搜索兜底，安全无副作用）；SearchProvider 尚未抽象
  （Bing 硬编码，计划在 Second/Third Stage 前替换）。
- UI 窗口（defaultSession）未注册权限处理器：UI 只加载自身内容，R-01 已关闭（导航保护落地）
  后无远程页面可达，当前无需处理；未来 UI 嵌入远程内容时重新评估。
- 地址栏搜索的端到端验证在离线环境断言「导航目标为 Bing 搜索 URL」（did-start-navigation），
  真实搜索页加载需联网（冒烟含 AIBROWSE_SMOKE_URL 联网变体；URL 判断本身有 15 用例单测）。
- Second Stage 设计约束（2026-08-13 Entry Gate 审查登记；判断：属第二阶段的输入约束而非
  本阶段风险，不进入开放风险登记、不占用 R 编号）：① **提问时刻实时采集防串页**——AI 侧栏/
  ContextBuilder 必须在提问时刻实时 `getPageSnapshot(activeTabId)`，不得复用调试面板保留的
  最近一次快照，否则切 Tab 后上下文串页（Second_stage §8 已有对应测试重点，此为实现机制
  约束）；② **薄快照降级策略**——动态/JS 重渲染或无语义标记页面快照文本可能稀薄（实测 bing
  首页 visibleText 仅 7 字符，sspai 首页 0 heading），ContextBuilder 需有「快照过薄/无
  selection」的提示与降级策略；③ **布局表噪声**——tables 采集无数据表启发式，布局表格
  （实测 cnblogs 首表为日历，空表头）会与数据表混入，ContextBuilder 裁剪与共读提示需容忍。

## 阻塞项

- 无。

## 下一个推荐任务

- **第一阶段已完成（Exit Gate 通过）**：停下向用户报告（First_stage.md §十五格式：
  已实现内容 / 项目结构 / 测试和构建结果 / 已知限制 / 下一阶段最适合做什么），
  等待用户指令后再按 ROADMAP.md「阶段切换原则」进入 Second Stage。

## 第一阶段验收未完成项

- 无：First_stage.md §十四 全部验收项已逐项核对并通过（T5，2026-08-13）；
  证据摘要见 First_stage.md §十四「验收证据」与本文「最近验证结果」。

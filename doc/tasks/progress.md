# progress.md — 项目当前状态与短期工作记忆（主 agent 维护）

> 状态标记：⏳ 待开始 / 🔨 进行中 / ✅ 已完成 / ⛔ 阻塞。
> 高频更新：每个开发闭环后更新；保持结构化、精炼，供新 Agent 快速接管，不写长篇开发日记
> （历史细节进 git log / 任务文档）。任务粒度与文档职责见 AGENTS.md §2。
> ⚠️ 文档与代码实际状态不一致时，以 Git/代码/测试为准并修正本文件。
> ⚠️ 风险编号 R-XX 按登记顺序分配，**不得重排、不得复用**（已关闭项保留编号与结论直至自然归档）。
> 「风险与限制」只登记当前仍需关注的事项；历史细节由 Git 提交与任务文档保存，不在此重复叙述。

## 当前状态

- 阶段：第一阶段（浏览器核心）。T0 基线、T1 详细设计定稿、T2 浏览器核心、T3 浏览器 UI、
  T4 PageSnapshot 闭环完成，T5 待执行。
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
| T5   | 收尾：安全审计 + 第一阶段验收清单逐项核对 + 文档/README 同步                                     | ⏳   | 依赖 T2–T4 ✅                                                  |

## 最近验证结果（2026-08-13）

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

### 开放风险登记

#### R-01 UI 窗口导航保护缺失（T3 bridge 扩展硬前提）→ Resolved

- 状态：**Resolved（2026-08-13，T3 内关闭）**
- 发现于：2026-08-13 技术审查（T2 完成后）
- 严重度：Medium（曾评估：T3 若先扩展 bridge 再补保护，则升为 High）
- 阻塞级别：指定任务硬前提（T3 tabs/nav/page/ui bridge 扩展）
- 影响：UI 窗口 preload 随该窗口任何导航加载；若 UI 主框架被导航到远程页面，远程页面将获得
  `window.aibrowse` bridge——T3 扩展后含 `page.snapshot`，可读取任意 Tab（含已登录页面）内容，
  违反 First_stage §八 安全红线
- 证据（曾）：`src/main/index.ts` 无 will-navigate / will-redirect 处理；
  detailed-design §9/§12 决议 #16（Electron 43.4.0 实证事件集）
- 关闭结论：T3 内先于 bridge 扩展落地 UI 窗口 will-navigate + will-redirect 自身来源白名单
  （开发模式仅放行 `ELECTRON_RENDERER_URL` origin、生产仅放行 `file:` 入口），判定抽为纯函数
  `ui-navigation-policy.ts` + 9 用例；冒烟新增拦截断言（dev origin 与生产 file: 两条路径
  实跑均通过：UI 窗口发起远程导航 800ms 后 URL 不变）

#### R-02 Tab 导航白名单未覆盖服务器重定向（待 T5 评估）

- 状态：Open
- 发现于：2026-08-13 技术审查（T2 完成后）
- 严重度：Low
- 阻塞级别：当前任务非阻塞
- 影响：Tab webContents 仅挂 will-navigate 白名单（http/https/about），302 重定向到非白名单
  scheme（如自定义协议）时无拦截点；当前实际风险低——项目未注册任何自定义协议，且 Chromium
  自身阻止远程页面导航到 file:// 等本地资源
- 证据：`src/main/browser/tab-manager.ts` 仅注册 will-navigate（无 will-redirect）；
  electron.d.ts（43.4.0）will-redirect 说明 + 2026-08-13 探针实测（302 目标触发 will-redirect）
- 当前处理：暂不处理，留给 T5 安全审计评估
- 关闭条件：T5 安全审计给出处置——补 will-redirect 加固（→ Resolved）或记录风险可接受理由
  （→ Accepted）
- 最迟复核点：First Stage Exit Gate（T5 安全审计内）

### 计划内限制与延期项

（正常后续任务 / 已接受设计决议 / 明确延期，不虚构严重度与证据）

- PageSnapshot v1 仅采集主文档，跨域 iframe 内容 L1 降级跳过——已接受设计决议
  （detailed-design §12 决议 #13，快照为点时刻尽力采样）。
- 采集边界（T4 落地，非缺陷）：iframe 跨域计数为尽力采样（未加载完成的同源 iframe 可能被
  计为跨域，仅影响警告文案）；页面对主世界脚本的原型篡改可使采集返回 L2（按契约降级）；
  L2 触发路径（渲染进程崩溃/上下文失效）未在冒烟强制触发（normalize 单测覆盖 L2 形状）。
- 地址栏/标签栏/调试面板按钮的页面级点击驱动暂未被冒烟覆盖：冒烟覆盖主进程侧可观测行为
  （导航保护拦截、bounds 上报生效、多 Tab 状态流转、真实采集），React 交互路径经人工实际
  运行验证；页面级 UI 自动化属 T5 评估范围。
- 无 CI / 打包配置：第一阶段验收不要求；T5 收尾评估 CI（lint + test + typecheck），
  打包属 Seventh Stage（Product Hardening）。
- shared/url 不支持 IDN（中文域名走搜索兜底，安全无副作用）；SearchProvider 尚未抽象
  （Bing 硬编码，计划在 Second/Third Stage 前替换）。
- UI 窗口（defaultSession）未注册权限处理器：UI 只加载自身内容，R-01 已关闭（导航保护落地）
  后无远程页面可达，当前无需处理；未来 UI 嵌入远程内容时重新评估。

## 阻塞项

- 无。

## 下一个推荐任务

- **T5 收尾**：安全审计（§11 核对清单逐项 + R-02 Tab will-redirect 评估处置）→
  第一阶段验收清单逐项核对（First_stage.md §十四）→ README/文档同步（T4 内容、
  测试数与冒烟说明更新）→ 逐项勾选 Exit Gate，通过后停下向用户报告。

## 第一阶段验收未完成项

- 浏览器 UI 与 PageSnapshot 相关验收项已由 T3/T4 实现、待 T5 逐项核对；
  Engineering 中「TS 编译/lint/测试通过、README 启动方式」已被 T0 覆盖（README 内容
  待 T5 按 T4 现状同步）。逐项清单以 First_stage.md §十四 为准，T5 收尾时核对。

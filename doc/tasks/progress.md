# progress.md — 项目当前状态与短期工作记忆（主 agent 维护）

> 状态标记：⏳ 待开始 / 🔨 进行中 / ✅ 已完成 / ⛔ 阻塞。
> 高频更新：每个开发闭环后更新；保持结构化、精炼，供新 Agent 快速接管，不写长篇开发日记
> （历史细节进 git log / 任务文档）。任务粒度与文档职责见 AGENTS.md §2。
> ⚠️ 文档与代码实际状态不一致时，以 Git/代码/测试为准并修正本文件。

## 当前状态

- 阶段：第一阶段（浏览器核心）。T0 基线、T1 详细设计定稿、T2 浏览器核心完成，T3–T5 待执行。
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
| T3   | 浏览器 UI：顶部工具栏/标签栏/地址栏（URL 判断逻辑接入）/主区域                                   | ⏳   | 依赖 T2 ✅                                                     |
| T4   | PageSnapshot：PageReader + elementId + 调试面板显示 JSON                                         | ⏳   | 依赖 T2 ✅                                                     |
| T5   | 收尾：安全审计 + 第一阶段验收清单逐项核对 + 文档/README 同步                                     | ⏳   | 依赖 T2–T4                                                     |

## 最近验证结果（2026-08-13）

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

## 已知问题

- proposal Q1–Q4 已拍板（2026-08-13，决议见 doc/detailed-design.md §12）。
- PageSnapshot 当前 L2-only（T2 状态）：PageReader 采集脚本 T4 接入前，getPageSnapshot
  返回真实 L2 降级快照（主进程侧 url/title + 空集合 + degraded:'main-process-only' + warnings）。
- PageSnapshot v1 仅采集主文档，跨域 iframe 内容 L1 降级跳过（设计决议，快照为点时刻尽力采样）。
- 无 CI / 打包配置（第一阶段验收不要求）。
- shared/url 不支持 IDN；SearchProvider 尚未抽象（以后替换）。
- UI 窗口自身 will-navigate 白名单（detailed-design §9「T3 补上」）与渲染层 bounds 上报
  （ResizeObserver）尚缺 —— T3 落地；当前内容区用窗口尺寸兜底 bounds。
- 本机环境注意（`ELECTRON_RUN_AS_NODE`、安装代理、git `http.proxy`）已写入 AGENTS.md §6，勿在别处重复维护。

## 阻塞项

- 无。

## 下一个推荐任务

- **T3 浏览器 UI**：preload bridge 扩展（AibrowseBridge 白名单：tabs/nav/page/ui，
  见 detailed-design §3.2）+ 顶部工具栏/标签栏/地址栏（main 侧已规范化）/主区域；
  渲染层 ResizeObserver 上报 ui:content-bounds；UI 窗口自身 will-navigate 白名单（§9）；
  真实网页可经地址栏打开（T2 主进程能力已就绪，冒烟可选 AIBROWSE_SMOKE_URL 验证）。

## 第一阶段验收未完成项

- 除 Engineering 中「TS 编译/lint/测试通过、README 启动方式」已被 T0 覆盖外，其余全部待验收；
  逐项清单以 First_stage.md §十四 为准，T5 收尾时核对。

# progress.md — 项目当前状态与短期工作记忆（主 agent 维护）

> 状态标记：⏳ 待开始 / 🔨 进行中 / ✅ 已完成 / ⛔ 阻塞。
> 高频更新：每个开发闭环后更新；保持结构化、精炼，供新 Agent 快速接管，不写长篇开发日记
> （历史细节进 git log / 任务文档）。任务粒度与文档职责见 AGENTS.md §2。
> ⚠️ 文档与代码实际状态不一致时，以 Git/代码/测试为准并修正本文件。

## 当前状态

- 阶段：第一阶段（浏览器核心）。T0 基线完成，T1–T5 待执行。
- 最近 commit 与工作区状态：以 `git log --oneline` / `git status --short` 为准。
- 技术基线：2026-08-13 验证冻结（AGENTS.md §1）；依赖精确版本固定（package.json 无 ^/~）。

## 任务表

| 任务 | 内容                                                                                             | 状态 | 备注                                  |
| ---- | ------------------------------------------------------------------------------------------------ | ---- | ------------------------------------- |
| T0   | 项目基线（git/文档链/脚手架/测试基建/最小应用）                                                  | ✅   | 2026-08-13 完成，见 tasks/baseline.md |
| T1   | 详细设计定稿：接口契约/错误处理/preload 清单/Tab 状态机/采集算法 + proposal Q1–Q4 拍板           | ⏳   | 下一次会话建议执行                    |
| T2   | 浏览器核心：BrowserController + TabManager + WebContentsView + SessionManager（多 Tab 可开网页） | ⏳   | 依赖 T1                               |
| T3   | 浏览器 UI：顶部工具栏/标签栏/地址栏（URL 判断逻辑接入）/主区域                                   | ⏳   | 依赖 T2                               |
| T4   | PageSnapshot：PageReader + elementId + 调试面板显示 JSON                                         | ⏳   | 依赖 T2                               |
| T5   | 收尾：安全审计 + 第一阶段验收清单逐项核对 + 文档/README 同步                                     | ⏳   | 依赖 T2–T4                            |

## 最近验证结果（2026-08-13）

- T0 基线：test 15/15 ✅ · typecheck ✅ · lint ✅ · format:check ✅ · build ✅ · Electron 冒烟 ✅（退出码 0）
- 规范校准：技术矩阵按官方来源（npm registry metadata + 官方文档）验证通过并冻结；
  依赖树健康（`npm ls` 无 invalid/missing peer）。

## 已知问题

- proposal Q1–Q4 待 T1 拍板（elementId 映射、WebContentsView 生命周期、session 分区、快照降级粒度）。
- 无 CI / 打包配置（第一阶段验收不要求）。
- shared/url 不支持 IDN；SearchProvider 尚未抽象（以后替换）。
- 本机环境注意（`ELECTRON_RUN_AS_NODE`、安装代理、git `http.proxy`）已写入 AGENTS.md §6，勿在别处重复维护。

## 阻塞项

- 无。

## 下一个推荐任务

- **T1 详细设计定稿**：输入 doc/proposal.md §8 + doc/detailed-design.md（草案）。

## 第一阶段验收未完成项

- 除 Engineering 中「TS 编译/lint/测试通过、README 启动方式」已被 T0 覆盖外，其余全部待验收；
  逐项清单以 First_stage.md §十四 为准，T5 收尾时核对。

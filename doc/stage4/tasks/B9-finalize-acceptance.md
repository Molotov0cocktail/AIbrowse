# B9 — Fourth Stage 独立最终验收 + Exit Gate 判定 + 文档同步

> 第四阶段任务文档。验收清单 `Fourth_stage.md` §9（已按详细设计校准）与 §10
> Exit Gate；核对清单 `doc/stage4/detailed-design.md` §14。

## 目标

第四阶段独立最终验收：**不采信 B1–B8 完成报告**——在当前 HEAD 上重新独立复验
（步骤 0 全套：Git 三方一致/工作区干净/基线测试独立复跑），逐项核对
Fourth_stage.md §9 验收标准与 §10 Exit Gate，复跑冒烟全矩阵（含 SRT-01～SRT-12
与 RT 回归），红线 grep 独立复核，文档与代码一致性核对（契约源/AGENTS §5 速查
回填），总 Exit 决策（GO/PASS 或 HOLD/PENDING）。完成后停止：不实现 Fifth Stage
任何代码，等待用户指令。

## 前置依赖

- B1–B8 全部完成；本任务为收尾验收闭环。

## 范围

- §9 验收逐项证据表（Storage/Sources/AI/Engineering 四组，每项证据来源：单测/
  冒烟场景/审计条目/源码核对——独立复验不抄报告）；
- §10 Exit Gate 逐项判定：
  1. Source 系统在真实使用中可稳定保存、搜索和修改（含跨进程重启证据）；
  2. 重复 URL、canonicalization、删除语义已明确（唯一约束/恢复/Undo/hard
     delete 证据）；
  3. Agent 使用 Sources 时不会一次把整个数据库塞给模型（有界检索/allowlist/
     分享模式断言 + grep）；
  4. 备注与权限边界明确（note 不可信块 + 权限恒等 + provenance 展示）；
  5. FTS 是否足够已由实际使用验证（多语言矩阵 + 降级路径证据；如实结论）;
  6. **B1 决策门证据在案**（11 项实测通过记录 + 驱动冻结决议）;
  7. SRT-01～SRT-12 全矩阵通过 + RT 回归通过;
  8. 隐私扫描与真 Key 零暴露（真实验证时）通过。
- 全量验证独立复跑（test/typecheck/lint/format:check/build + dev+生产双场景
  冒烟）；
- 红线 grep 独立复核（万能工具/禁具/SQL 边界/Key 形态）；
- 文档同步：Fourth_stage.md §9 勾选与 §10 判定块、progress.md（任务表/最近
  验证结果/下一推荐任务）、AGENTS.md（§1/§5 速查回填——**含决议 #45 登记的
  4 处滞后性遗漏一并校准**）、README、各任务文档完成定义回填；
- 证据缺口裁决：若有缺口按 Third Stage A7 补验先例（定向补证或如实登记，
  不得放宽验收标准）。

## 非目标

- Fifth Stage 任何设计与代码；修改历史阶段文档结论；为通过验收放宽任何标准。

## 涉及模块

无新代码（纯验收 + 文档闭环）；若复验发现真实缺陷 → 回对应任务修复后重新
复验（本任务不直接改产品代码，修复归对应任务闭环或新修复任务）。

## 红态测试

- 独立复验发现任何与 B1–B8 报告不一致处 → 按「Git/代码/测试为事实」原则
  修正文档并裁决验收项（不得采信报告）。

## 实现步骤

1. 步骤 0 独立核对（HEAD/双远程/工作区/基线测试独立复跑）；
2. §9 逐项证据表 + §10 逐项判定；
3. 冒烟全矩阵独立复跑 + 红线 grep + 隐私扫描；
4. 文档一致性核对与同步（含 AGENTS §5 速查回填 + 决议 #45 校准）；
5. 总 Exit 决策 + progress 更新 + 最终报告（改了啥/验证了啥/剩余风险/
   下一个唯一任务）。

## 验收标准

- §9 全组 PASS（或如实 HOLD/PENDING + 缺口清单）；
- §10 全项判定有证据；总 Exit 决策明确（GO/PASS 或 HOLD/PENDING）；
- 全量验证全绿；文档与代码一致（速查回填后 grep 核对）；
- 完成后**停止**：progress 下一推荐任务唯一指向用户指令（Fifth Stage 前需求
  澄清，不擅自进入）。

## 全量验证

`npm test` · `npm run typecheck` · `npm run lint` · `npm run format:check` ·
`npm run build` · dev+生产双场景冒烟 · diff 终检 · 敏感信息扫描（验收闭环本身
零代码改动则按附 A 纯文档免 build/冒烟重跑——独立复跑已覆盖）。

## 提交要求

文档同步 commit（若有）；提交信息 `<type>: <中文描述>`；不提交临时数据/日志。

## 完成定义

Exit 决策 + 证据回填 + 文档同步 + 双远程推送 + 最终报告；B9 后无后续任务
（等待用户指令）。

## 风险与停止条件

- 复验发现未记录的真实缺陷 → 停止验收流程，回缺陷对应任务修复（或新任务），
  修复后重新复验——不得带缺陷判定 GO/PASS；
- 证据缺口无法补齐 → HOLD/PENDING + 缺口清单与补证建议（同 A7 先例）。

## 独立复验台账（B9 实施完成，2026-08-15，HEAD c8e4122）

### ① 步骤 0 独立核对

- 本地 HEAD `c8e4122ac1af0ff89a015b3aa2cf368c6a873473` = Gitee main =
  GitHub main（`git ls-remote` 实测；GitHub 操作前确认 127.0.0.1:7890
  代理 HTTP 200）——三方一致；工作区干净（`git status --short` 仅 `## main`，
  `git diff` 空、`git diff --check` 零命中）；`git show --stat c8e4122` =
  纯文档提交（AGENTS/Fourth_stage/README/threat-model/B8 任务/progress）。
- B1–B8 代码实际状态与报告一致：sources/ 全模块在位（db/domain/repository/
  tools/usage/source-ipc/sources-store + 52 个测试文件）。

### ② 受控独立验证（一次一条命令，单 worker，零重试变绿）

| 命令                                    | 结果                                                                 | 退出码 |
| --------------------------------------- | -------------------------------------------------------------------- | ------ |
| `npm test -- --maxWorkers=1 --no-color` | 52 文件 1229/1229 通过（19.55s）                                     | 0      |
| `npm run typecheck`                     | node+web 双 tsconfig 零错误                                          | 0      |
| `npm run lint`                          | 零错误                                                               | 0      |
| `npm run format:check`                  | All matched files use Prettier code style                            | 0      |
| `npm run build`                         | out/ 三目标（main 913.63 kB / preload 9.93 kB / renderer 660.43 kB） | 0      |
| `git diff --check`                      | 零命中；工作区干净                                                   | 0      |

### ③ 冒烟矩阵（env -u ELECTRON_RUN_AS_NODE + 独立系统 TEMP 临时 userData）

| 场景                             | dev                     | 生产产物            | 说明                                                                                                                                                                     |
| -------------------------------- | ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 默认全矩阵 `AIBROWSE_SMOKE=1`    | 退出码 0（1644 行日志） | 退出码 0（1631 行） | 含 B-01 11 项（①–⑦、⑩、⑪ 全过、⑧⑨ 可用）、8.6 RT-01～08+RT-11、8.9/8.10 B-03/B-04、8.11 B-05、8.12/8.13 B-06/B-07、8.14 recovery、8.15 SRT-01～SRT-12 全部通过行日志实证 |
| B-02 `AIBROWSE_SOURCES_SMOKE`    | —                       | set 0 / check 0     | 跨进程读回 + 重启后 Undo + 重复 Undo 幂等 + 版本冲突拒绝 + usage 投影一致 + SRT-10 hard delete 清理                                                                      |
| B-05 `AIBROWSE_SOURCES_UI_SMOKE` | —                       | set 0 / check 0     | 跨进程读回 + Undo + 两阶段永久删除（真实 UI 链路）                                                                                                                       |
| SESSION `AIBROWSE_SESSION_SMOKE` | —                       | set 0 / check 0     | 新进程读取 Cookie（跨进程持久化生效）                                                                                                                                    |

- 每轮后检查：零 Electron/Node 进程残留；冒烟临时 userData 的 sources/
  目录被场景自清（零 WAL/SHM 残留）；6 个 B9 专属临时目录全部精确清理
  （aibrowse-b9-smoke/*）；未触碰真实 userData；今日日志 sk- 形态零命中。

### ④ 红线独立复核（grep + 源码核对，不抄 B8 报告）

- **工具注册表**：BROWSER_TOOL_DEFINITIONS(8) + INTERACTION_TOOL_DEFINITIONS(4)
  - createSourceTools(4) + search_web(1) = **17**（index.ts 注册 + 冒烟断言）；
    禁具 source_sql/source_delete_hard/source_export_all/shell/child_process
    产品代码零命中（permission-policy.test 'shell.exec' 仅为 L3 测试夹具）。
- **SQL 执行点分类**：业务 SQL 仅 `sources/repository/`（编译期常量 + 参数
  绑定）；`db/sqlite-driver.ts` 仅连接级 PRAGMA（busyTimeout 程序校验整数
  [0,30000]）/事务；`db/backup.ts` 仅 PRAGMA/VACUUM INTO 窄契约；
  `db/migrations.ts` 仅编译期语句；`smoke.ts`/`*.test.ts` 为 SMOKE 测试设施；
  `snapshot-script.ts` 的 `.exec` 为正则方法（非 SQL）；renderer/preload/
  AgentLoop/Tool 零 SQL。
- **Electron 隔离**：contextIsolation:true/nodeIntegration:false/sandbox:true
  （index.ts:925-927）；setWindowOpenHandler 一律 deny；UI will-navigate+
  will-redirect 白名单；IPC 全部经 handle() sender+主帧校验；preload
  contextBridge 白名单（原始 ipcRenderer 零暴露、eventRelay 单次注册）；
  config.setKey 只写不回读；Source Tool 零 Electron import 零网络
  （source-tools.ts 仅 import 类型与纯函数）；usage-tracker 零 timer 零网络。
- **敏感通道**：redactUrlQueryValue（audit-log.ts:44）+
  sanitizeToolCallsForPersistence（agent-history.ts:69，SRT-08 修复在位）；
  SRT-08 逐通道字节扫描（运行时随机标记）dev+生产实测通过。

### ⑤ §9 逐项证据表与 §10 八项判定

- §9 四组 18 项全部勾选并回填证据（Fourth_stage.md §9，每项含本轮独立
  复验来源：源码行/测试文件/冒烟场景日志行）。
- §10 八项：① HOLD（真实 Provider 缺口；离线 PASS）②–⑦ PASS（②唯一约束/
  删除语义 ③有界检索 ④备注权限边界 ⑤FTS 如实结论——trigram ≥3 主路径 + 1–2
  字符安全降级，不宣称万能检索 ⑥B1 决策门证据在案 ⑦SRT 全矩阵 + RT 回归，
  RT-10 NOT RUN 计入①⑧同一缺口）⑧ 离线隐私扫描 PASS / 真 Key 扫描 NOT RUN。
- **总 Exit 判定 = HOLD/PENDING**——唯一缺口：真实 Provider 验收（用户本轮
  未授权；RT-10 + 真实 SRT-01/02 观察性场景 + §7 场景真实模型维度）。

### ⑥ 真实 Provider 硬门

- 按流程只询问用户一次 → **用户选择不授权**；本轮零付费调用、零公网请求；
  真实 Provider = NOT RUN（不冒充历史证据、不以 FakeProvider 替代）。
- 检查结果：产品侧 `AIBROWSE_LIVE_AGENT_SOURCES=1` 门控与
  `runLiveAgentSourcesScenarios`（§7 场景 1–5 AI 侧 + L2 确认门 + usage +
  真 Key 零暴露扫描）就绪；仓库外 harness（%LOCALAPPDATA%\AIbrowse\S5\
  run-live-smoke.ps1）**缺 -Sources 开关**（实测 grep 零命中，B6 记录属实）——
  补开关属 B6/B8 补验任务（仓库外文件，非产品/测试代码），B9 不越界补写。

### ⑦ P2/P3 开放风险独立处置（不照抄「非阻塞」）

| 项                       | 触发条件                                                   | 影响                                                      | 现有缓解                                                | 判定                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-2 日志无大小/保留上限 | 长期使用（每日一文件 appendFileSync 无界追加、无保留天数） | 磁盘占用缓慢无界增长                                      | .gitignore 防入库（与磁盘占用无关）                     | 不命中本阶段 §10 阻塞条件（§10 无日志保留要求；§9 诊断要求已满足）；为真实无界增长项 → 登记后续硬化（Seventh Stage Product Hardening 或专项闭环补大小/保留上限） |
| P2-3 会话无字节上限      | 单会话 200 条消息内持续追问/超大单条                       | 会话 JSON 文件可达 MB 级（有隐式上界：200 条 × 预算截断） | MESSAGE_LIMIT=200 条数上限 + 预算截断 + ToolStep 摘要化 | 不命中 Exit Gate（无卡死/数据丢失路径，规模有隐式界）；登记后续硬化                                                                                              |
| P2-4 Vitest 默认 worker  | 直接 `npm test` 不带 --maxWorkers=1 时默认并行             | 墙钟断言在并行负载下边缘抖动（F-1 已去墙钟化）            | 验证纪律显式单 worker（AGENTS §6）；本轮单 worker 全绿  | 不命中 Exit Gate（验证基础设施可信——命令显式固定）；建议后续 vitest.config 固化                                                                                  |
| P3 smoke 效率            | 每次冒烟矩阵分钟级                                         | 验证耗时                                                  | 无                                                      | 不命中 Exit Gate（效率非正确性）；登记后续优化                                                                                                                   |

### ⑧ 文档同步（本闭环）

- Fourth_stage.md：§9 全组勾选证据 + §10 逐项判定与总判定块 + 头部状态；
- B9 任务文档：本台账；
- progress.md：任务表 B9 ✅ + 当前状态 + 最近验证结果 + 开放风险独立处置
  结论 + 下一推荐任务（真实 Provider 补验，唯一）；
- AGENTS.md：§1 第四阶段状态（B9 完成 + HOLD/PENDING）+ 决议 #45 四处速查
  滞后项校准（ConversationStore v2 写入/ToolRegistry wire 双闸门/
  ClickAllowedKind・ElementSemanticsBinding/verifyReasoningReplay・
  formatAgentRunAuditMessage）；
- README.md：当前状态（B9 完成 + HOLD/PENDING）+ 已知限制补 v1 本地明文
  边界条目；
- detailed-design/threat-model：无陈旧（B8 已回填证据分类），未改。

### ⑨ 结论

- 离线验收面全部独立复验通过；B9 标记完成；**总 Exit = HOLD/PENDING**
  （唯一缺口 = 真实 Provider）；第四阶段保持为当前阶段；
- 下一唯一动作 = 真实 Provider 补验（B6/B8 补验任务：仓库外 harness 补
  -Sources 开关 + 用户授权后最小真实 Sources 验收；授权后沿用第三阶段
  DPAPI harness 流程）；**不得实现 Fifth Stage**。

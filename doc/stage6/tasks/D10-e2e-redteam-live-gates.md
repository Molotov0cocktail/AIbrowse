# D10 — Watch 端到端、红队、跨进程、真实条件与打包通知资格矩阵

## 目标

建立第六阶段完整机器验证闭环：Feed/Page→Baseline→Diff→Condition→Event/Evidence→Digest→Notification/UI，
WRT-01～WRT-19 独立红队，隐私字节扫描，跨进程恢复，少量真实网络/Provider 和 Windows 打包通知资格。

## 硬前置：D10-P0 正式契约复审

- detailed-design 决议 #S6-068 的 schema v5 契约候选必须先经**新的独立持久化/安全 Reviewer**审查并得到
  `PASS`；Reviewer 只能输出 `PASS / REPAIR / REPLAN / BLOCKED`。
- Reviewer `PASS` 前不得编写 D10 红队/live gate/smoke 8.27，不得调用真实网络或 Provider，也不得以 D9
  产品 Reviewer 的历史 `PASS` 代替本次正式契约复审；通过后才可进入 D10 产品实现与验收。
- `PASS` 后由 Planner 从复审通过的精确新 HEAD 重新确认 baseline 并生成 D10 Executor Execution Contract；
  未满足该前置时本任务保持待开始。

## 范围与非目标

- **做**：`AIBROWSE_WATCH_SMOKE=set|check`；dev+production 受控场景；19项红队；Entry/Exit体验映射；
  实际公开 RSS/Atom/robots/redirect；真实 Provider 有条件台账；Windows identity 有条件观察；长时资源探针。
- **不做**：以真实公网替代确定性 oracle；以 FakeProvider 冒充真实；绕 robots/captcha；为通过矩阵放宽契约；
  无界高频或大量真实请求。

## 涉及模块和输入文档

- `src/main/smoke-watch-*.ts`、`smoke.ts/index.ts` 最小门控接线、仓库外 live harness 扩展（不提交）。
- 输入：detailed §15；threat-model §6/§7；Sixth §7–§10；D1–D9 验收记录。

## 预计修改文件

- 新增 Watch smoke manifest/redteam/scan/live/gate/runner 模块与测试；smoke/index 只追加门控入口。
- 受控夹具进临时目录或源码小常量；不得提交真实用户数据、凭据、日志、截图、数据库或机器路径。

## 实施步骤（红→绿）

1. 红：manifest 列出 WRT-01～19/§7/§9 场景，旧结构逐项“未实现”失败；隐私允许面/禁止面先冻结。
2. 绿：逐项独立夹具/断言；端到端 cohesive 场景；跨进程 set/check；恢复/清理/资源矩阵；WRT-18 独立覆盖
   v4→v5 默认回填与旧列恒等、每条 v5 statement 失败完整回滚、v5 重开和 future=6 零写入 fail-closed。
3. 无 Key/非法门控/互斥路径证明请求0、进程/临时目录零残留。
4. 真实 Provider 按长期授权且凭据可用时运行最小 Digest 场景；记录次数/用途/结果分类；不可用写凭据不可用。
5. 真实公开网络限量，记录 URL 类别/HTTP 结果，不持久化正文；Windows identity 条件不足记 NOT RUN。
6. 全量、所有历史冒烟门控、隐私/Key/垃圾文件/依赖/工具/SQL红线扫描。

## 验收标准与测试

- WRT-01～19 每项有独立机器结果，结构性证明/真实观察/诚实限制分栏。
- WRT-18 明确包含 schema v5 迁移、回滚、重开与 future=6，不能只引用 v3/v4 或 D9 历史测试结果。
- Sixth §7 七项体验、§9 全项、§10 五项均映射到当前 HEAD 证据或明确未满足，不能选择性跳过。
- Watch 跨进程恢复、退出停止、reservation 三写原子与已消费 slot 零重放、一次 catch-up、5秒同 host
  间隔、仅80/443、XML各独立预算边界、Source version/fingerprint/用户意图及 hard-delete、Evidence双侧、
  Digest降级均可重复。
- Session 专项证明：原授权 Tab 关闭/新进程 catch-up 仍只凭 consent+pageUrl 新建 task Tab；host gate 在 create
  前；用户 Tab id/url/title/active 恒等；task tabId/handle/Cookie 零持久化；abort/timeout/redirect/login/
  cleanup failure 全部 fail-closed 且用户 Tab 零 close/navigate。
- dev+production、全量 test/type/lint/format/build/diff、历史 Session/Sources/Research 门控零回归。

## 完成定义

证据回填本任务/threat-model；独立安全 Reviewer PASS；逻辑提交；仍不判 Stage Exit Gate（归 D11）。

## 验收证据回填（2026-09-02）

### 状态、范围与独立审查

- D10 原始 baseline：`b9d956dc6b6eff626e3a668a2375de10380fc757`。
- Reviewer 批准的最终产品 HEAD：`5d6a3cb4c298f8a4aa9ad63c288f6d6c2f51c381`；其父提交为
  `cf57505af48b34b6e595b637ce40e4e2e77efca0`。当前证据只覆盖
  `baseline..5d6a3cb4`，没有把 Closer 文档收尾提交当作产品实现证据。
- 新的独立 Reviewer 已对精确产品 HEAD 作出 `PASS`。Reviewer PASS 之后未增加产品代码、测试、依赖或
  其它候选提交。
- D10 已完成；本回填不判 Sixth Stage Exit Gate，不开始 D11，也不进入 Seventh Stage。

### 结构性证明与受控机器证据

- D10 专项门控：`47/47`；WRT-01～WRT-19 每项均有独立受控机器断言通过。
- 全量 Vitest：`3427/3427`；`typecheck`、`lint`、`format`、`build`、dev/production 冒烟均退出码 `0`。
- `AIBROWSE_SESSION_SMOKE=set|check`、`AIBROWSE_SOURCES_SMOKE=set|check`、
  `AIBROWSE_SOURCES_UI_SMOKE=set|check`、`AIBROWSE_RESEARCH_SMOKE=set|check`、
  `AIBROWSE_WATCH_SMOKE=set|check` 均退出码 `0`；Sources/Watch IPC 退出竞态已关闭。
- 8×11 隐私矩阵通过：凭据、用户数据、原始 HTTP/HTML/PageSnapshot、Cookie/token/form、Source note、
  prompt/response、日志、数据库非 Evidence 列、renderer DOM、通知 DTO、导出和临时残留均按禁止面扫描，
  允许面仅保留验证后的有界结构化 Evidence。
- Feed/Page→Baseline→Diff→Condition→Event/Evidence→Digest→Notification/UI 的确定性链路、Session
  task-owned Tab、退出/恢复、reservation 三写、一次 catch-up、host 间隔、双侧 Evidence、Digest 降级、
  schema v5 migration/future=6 fail-closed 均已由当前 HEAD 的专项夹具和门控覆盖。

### WRT-01～WRT-19 独立结果

下表将结构性证明、受控机器观察和真实环境条件分栏；`PASS` 仅表示当前栏的证据已经满足对应 oracle，
不把真实环境未具备写成通过。

| 红队项 | 结构性证明 / 确定性 oracle                                        | 受控机器结果                                                          | 真实环境观察 / 限制                        |
| ------ | ----------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| WRT-01 | 地址分类与 IPv6 普通 GUA allowlist fail-closed                    | `PASS`，特殊/未分配地址零 socket                                      | 未依赖公网                                 |
| WRT-02 | DNS 混合解析、连接时换绑与批准地址 lookup                         | `PASS`，整次拒绝                                                      | 未依赖公网                                 |
| WRT-03 | 端口、scheme、redirect、downgrade 逐跳复验                        | `PASS`，危险目标零后续请求                                            | 未依赖公网                                 |
| WRT-04 | 共享 deadline、abort/destroy、业务终态与 emitter-local drain      | `PASS`，超时/慢流/压缩/多地址/redirect 夹具通过                       | 未依赖公网                                 |
| WRT-05 | RobotsGate、RFC 9309 octet/逐行解析、预算与 host 间隔             | `PASS`，robots 资格/边界/429/伪造入口断言通过                         | 公网 RSS/Atom 场景为 `blocked-environment` |
| WRT-06 | DTD/entity/XInclude 零 resolver、零文件/网络副作用                | `PASS`，XXE/Billion Laughs 夹具 fail-closed                           | 未依赖公网                                 |
| WRT-07 | XML 编码、深度、名称、属性、文本、节点和投影预算                  | `PASS`，各 `==` 接受、`+1` 拒绝                                       | 未依赖公网                                 |
| WRT-08 | Feed identity/去重、排序噪声与 observation idempotency 分离       | `PASS`，A→B→A→B→A 四观察和中间 Evidence 保留                          | 未依赖公网                                 |
| WRT-09 | Session grant 一次性、绑定与精确 task-tab 所有权                  | `PASS`，用户 Tab 返回 id 等敌手路径零 close/navigate                  | 未依赖公网                                 |
| WRT-10 | 重启 catch-up、焦点恢复、login/captcha、abort/cleanup fail-closed | `PASS`，owned Tab/用户 Tab/基线与事件 oracle 通过                     | 未依赖公网                                 |
| WRT-11 | Region、table fingerprint、iframe 与噪声边界                      | `PASS`，歧义/跨域 iframe 不制造假 Event                               | 未依赖公网                                 |
| WRT-12 | Hash-only、Evidence、Condition warning/error 分支确定性分离       | `PASS`，unexplainable 与 condition_error 均按契约处理                 | 未依赖公网                                 |
| WRT-13 | DigestFacts/ExplanationValidator 白名单、canonical 与零工具       | `PASS`，注入/duplicate/extra/non-canonical draft 整份拒绝             | Provider 凭据不可用，零真实调用            |
| WRT-14 | sharing 三档、Source note 隔离、factsRevision/hash CAS            | `PASS`，blocked/metadata 不越界，scrub 后迟到写回拒绝                 | Provider 凭据不可用，零真实调用            |
| WRT-15 | 通知隐私 DTO、dedupe 与内部 UUID 路由                             | `PASS`，query/敏感摘录默认隐藏，8×11 隐私矩阵通过                     | Windows 打包通知：未打包，`NOT RUN`        |
| WRT-16 | schedule reservation、DST/回拨、missed 合并与退出语义             | `PASS`，三写原子、每 Rule 一次 catch-up、已消费 slot 不重放           | 未依赖公网                                 |
| WRT-17 | Source rowVersion/fingerprint 分离、CAS、durable intent/reconcile | `PASS`，metadata 不丢结果，locator/删除竞态零孤儿网络                 | 未依赖公网                                 |
| WRT-18 | watch.db 预算、journal/cursor、复合 FK、v3/v4/v5 migration 与恢复 | `PASS`，v5 默认回填/旧列恒等、逐语句回滚、重开、future=6 零写入均通过 | 正式长时资源资格另列限制                   |
| WRT-19 | 公共 HTML SAX 零脚本/子资源/Cookie 与有界投影                     | `PASS`，script/iframe/私网子资源/巨树夹具通过                         | 未依赖公网                                 |

### 真实条件与诚实限制

- 公网 RSS/Atom：`blocked-environment`，必需真实场景未成功完成；受控网络/解析 oracle 仍已完成。
- Provider：凭据不可用，零真实调用；未以 FakeProvider 冒充真实语义证据。
- Windows 打包通知：未打包，`NOT RUN`；应用内通知及安全降级由受控证据覆盖。
- 正式资源资格：`condition-unavailable/observation-insufficient`，未宣称长期资源 `PASS`。
- 上述限制不否定 D10 验证基础设施和确定性红队闭环已完成；其对 Sixth §9/§10 及 Exit Gate 的影响由
  D11 新独立 Stage Auditor 重新判定。

## 依赖与停止条件

- 依赖 D1–D9，且 #S6-068 必须先经新的独立持久化/安全 Reviewer `PASS`；D11 依赖本任务。
- 红队发现产品缺陷即 REPAIR/REPLAN；真实站点变化不得放宽确定性断言；Key/打包身份/网络不可用如实 NOT RUN。

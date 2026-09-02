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

- 已有 D10：`src/main/smoke-watch-*.ts`、`smoke.ts/index.ts` 最小门控接线、仓库外 live harness 扩展
  （不提交）。
- H3b 资格实现不能只改 smoke：允许新增 main-only `src/main/watch/qualification/**` 和最小 x64 native bridge/
  build 接线，并在下面“H3b 实施范围”列出的真实产品所有权点增加 qualification-only instrumentation。
- 输入：detailed §15；threat-model §6/§7；Sixth §7–§10；D1–D9 验收记录。

## 预计修改文件

- 新增 Watch smoke manifest/redteam/scan/live/gate/runner 模块与测试；已有 smoke/index 门控保持最小。
- H3b 可新增 qualification bootstrap/protocol/sequencer/registry/temp-binding/trace 模块、窄 native identity
  bridge 及其测试，并在获准真实模块添加 acquire/release/terminal/admission 观测；不得借 instrumentation 改
  业务语义、公开接口、安全边界或阈值。
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

> **H1 校正（2026-09-02）**：本节旧 `47/47` 与 `b9d956d…` baseline 声明已过期。已有一轮
> `observedForMs=99` 失败，H1 REPLAN 又在同一固定集合单次观察到 `47/47`；两者共同分类为
> `unstable-timing-defect`，不能把概率性绿态写成修复。新的 D10 Reviewer 必须使用 `d85667c…` 为完整
> 审查起点。

### 状态、范围与独立审查

- D10 首个大型实现提交：`b9d956dc6b6eff626e3a668a2375de10380fc757`；它不是可排除自身的审查 baseline。
- `git rev-parse b9d956d^` 机器结果为 `d85667c54a354d322b0180d4c17873860a86c611`，且
  `d85667c..b9d956d` 只有该大型实现提交（15 files，2,347 insertions/14 deletions）。新的完整 D10 审查起点
  固定为 `d85667c54a354d322b0180d4c17873860a86c611`；H4 必须审查
  `d85667c54a354d322b0180d4c17873860a86c611..新候选HEAD`。
- Reviewer 批准的最终产品 HEAD：`5d6a3cb4c298f8a4aa9ad63c288f6d6c2f51c381`；其父提交为
  `cf57505af48b34b6e595b637ce40e4e2e77efca0`。当前证据只覆盖
  `baseline..5d6a3cb4`，没有把 Closer 文档收尾提交当作产品实现证据。
- 新的独立 Reviewer 已对精确产品 HEAD 作出 `PASS`。Reviewer PASS 之后未增加产品代码、测试、依赖或
  其它候选提交。
- 历史 D10 实现闭环完成，但当前重新资格状态为 HOLD；H2/H3a/H3b/H4 尚未完成，不开始 D11，也不进入
  Seventh Stage。

### 结构性证明与受控机器证据

- D10 专项集合固定为以下 8 个文件、47 项；最新一次单次结果为 `47/47`，但当前资格仍因未稳定计时缺陷
  HOLD：

| 测试文件                                 |   项数 |
| ---------------------------------------- | -----: |
| `src/main/smoke-watch-admission.test.ts` |      6 |
| `src/main/smoke-watch-gate.test.ts`      |      3 |
| `src/main/smoke-watch-live.test.ts`      |     25 |
| `src/main/smoke-watch-manifest.test.ts`  |      4 |
| `src/main/smoke-watch-redteam.test.ts`   |      2 |
| `src/main/smoke-watch-runner.test.ts`    |      3 |
| `src/main/smoke-watch-scan.test.ts`      |      3 |
| `src/main/smoke-watch-digest.test.ts`    |      1 |
| **合计**                                 | **47** |

- `smoke-watch-live.test.ts` 的“生产资源端口把测量窗口与排水窗口分开并保留真实时间戳”仍为概率性缺陷：
  产品使用 `setTimeout(100)` 后的 `Date.now()` 相减；已有轮次实际 `observedForMs=99`、断言 `>=100` 失败。
  H1 REPLAN 按上述固定 8 文件只运行一次，结果 `47/47`；未自动重跑，也不以这次偶发绿态覆盖 99ms 证据。
  H2 仍必须建立确定性红态并修复单调计时 oracle。
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

| 红队项 | 结构性证明 / 确定性 oracle                                        | 受控机器结果                                                        | 真实环境观察 / 限制                        |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| WRT-01 | 地址分类与 IPv6 普通 GUA allowlist fail-closed                    | `PASS`，特殊/未分配地址零 socket                                    | 未依赖公网                                 |
| WRT-02 | DNS 混合解析、连接时换绑与批准地址 lookup                         | `PASS`，整次拒绝                                                    | 未依赖公网                                 |
| WRT-03 | 端口、scheme、redirect、downgrade 逐跳复验                        | `PASS`，危险目标零后续请求                                          | 未依赖公网                                 |
| WRT-04 | 共享 deadline、abort/destroy、业务终态与 emitter-local drain      | `PASS`，超时/慢流/压缩/多地址/redirect 夹具通过                     | 未依赖公网                                 |
| WRT-05 | RobotsGate、RFC 9309 octet/逐行解析、预算与 host 间隔             | `PASS`，robots 资格/边界/429/伪造入口断言通过                       | 公网 RSS/Atom 场景为 `blocked-environment` |
| WRT-06 | DTD/entity/XInclude 零 resolver、零文件/网络副作用                | `PASS`，XXE/Billion Laughs 夹具 fail-closed                         | 未依赖公网                                 |
| WRT-07 | XML 编码、深度、名称、属性、文本、节点和投影预算                  | `PASS`，各 `==` 接受、`+1` 拒绝                                     | 未依赖公网                                 |
| WRT-08 | Feed identity/去重、排序噪声与 observation idempotency 分离       | `PASS`，A→B→A→B→A 四观察和中间 Evidence 保留                        | 未依赖公网                                 |
| WRT-09 | Session grant 一次性、绑定与精确 task-tab 所有权                  | `PASS`，用户 Tab 返回 id 等敌手路径零 close/navigate                | 未依赖公网                                 |
| WRT-10 | 重启 catch-up、焦点恢复、login/captcha、abort/cleanup fail-closed | `PASS`，owned Tab/用户 Tab/基线与事件 oracle 通过                   | 未依赖公网                                 |
| WRT-11 | Region、table fingerprint、iframe 与噪声边界                      | `PASS`，歧义/跨域 iframe 不制造假 Event                             | 未依赖公网                                 |
| WRT-12 | Hash-only、Evidence、Condition warning/error 分支确定性分离       | `PASS`，unexplainable 与 condition_error 均按契约处理               | 未依赖公网                                 |
| WRT-13 | DigestFacts/ExplanationValidator 白名单、canonical 与零工具       | `PASS`，注入/duplicate/extra/non-canonical draft 整份拒绝           | Provider 凭据不可用，零真实调用            |
| WRT-14 | sharing 三档、Source note 隔离、factsRevision/hash CAS            | `PASS`，blocked/metadata 不越界，scrub 后迟到写回拒绝               | Provider 凭据不可用，零真实调用            |
| WRT-15 | 通知隐私 DTO、dedupe 与内部 UUID 路由                             | `PASS`，query/敏感摘录默认隐藏，8×11 隐私矩阵通过                   | Windows 打包通知：未打包，`NOT RUN`        |
| WRT-16 | schedule reservation、DST/回拨、missed 合并与退出语义             | `PASS`，三写原子、每 Rule 一次 catch-up、已消费 slot 不重放         | 未依赖公网                                 |
| WRT-17 | Source rowVersion/fingerprint 分离、CAS、durable intent/reconcile | `PASS`，metadata 不丢结果，locator/删除竞态零孤儿网络               | 未依赖公网                                 |
| WRT-18 | watch.db 预算、journal/cursor、复合 FK、v3/v4/v5 migration 与恢复 | DB 结构门 PASS；专项最新单次 47/47，但 99ms/100ms 未稳定计时仍待 H2 | 正式长时资源资格另列限制                   |
| WRT-19 | 公共 HTML SAX 零脚本/子资源/Cookie 与有界投影                     | `PASS`，script/iframe/私网子资源/巨树夹具通过                       | 未依赖公网                                 |

### 真实条件与诚实限制

- H3a 硬门尚未闭环：真实公网 RSS/Atom、真实无 RSS public Page Watch fallback、真实网络失败分类/退避/
  清理均须按 detailed-design §15.4 完成；既有公网 RSS `blocked-environment` 不能作为 PASS。
- Provider：凭据不可用、零真实调用；这是非阻断条件性观察，未以 FakeProvider 冒充真实证据。
- Windows packaged notification：未打包、`NOT RUN`；这是非阻断条件性观察，应用内通知及 unavailable
  降级仍为必需产品证据。
- Session 真实登录网站是条件性观察；task-owned Tab、授权、重启、隐私和失败闭环受控门仍是硬门。
- H3b 正式资源资格：`condition-unavailable/observation-insufficient`，未宣称 PASS；资源实现必须严格采用
  detailed-design §15.6 的 Job accounting、逐 Node type/总量、电池 Battery Class IOCTL、可回放产品 registry
  及 DB/FileId/Restart Manager 排水口径。当前隔离 userData 启动仍有
  `GPU process isn't usable. Goodbye.`，在同机最小 Electron 对照闭环前分类为 `BLOCKED`。

## H3b 实施范围与红态合同（H1 冻结；当前未开始）

H3b 是本任务的后续正式资格实现，不受“只改 smoke 模块”的旧范围限制，但只允许下列按所有权点收口的范围：

- `src/main/index.ts`：在 logger/single-instance/BrowserWindow/Watch service 前接入非秘密 qualification app arg、
  bootstrap 和关闭顺序；常规启动必须零行为。
- 新的 `src/main/watch/qualification/**`：exact schema、incremental decoder、overlapped client adapter、sequencer、
  registry、sample barrier、opaque temp binding、trace counter；以及 repo-owned 窄 x64 native identity bridge。
  如 Electron ABI/build packaging 要求，可最小修改 `electron.vite.config.ts`、`package.json`、
  `package-lock.json` 和新增 native
  build 文件；只允许 exact-version build dependency，禁止通用 FFI/任意 Win32 bridge。任何新 runtime capability、
  无法复现的预编译 binary 或需要扩大 renderer/preload 能力都必须停止 REPLAN。
- `host-request-gate.ts`、`public-watch-http-client.ts`：grant/request/response/socket 的真实创建、交付、
  close/drain 点；`watch-scheduler.ts`、`digest-scheduler.ts`：真实 timer set/clear；`digest-service.ts`：Provider
  attempt 与 Digest Promise；`watch-task-tab-workspace.ts`：owned tab/WebContents claim/release。
- `watch-store.ts`、`db/watch-driver.ts`、`repository/watch-repository.ts`：Store/DbHandle acquire/close、同源逻辑
  bytes、DB/temp lifecycle；`watch-run-coordinator.ts`、`watch-acquisition-service.ts`、
  `watch-processing-service.ts`、`watch-lifecycle-coordinator.ts`：run/acquisition/processing/cleanup Promise 和唯一
  terminal latch；`watch-ipc.ts`、`watch-notification-service.ts`：renderer admission、notification Promise/
  terminal。只在确有真实生命周期所有权的文件接线，不允许以集中轮询或测试 snapshot 冒充。
- 上述文件的聚焦单元/集成测试、`smoke-watch-live-*` 的 qualification red-state/runner/gate，以及仓库外 x64
  harness。harness 源/二进制/ledger 不提交，但其 hash、编译器/SDK 版本、签名分类、命令/result schema 和
  一次性运行目录必须进入脱敏证据；不得放真实路径/pipe 名/nonce。

实施前必须建立能在 legacy HEAD 稳定为红的 oracle，至少逐项证明：

1. harness 是 `FILE_FLAG_FIRST_PIPE_INSTANCE|PIPE_REJECT_REMOTE_CLIENTS` current-logon DACL 的唯一 server；
   同账户伪 server/client、错误 PID/creation、nonce/run 重放、第二连接、断连/重连全部被拒且无秘密出现在
   argv/env/child/log/db。half-frame/multi-frame/invalid UTF-8/CRLF/duplicate key/oversize/unknown key/乱序/
   duplicate slot/backpressure/deadline 均 fail-closed，main event loop 可继续推进独立 heartbeat。
2. sample-open/close barrier 下，trace prefix replay 与 snapshot 逐 identity 恒等；真实固定负载使适用的
   host/request/response/socket/timer/async/store/db/tab registries 分别出现非零峰值。对每一类强制 close error、
   late settlement、terminal race，unregister 只能在真实 close/settlement 后，counter 只增且不得靠进程退出归零。
3. `watch-temp-lease` 的 nonce-HMAC binding 与无 reparse 专属 root 的 OS relative entries 逐项相等；正文、路径、
   URL、Cookie/Key 零 trace。symlink/junction/reparse、case collision、escape、rename、duplicate、cleanup failure
   有独立敌手用例；DB FileId/RM owner 与 product Store/DB registry 交叉而非“文件存在即连接”。
4. Battery port 零枚举、全 documented absence、query-tag `ERROR_FILE_NOT_FOUND`、invalid tag、short output、
   relative/unknown、unsupported present battery、AC/charging/discharging/Rate 矛盾、热插拔/tag reuse、cleanup
   failure 均命中 detailed-design §15.6.4 唯一分类；no-battery 只由完整成功枚举产生。
5. `CreateProcessW` 机器测试证明 `lpApplicationName` 是 exact repo Electron 43.4.0 exe、`.` 从 repo CWD 解析
   package main=`./out/main/index.js`、初始 PID 是 browser/main、无 wrapper；suspended assignment、嵌套 Job
   failure、kill-on-close、Chromium child capture、root 先退/child 残留和 Toolhelp PID reuse/snapshot race 都按
   §15.6/§15.7 唯一 oracle 裁决。observer 资源不进 Watch registry，但必须仍出现在 Job/handle/Node totals。

上述红态、实现、聚焦绿态、全量/构建/production smoke、隐私/垃圾/进程终检和新的独立 H3b 安全/资源
Reviewer `PASS` 缺一不可。当前 H1/H2/H3a 不得预跑或声称这些 H3b 结果。

## H2 计时修复合同（H1 后生效）

1. 先建立可稳定复现“timer 已到但墙钟差为 99ms”的红态 oracle；不得依赖概率性 sleep。
2. 测量/排水持续时间、窗口归属和 deadline 只由单调时钟裁决；wall clock 只生成独立可审计 UTC 时间戳。
3. 保留 `observedForMs >= 100`；不得降低/放宽断言、删除用例、skip、自动重复或选择成功轮次覆盖失败。
4. H2 只修计时/oracle 与相应 D10 证据；不得提前执行真实网络、资源资格、Provider 或 Windows 通知。
5. H2 Reviewer PASS 后，当前专项必须是同一固定 8 文件/47 项集合在确定性 clock seam 下的稳定 `47/47`；
   H1 的单次 `47/47` 不满足本条。

## 后续严格顺序

1. H1 契约候选经新的独立安全/资源 Reviewer `PASS`，Closer 更新 progress、提交并双远程 push；
2. H2 计时/oracle 修复并经 Reviewer `PASS`；
3. H3a 完成 detailed-design §15.4 三个必需真实网络门并经 Reviewer `PASS`；
4. H3b 完成 detailed-design §15.6/§15.7 资源与标准 Windows 生命周期资格并经 Reviewer `PASS`；
5. H4 由新的独立 Reviewer 审查 `d85667c…新候选HEAD` 完整区间并 `PASS`；
6. 才可启动新的独立 D11 Stage Auditor。

任何步骤不得越序。Provider 与 Windows packaged notification 若条件可用，可单独作非阻断观察，但不得混入
H3a/H3b 制造额外硬门。

## 依赖与停止条件

- 依赖 D1–D9，且 #S6-068 必须先经新的独立持久化/安全 Reviewer `PASS`；新的 D11 依赖 H4 PASS。
- 红队发现产品缺陷即 REPAIR/REPLAN；真实站点变化不得放宽确定性断言；Key/打包身份/网络不可用如实 NOT RUN。

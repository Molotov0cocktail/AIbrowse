# D10 — Watch 端到端、红队、跨进程、真实条件与打包通知资格矩阵

## 2026-09-07 工程授权更新

按 AGENTS.md「工程自治授权」推进；旧固定角色、冻结工程方案、单次诊断耗尽与逐项审批限制不再阻止必要实现。
H3a 可按 detailed-design §15.4 更新真实 RSS 目标并执行有界请求，保留 BBC/NASA 失败及 16/64 原始账本。
default-dev/default-prod 分别建立诊断与前瞻稳定性证据，保留历史 unknown；单次成功不算修复。
RSS、完整 default 两门仍需实际闭合；H3a → H3b → H4 → 新独立 D11 顺序不变，H4 审查起点仍为
`d85667c54a354d322b0180d4c17873860a86c611`。H3b 可按风险修订工程实现方案，但不得降低产品资源、安全、
隐私和验收承诺。每轮目的、范围、预算及结果进入受控证据，当前状态只写 progress，不扩展通用工作流。

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
- H3b 可新增 qualification启动认证/protocol/sequencer/registry/trace 模块、窄 native identity
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
>
> **H2 关闭（2026-09-06）**：H2 从 `cda11af90aa11a0e937c58647f58c762655d206f` 实施至
> `1e121401cc2e1221f55d881572583be75505df11`，再由 `9e41bd6f4ea55f8bb6a5a7c0f301502948a86c41`
> 修复小数单调时钟下限；新的独立 Final Reviewer 对精确产品 HEAD `9e41bd6` 判定 `PASS`。历史 99ms
> 红态与 H1 单次 47/47 均保留；当前分类改为 `timing-repair-verified`，下一唯一门为 H3a。H4 的完整审查
> 起点仍为 `d85667c54a354d322b0180d4c17873860a86c611`。

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
- 历史 D10 实现闭环完成，H2 已完成并经独立 Reviewer `PASS`；H3a/H3b/H4 尚未完成，不开始 D11，也不进入
  Seventh Stage。

### 结构性证明与受控机器证据

- D10 原专项集合固定为以下 8 个文件、47 项；H2 独立复验确认测试名称与顺序恒等并稳定 `47/47`。H2 另新增
  `src/main/smoke-watch-live-resource.test.ts` 24 项确定性计时/清理测试，合计 9 文件 `71/71`：

| 测试文件                                     |   项数 |
| -------------------------------------------- | -----: |
| `src/main/smoke-watch-admission.test.ts`     |      6 |
| `src/main/smoke-watch-gate.test.ts`          |      3 |
| `src/main/smoke-watch-live.test.ts`          |     25 |
| `src/main/smoke-watch-manifest.test.ts`      |      4 |
| `src/main/smoke-watch-redteam.test.ts`       |      2 |
| `src/main/smoke-watch-runner.test.ts`        |      3 |
| `src/main/smoke-watch-scan.test.ts`          |      3 |
| `src/main/smoke-watch-digest.test.ts`        |      1 |
| **原集合小计**                               | **47** |
| `src/main/smoke-watch-live-resource.test.ts` | **24** |
| **H2 合计**                                  | **71** |

- 历史实现以 `setTimeout(100)` 后的 `Date.now()` 差值裁决持续时间，已真实观察
  `observedForMs=99`、断言 `>=100` 失败；H1 的单次 `47/47` 未覆盖该缺陷。H2 先用可控 clock 稳定复现，
  再把 duration/window/deadline 统一到单调时钟，UTC 只保留为 canonical 审计时间；固定 deadline、早醒补等、
  single-settle、取消/非法 clock/timer error、listener 与迟回调清理均有确定性 oracle。修复后保持原
  `observedForMs >= 100`，没有放宽、删除、skip、自动重跑或挑选成功轮次。
- H2 Final Reviewer 全量 Vitest：`163 files/3451 tests`；`typecheck`、`lint`、`format:check`、`build`、
  `cda11af..9e41bd6` 与 `1e12140..9e41bd6` diff-check 均退出码 `0`。
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

| 红队项 | 结构性证明 / 确定性 oracle                                        | 受控机器结果                                                               | 真实环境观察 / 限制                        |
| ------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| WRT-01 | 地址分类与 IPv6 普通 GUA allowlist fail-closed                    | `PASS`，特殊/未分配地址零 socket                                           | 未依赖公网                                 |
| WRT-02 | DNS 混合解析、连接时换绑与批准地址 lookup                         | `PASS`，整次拒绝                                                           | 未依赖公网                                 |
| WRT-03 | 端口、scheme、redirect、downgrade 逐跳复验                        | `PASS`，危险目标零后续请求                                                 | 未依赖公网                                 |
| WRT-04 | 共享 deadline、abort/destroy、业务终态与 emitter-local drain      | `PASS`，超时/慢流/压缩/多地址/redirect 夹具通过                            | 未依赖公网                                 |
| WRT-05 | RobotsGate、RFC 9309 octet/逐行解析、预算与 host 间隔             | `PASS`，robots 资格/边界/429/伪造入口断言通过                              | 公网 RSS/Atom 场景为 `blocked-environment` |
| WRT-06 | DTD/entity/XInclude 零 resolver、零文件/网络副作用                | `PASS`，XXE/Billion Laughs 夹具 fail-closed                                | 未依赖公网                                 |
| WRT-07 | XML 编码、深度、名称、属性、文本、节点和投影预算                  | `PASS`，各 `==` 接受、`+1` 拒绝                                            | 未依赖公网                                 |
| WRT-08 | Feed identity/去重、排序噪声与 observation idempotency 分离       | `PASS`，A→B→A→B→A 四观察和中间 Evidence 保留                               | 未依赖公网                                 |
| WRT-09 | Session grant 一次性、绑定与精确 task-tab 所有权                  | `PASS`，用户 Tab 返回 id 等敌手路径零 close/navigate                       | 未依赖公网                                 |
| WRT-10 | 重启 catch-up、焦点恢复、login/captcha、abort/cleanup fail-closed | `PASS`，owned Tab/用户 Tab/基线与事件 oracle 通过                          | 未依赖公网                                 |
| WRT-11 | Region、table fingerprint、iframe 与噪声边界                      | `PASS`，歧义/跨域 iframe 不制造假 Event                                    | 未依赖公网                                 |
| WRT-12 | Hash-only、Evidence、Condition warning/error 分支确定性分离       | `PASS`，unexplainable 与 condition_error 均按契约处理                      | 未依赖公网                                 |
| WRT-13 | DigestFacts/ExplanationValidator 白名单、canonical 与零工具       | `PASS`，注入/duplicate/extra/non-canonical draft 整份拒绝                  | Provider 凭据不可用，零真实调用            |
| WRT-14 | sharing 三档、Source note 隔离、factsRevision/hash CAS            | `PASS`，blocked/metadata 不越界，scrub 后迟到写回拒绝                      | Provider 凭据不可用，零真实调用            |
| WRT-15 | 通知隐私 DTO、dedupe 与内部 UUID 路由                             | `PASS`，query/敏感摘录默认隐藏，8×11 隐私矩阵通过                          | Windows 打包通知：未打包，`NOT RUN`        |
| WRT-16 | schedule reservation、DST/回拨、missed 合并与退出语义             | `PASS`，三写原子、每 Rule 一次 catch-up、已消费 slot 不重放                | 未依赖公网                                 |
| WRT-17 | Source rowVersion/fingerprint 分离、CAS、durable intent/reconcile | `PASS`，metadata 不丢结果，locator/删除竞态零孤儿网络                      | 未依赖公网                                 |
| WRT-18 | watch.db 预算、journal/cursor、复合 FK、v3/v4/v5 migration 与恢复 | DB 结构门 PASS；原 8 文件 47/47 恒等保留，H2 新增 24 项后合计 9 文件 71/71 | 正式长时资源资格另列限制                   |
| WRT-19 | 公共 HTML SAX 零脚本/子资源/Cookie 与有界投影                     | `PASS`，script/iframe/私网子资源/巨树夹具通过                              | 未依赖公网                                 |

### 真实条件与诚实限制

- H3a 硬门尚未闭环：真实公网 RSS/Atom、真实无 RSS public Page Watch fallback、真实网络失败分类/退避/
  清理均须按 detailed-design §15.4 完成；既有公网 RSS `blocked-environment` 不能作为 PASS。
- Provider：凭据不可用、零真实调用；这是非阻断条件性观察，未以 FakeProvider 冒充真实证据。
- Windows packaged notification：未打包、`NOT RUN`；这是非阻断条件性观察，应用内通知及 unavailable
  降级仍为必需产品证据。
- Session 真实登录网站是条件性观察；task-owned Tab、授权、重启、隐私和失败闭环受控门仍是硬门。
- H3b 正式资源资格：`condition-unavailable/observation-insufficient`，未宣称 PASS；资源实现必须严格采用
  detailed-design §15.6 的 Job accounting、逐 Node type/总量、电池 Battery Class IOCTL、可回放产品 registry
  及 DB/FileId/Restart Manager 排水口径。旧沙箱内隔离 userData 启动的
  `GPU process isn't usable. Goodbye.` 失败证据保留；H2 独立复验已在合法沙箱外完成六个离线 Electron
  场景，但未执行同机最小 Electron 对照、正式负载或 10m/60m/10m 观察，不能据此判定 H3b。

## H3b 实施范围与红态合同（2026-09-07 单向资格工程修订）

本轮只替换采集/认证工程方法；detailed-design §15.6/§15.7是唯一完整契约，产品负载、数值、窗口、真实owner、
Job/CPU/文件/电池及标准GPU资格不变。H3a期间允许本设计准备；H3a PASS前不执行H3b正式资格。

- 编译期隔离qualification入口、薄native身份/QPC/单向writer、harness只读collector；普通build不含可达入口，
  normal build加app arg、renderer/网页/模型/env数据均不能授权或选择负载。index必要入口拆分只为在logger/
  单实例/DB/Window前完成认证/隔离，不改正常启动行为。
- native只五个operation：prepareLaunchIsolation/authenticateLaunchAndConnectTelemetry/readQpc/writeTelemetryFrame/closeTelemetry；
  exact fixed-root/peer identity、不可继承owned handles与OS completion必须真实，不能以TS brand或自报PID替代。
  无秘密、入站命令、任意路径/PID/Win32/SQL/raw buffer或通用temp写API。允许精确版本native构建依赖及最小
  package/vite/native build接线，不使用通用FFI或不明预编译binary。
- TS可新增qualification manifest/acquisition/release-gate/pausable-clock/registry/sequencer/controller/schema/trace；
  SourceService/Store-owned exact-100 empty-DB seed、WatchRepository exact Rule/Digest seed保持原normalizer/FTS/
  projection-readback/双revalidation。Sources公共API和用户数据语义不改变。
- 在HostGate/Coordinator/Scheduler/Digest/TaskWorkspace/Processing/Store/DbHandle/IPC/Notification真实所有权点
  注入可选qualification hooks；同一Clock decorator与固定about:blank adapter复用既有端口，NetworkPolicy/
  production acquisition没有fixture或.invalid/localhost例外。http/socket/provider/temp在固定负载仍全程0。
- 分工：native实现者独占native、native边界类型与仓库外harness；TS实现者独占其余qualification与产品接线、
  index/package/vite整合。共享schema先交付、共享构建/Electron串行；不为每个文件另建一轮大型审核。
  harness源/二进制/ledger不提交，保留编译器/SDK/产物hash与脱敏命令/result；真实roots/原始证据只在受控本地。

当前唯一 manifest/timing/artifact 合同是：descriptor 1,502 bytes、SHA-256
`3f59d95d74d373ef57e80eb56d05c4c9620a6e2bc2db8637ce5ddee48b5b85c3`；expanded manifest 34,252 bytes、
SHA-256 `5652b57e407b728e78a090b56aa84a73bc81f6b977e8a9e6211d3a48c15b6beb`；首末 Source 为
`e93ee316-71ae-4fff-a374-c0ea3ab12fdc`/`3f00bf7e-b7f0-4117-bb66-90e6732c2bf1`，首末 offset
`5,000/797,000`。Source 采用公开 domain SHA-256 deterministic v4-shaped id；Rule/Digest/Document 用
UUIDv5。business `D=M0+5,000+33,000*w`，qualification release
`R=M0+5,000+34,200*w+[0,900,000,1,845,000,2,700,000]`，完整 `Lslot≤34,000 ms`；初始化25×4、
31秒间隔，warmup indices33..99共67次，Digest在M0 boundary sample恢复后且不晚于M0+3秒seed，due分别为
M0+24/M0+46分钟。此段 supersede 下列legacy-red中所有旧manifest数值，但不删除其红态证据。

新增红→绿和机器反例聚焦如下，H1/H2未变化的静态/legacy证明按适用范围复用：

1. 旧实现缺少认证固定负载、567真实owner对/120 task Tab、原窗口和Digest oracle时稳定红；新实现必须经过
   SourceService→真实Scheduler/Coordinator/HostGate→DI acquisition→Processing/Repository/Digest/应用内通知。
   不用纯函数循环或直接写Event替代；normal build/错误capability/非manifest target或ordinal全部拒绝。
2. 真实direct-launch、suspended Job、root geometry/空库/无reparse与双方PID+creation：错parent、错writer、
   PID复用、同账户伪server/client、非继承失败、已有/换绑root、第二连接/断连不得获得能力或污染用户数据。
   同步native pin全部六root→首tick/任何await前固定setPath→异步认证→业务装配顺序必须稳定红绿；
   isolation ticket不能冒充业务capability。按Electron43.4.0实际原生启动/PathService/日志代码，核验全部固定键
   和最早可能IO；从CreateProcess起独立观察整个Job，包含延迟/失败认证、ready和退出，拒绝任何真实产品profile/
   Cookie/凭据/默认应用日志访问。隔离根内合成canary与故意前移读取/副作用证明观察能捕获open/read/write；
   不在真实用户目录制造测试数据。仅改APPDATA环境、mtime不变或JS hook不足；入口前仍有访问须先修最早路径选择。
   单向通道确无入站read-data/parent write-data；strict DTO、frame预算、partialIO、late-write、sequence/slot/
   prefix错误、队列backpressure、peer crash与CancelIoEx final-reap均有反例，main不阻塞。
3. 自发QPC freeze：共同frequency与原始ticks、真实write receipt、每组OS API begin/end、sample/closed/resumed
   exact配对与prefix恒等；跨窗/假完成/不同原点/缺记录/迟写/无2tick顺序余量不得PASS。保留全部
   500/250/750/1,250/2,000/250ms上限、absolute timer/stale callback、barrier mutation整轮FAIL；不能等live0。
   Coordinator历史与正式sample峰值4，HostGate不伪延长lease；Scheduler各≤1、其它owner仍受pause/Node总量；
   退出cleanupOf仍计入资源和原60秒门，不能漏掉新建排水Promise。
4. Job/Toolhelp双向完整identity、含已退出成员的Job CPU累计、main heap、Node各type及总量、FileId/RM/DBowner
   和std三handle/双流持续drain均独立实采。漏child、root先退、PID reuse、满capture后的GPU fatal与缺EOF必须红。
   temp无创建路径+零registry+逐slot OS空root共同证明；unexpected entry/reparse/root换绑/枚举失败不能硬编码为0。
5. Battery Class各port的exact struct/tag/absence/error/stale/relative/unknown/AC/PowerState/Rate/cleanup
   矩阵及第一次合法30分钟窗口完整保留；有电池AC不能N/A，合法窗超阈值仍FAIL-product。
6. 全量必要回归、production renderer/Watch smoke、独立安全/资源审查、正式10m/60m/10m和标准GPU机器证据
   才能关闭H3b。短纵向bootstrap→sample→stop诊断只用于实现验证，不能称正式资源资格。未知GPU历史不改写。

以下固定负载/排序/极值证明不因遥测变为单向改变；已接受且字节/算法未变化的H1证明可引用，新runtime必须与之吻合：

7. coalesce legacy-red 必须独立调用现有 `computeJitterMs()` 相同算法并覆盖 event Rule 的全部轮次。冻结旧
   `d06cb3d` descriptor=788 bytes/SHA=`7af65b3943123cc0a0e415ac23599699ea1cb2c076928aad6b434324f6b933a1`、
   first=30,000、step=8,400、rounds=0/15/30/45、Digest001 due=40min 与日期2026-09-02 UTC；全1440分钟分布
   必须为`13:84,14:363,15:545,16:352,17:96`，midnight稳定red为`14!=17`，不得重跑挑96个绿态。
   新 descriptor scheduledFor 仍按15分钟；release固定34.2秒波距与上述Q，测试须至少枚举4个UTC date的
   `1,440×100×4`（至少2,304,000 jitter，覆盖0/500）和release前、jitter、grant前后、task-tab create、
   acquisition/close、第二次revalidation、processing/writer全部barrier phase/边界笛卡尔积。
   每个预期 coalesce 必须证明实际 Event 时间差`≤905,500/860,500<1,800,000`，每个预期new Event必须证明
   `≥1,839,500>=1,800,000`；相邻/跨round全部release gap严格>`34,000`，last commit必须
   `≤M0+3,559,800`。Digest 000/001 只能读取已经完整提交的两轮/三轮，分别精确断言
   `changed/unchanged/failed=48/52/0, observation/Event=24/12` 与
   `78/72/0, 39/26`；queued/running 或下一轮任一 row 被预记都稳定红。任何 M0/Rule/边界失败都整体红，
   不能关 jitter、改 coalesce `<30m`、按 M0 选 seed 或降低断言。
8. 两套独立生成器必须命中 Source首末、Rule首末、Digest两个id及Document代表golden（以detailed-design
   §15.6.1为唯一值），并命中Digest canonical数组各1,951 bytes及SHA
   `3b8b7861854044ac55240680dfcf76161261544cdd3ceb286e7e28f82353dd7d`/
   `7225b4d9000aa989994f0784cb7245cccb46e0094b661067c2147f76c2ae44d3`。register/unregister root exact keys为
   `{detail,identity,registry}`；host-grant detail exact keys为
   `{attemptOrdinal,entryIndex,grantElapsedMs,hostSlot,phase,round,waitedForGap}`，coordinator-slot detail为
   `{entryIndex,hostSlot,phase,round}`，不得包含hostKey、URL、路径或秘密。Source seed必须拒绝非空库、重复/
   非法v4-shaped id、canonical/FTS不一致及真实Service missing/unavailable，且不能绕过Coordinator两次
   Source revalidation、NetworkPolicy或真实HostGate。

上述新增实现、聚焦红→绿、必要全量/构建/production smoke、隐私/残留终检与新的独立H3b安全/资源
Reviewer PASS不可省；不重复审计未受影响的H1静态证明，也不以它替代新运行结果。

## H2 计时修复合同（H1 后生效；2026-09-06 已关闭）

1. 先建立可稳定复现“timer 已到但墙钟差为 99ms”的红态 oracle；不得依赖概率性 sleep。
2. 测量/排水持续时间、窗口归属和 deadline 只由单调时钟裁决；wall clock 只生成独立可审计 UTC 时间戳。
3. 保留 `observedForMs >= 100`；不得降低/放宽断言、删除用例、skip、自动重复或选择成功轮次覆盖失败。
4. H2 只修计时/oracle 与相应 D10 证据；不得提前执行真实网络、资源资格、Provider 或 Windows 通知。
5. H2 Reviewer PASS 后，当前专项必须是同一固定 8 文件/47 项集合在确定性 clock seam 下的稳定 `47/47`；
   H1 的单次 `47/47` 不满足本条。

### H2 关闭证据

- 产品 baseline `cda11af90aa11a0e937c58647f58c762655d206f`；候选
  `1e121401cc2e1221f55d881572583be75505df11`；小数时钟修复候选及批准产品 HEAD
  `9e41bd6f4ea55f8bb6a5a7c0f301502948a86c41`。新的独立 Final Reviewer 审查完整
  `cda11af..9e41bd6` 与 repair `1e12140..9e41bd6`，结论 `PASS`。
- 三版本独立 driver 保留历史 99ms，证明旧候选在同一 `>=100` oracle 下失败、新候选通过；30 组
  origin/shutdown 与 timer-abort 补充矩阵全部通过。actual port → runner → ledger 保留 canonical UTC、数量和
  rollback 语义，UTC 回拨不改变 duration。
- 原 8 文件 47 项名称/顺序恒等，H2 新增 24 项，共 9 文件 `71/71`；全量 `3451/3451`，typecheck、lint、
  format:check、build 均退出码 `0`。dev/production 默认与各自 Watch set/check 共六个离线 Electron 场景均
  退出码 `0`；真实网络、Provider、凭据、系统通知和 H3b 正式资源资格 `NOT RUN`。
- 原始机器证据保留于 gitignored `log/h2-final-review-9e41bd6/`；首次独立审查证据保留于
  `log/h2-independent-review-1e121401/`。Reviewer 请求模型 `gpt-6-astra/high`，实际模型未回显。

## H3a XML 预算修订前置

Feed parser 的名称/namespace、逻辑文本、lexical、有限粗保护及编码 oracle 以 detailed-design §6.4 与 D3
“XML 预算与编码的现行验收补充”为准。先完成正式文档候选和新的独立设计审核，再执行有界产品修复、完整离线
验证及新的独立安全审核；通过后由 Planner 另行冻结真实补验合同。本修订不授权新增 live/diagnostic 入口、schema
或站点，不恢复已消费的单次 claim，不放宽既有 workflow 请求账本。

H3a 的 SourceService.addManual→Source locator/lifecycle→Repository/Scheduler/Coordinator→Acquisition/Processing
链路、真实 Feed/Page 首次与第二次观察、Public 无 RSS 页面路径、失败分类/退避及所有网络/资源/隐私约束保持原
契约。离线 fixture 和本修订验证不能冒充真实资格。历史 WRT-07 PASS 仅指原执行矩阵，新增 oracle 必须获得新的
产品证据。

产品修复轮允许既有测试及六场 Electron 的受控本地 fixture；外部真实公网、Provider 和 live/diagnostic gate 均为
零。不为 fixture 给产品 NetworkPolicy 增加 localhost/private 例外。H3a→H3b→H4→新 D11 的顺序保持不变。

## 后续严格顺序

1. H1 契约候选经新的独立安全/资源 Reviewer `PASS`，Closer 更新 progress、提交并双远程 push；
2. H2 计时/oracle 修复已在 `9e41bd6` 经 Reviewer `PASS`；
3. H3a 完成 detailed-design §15.4 三个必需真实网络门并经 Reviewer `PASS`（当前下一唯一任务）；
4. H3b 完成 detailed-design §15.6/§15.7 资源与标准 Windows 生命周期资格并经 Reviewer `PASS`；
5. H4 由新的独立 Reviewer 审查 `d85667c…新候选HEAD` 完整区间并 `PASS`；
6. 才可启动新的独立 D11 Stage Auditor。

任何步骤不得越序。Provider 与 Windows packaged notification 若条件可用，可单独作非阻断观察，但不得混入
H3a/H3b 制造额外硬门。

## 依赖与停止条件

- 依赖 D1–D9，且 #S6-068 必须先经新的独立持久化/安全 Reviewer `PASS`；新的 D11 依赖 H4 PASS。
- 红队发现产品缺陷即 REPAIR/REPLAN；真实站点变化不得放宽确定性断言；Key/打包身份/网络不可用如实 NOT RUN。

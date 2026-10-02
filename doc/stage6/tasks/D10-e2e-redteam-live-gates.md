# D10 — Watch端到端、红队与真实验收

当前实施任务为 **H3b-R：交付可解释的产品资源测量闭环**。这是2026-10-02重新选择的工程路线，
不恢复012/第十次classic ETW短测。状态只看 `doc/tasks/progress.md`；修订理由见 `../acceptance-replan.md`。
产品契约仍为detailed-design，安全契约仍为threat-model；本任务不授权减小负载、降低阈值或接受用户风险。

## 1. 已完成与待完成的边界

- D1–D9产品能力、D10已有端到端/19项红队/隐私/跨进程基础设施可以按影响复用。
- H1为历史工程设计，现有采集方案已由详细设计§15.6/§15.7替换；不重新执行H1。
- H2在 `9e41bd6f4ea55f8bb6a5a7c0f301502948a86c41` 独审关闭。原47项保留、新增24项，
  99ms历史失败及确定性单调计时修复保留，不重做该闭环。
- H3a已整体PASS。`e6233a9..4888fb7` 经独立审核；真实xkcd Atom robots→200→Baseline→304，
  Page/真实失败范围复用，RSS累计20次（旧16+新4），default dev/prod最终各3次完整通过。
  旧BBC/NASA、default历史原因unknown及全部失败保留。报告：
  `log/h3a-default-independent-current/h3a-convergence.md`；收尾同步于 `bcd38ee`。
- H3b至今未有正式长时资源结论。classic综合路线9次失败，另有早期诊断；局部模型/工具PASS不是H3b PASS。
  H4与D11尚未授通过。

## 2. 保留的D10产品验收

以下仍须映射到当前候选证据，不能被新资源方案替代或删掉：

1. Feed/Page→Baseline→Diff→Condition→Event/typed old/new Evidence→Digest→通知/UI完整链；
   `Sixth_stage.md` §7七项体验、§9全项、§10五项Exit逐项覆盖。
2. threat-model WRT-01～WRT-19独立红队；确定性结构、受控机器结果、真实观察及诚实限制分别报告。
   WRT-18含schema v5迁移/回滚/重开/future=6零写fail-closed，不只引用早期v3/v4证据。
3. Watch跨进程恢复、退出停止、reservation三写原子、已消费slot零重放、一次catch-up、5秒同host、
   仅80/443、XML各预算边界、Source version/fingerprint/用户意图与hard-delete、Digest降级。
4. Session授权Tab关闭/新进程后仍凭consent+pageUrl创建task-owned Tab；host gate在create前；用户Tab
   id/url/title/active不变；task tabId/handle/Cookie零持久化；abort/timeout/redirect/login/cleanup failure
   fail-closed，用户Tab零close/navigate。
5. dev+production默认及相关Watch门，Session/Sources/Sources UI/Research/Watch set|check；
   当前HEAD全量test/type/lint/format/build及红线/隐私扫描。8×11隐私允许/禁止面沿用已有专项，
   原始正文、凭据、Cookie/form、Source note、prompt/response不能因新观测而进入日志/DB/renderer。
6. H3a真实Public/robots/TLS/解析/Baseline/acquisition链；改变相关代码后补受影响真实验证，
   未变路径可复用独立接受证据。Provider、登录网站和packaged notification仍为条件性观察，
   有凭据时可作有目的真实产品检查，零Provider资源窗口不混用。

## 3. H3b-R实施合同

### 目标与范围

交付可版本管理、可重复运行的最小验收器，取得一次完整资源报告。报告可以诚实发现 `FAIL-product`；
任务的工程价值是产生可解释的产品结论。只有各硬门PASS才能关闭H3b并进入H4。

接管时先核实Git真实后继、工作区、当前产物及安全环境，不回退SHA。产品候选基准为 `43efffb`，
后续RSS修复为 `ee61ceb`；新的实现baseline由执行者记录实际HEAD。保留未知修改和原始日志。

预计范围：`src/main/watch/qualification/**`、`native/watch-qualification/**`、资格构建接线、
新增 `tools/watch-qualification/**`、受影响产品观测点及测试。可以替换内部协议/采样器，必要时调整架构；
不改Watch产品语义、数据格式、Browser/网络权限或依赖版本来掩盖验收失败。真实缺陷恢复既定行为可自主修复。
不实施Stage7，不重新开发通用ETW/Name/IRP模型，不把ignored log中的全部历史候选搬入Git。

### 执行次序

1. **立即判断安全环境是否可用。** 复核native早期隔离的实际覆盖边界；pins/app.setPath/环境变量不等于
   CJS入口前零真实数据访问。默认用无真实数据的独立普通测试身份/干净Windows环境并验证原用户profile/
   凭据不可访问。缺少条件就一次集中请求具体权限或物理操作；等待期间继续以下离线实现，不开发ETW替代用户动作。
2. **实现最小非暂停观察。** 复用固定100规则真实产品负载、Job累计CPU、身份句柄、registry真实事件和已有
   最小pipe。移除每10秒pause/freeze/rearm与跨域原子断言。main取同步prefix，外部各指标独立QPC区间，
   不将RM/电池/目录查询阻塞传播到产品或其它资源指标。工具源码与schema入Git。
3. **先验证工具不会错误通过。** 独立反例至少覆盖遗漏子进程CPU、PID复用、丢样/重复/迟到、counter回退、
   统计越界、未关闭DB/文件句柄、残余子进程/temp、假释放、普通build强开资格入口、伪writer和路径换绑。
   建立旧freeze行为与新非暂停行为的甄别测试；保留已通过业务负载与持久化测试。
4. **一次有界端到端短验。** 安全条件成立、关键安全改动独审通过后，在普通权限和默认GPU下运行≤10分钟
   测量可行性短验，使用真实应用产品路径和受控合成数据。交付main/OS原始序列、负载所覆盖子集、退出和精确清理。
   不伪称短验覆盖567次正式负载或60分钟门；无资源数据的又一次模型PASS不算完成。
5. **正式长测。** 短验数据完整可解释后，同一候选执行固定初始化及10m/60m/10m、361/61点、全部数值阈值；
   物理电池窗准备就绪后安排≥30分钟on-battery，保持零Provider。已答应提供窗口不等于当前已拔电，执行时通知。
   三次正常启动/退出稳定性证据可合并短验和正式轮，不多开一套重复审批。
6. **复核并修复。** 独立reporter从原始序列及关闭后DB复算结果；资源越界转具体产品修复；采集失败转工具修复。
   全部轮次保留。普通修复可合并实现与复核，安全/并发/持久化改动保留新独立审核。

### 预设换路与停止条件

- 首次端到端短验不能得到可信资源数据时，停止扩展正式封存/通用证明功能，输出一个可复现反例和具体归因。
  有新证据后可修复复验；同一原因两次修复仍无新增信息时主协调必须换观测方法/拆问题，不机械续号或推给用户。
- 无须为新方案、工程文件范围或每次请求重新申请权限。真正缺少系统权限/测试身份/物理拔电才集中请求；
  不反复消费旧就绪答复，不把过去某次诊断次数变成永久停工锁。
- 有真实数据泄漏风险立即停止相关运行；资源门发现真实越界不能调阈值、隐藏成本或选择较低样本。
- 不以采样等待超时修改产品90秒run、60秒退出等承诺；每次运行必须有操作超时和精确收口。

### 验收与交付

- 详细设计§15.6固定负载、CPU/RSS/private/heap/handle/Node/进程/DB指标、退出、电池及§15.7生命周期
  逐项报告PASS/FAIL-product/BLOCKED，附实际数值/缺证原因。隐私专项缺证时H3b总门不能PASS。
- 同一候选的normal build与qualification build隔离保留，addon完整性检查、normal build不可达资格入口。
- 运行资料只含合成内容和脱敏标识；原始结果有来源、schema、版本、时间、完整/缺失标识，独立可复算。
  不要求又一套通用密码学封存系统；已有适用完整性检查可复用。
- 运行`npm test -- --maxWorkers=1`、typecheck、lint、format:check、build和受影响dev/prod/跨进程门。
  中间迭代用聚焦测试；最终产品候选不能省全量。静态与纯模型结果不能代替真实资源报告。
- 独立审核确认H3b所有硬门后更新progress，正常提交；整个待推区间经H4审核后才能把候选历史推向双远程。
  单独文档REPLAN通过不授权把尚未验收的H3b产品历史整体发布为完成状态。

## 4. H4与下一阶段

H4完整baseline固定为 `d85667c54a354d322b0180d4c17873860a86c611`，不排除最初D10实现。
Reviewer核对完整候选差异、WRT/隐私/恢复、H3a适用性、H3b原始产品证据和当前全量门；
可复用不受影响的独审结果，不能只信实现者报告。H4准备可并行，H3b未通过不能授H4最终PASS。
H4后启动新独立D11。Stage6关闭后按用户授权完成Stage7入口/风险/设计/任务，停在第一个产品实现之前。

## 5. 历史与清理义务

完整旧D10合同及2026-09-02矩阵保留于Git `d976ac5:doc/stage6/tasks/D10-e2e-redteam-live-gates.md`；
当前接受的H2/H3a报告及全部H3b失败原件保持。历史合同的工程freeze/固定路线/逐项许可不再约束H3b-R。
固定网络预算原账本不清零。旧7ZH的4096-byte canary身份未完整恢复，不能盲删。

任务结束后按 `log/native-build-install/` 的安装前后和removal-inventory清单，通过官方安装器移除本任务新增
Build Tools/MSVC/SDK；保留原有SDK/WPT/调试工具/运行库，不自动重启。卸载前先确认后续任务不再依赖它，
执行结果回填progress，不能仅删下载包冒充卸载。

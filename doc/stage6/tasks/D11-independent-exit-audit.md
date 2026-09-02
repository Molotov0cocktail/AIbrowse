# D11 — Sixth Stage 新独立 Stage Auditor、Exit Gate 判定与文档闭环

> **当前状态：HOLD/PENDING。**H4 PASS 前禁止启动本任务；历史 D11 尚未执行，不能沿用旧上下文、
> `observedForMs=99` 失败或任一次偶发 `47/47` 作为 H2 已修证据。

## 目标

使用新的独立 Codex GPT-5.6 Sol 上下文，在当前 HEAD 从零接管并复验第六阶段全部正式契约，只输出
GO/PASS 或 HOLD/PENDING；PASS 后由 Closer 做确定性文档/远程收尾并停止，不进入 Seventh Stage。

## 前置依赖

D1–D9 已关闭；D10 后续必须严格完成 H1 Reviewer/Closer → H2 Reviewer → H3a Reviewer → H3b Reviewer →
H4 新独立完整区间 Reviewer。只有 H4 对
`d85667c54a354d322b0180d4c17873860a86c611..候选HEAD` 给出 PASS、progress 无阻塞产品缺陷且候选已按
Closer 合同收尾后，才满足本任务前置。

## 范围与非目标

- **做**：三方 SHA/工作区；完整 D10 区间与关键实现/测试；Sixth §9/§10；全量
  test/type/lint/format/build；dev+production 全冒烟、Watch/Session/Sources/Research 跨进程门控；WRT；
  隐私/Key；H3a 必需真实网络；H3b 资源与标准 Windows 生命周期；Provider/Windows/Session 条件性观察。
- **不做**：采信历史自述、顺手修复、放宽验收、进入 Seventh Stage、把 NOT RUN 写成 PASS。

## 涉及模块和输入文档

- 全仓只读审查；输入 `Sixth_stage.md`、stage6 四文档、D1–D10、progress、AGENTS、Git/代码/机器输出。
- Closer 只有 PASS 后可修改 progress/AGENTS/README/验收回填。

## 预计修改文件

- Auditor 默认零修改。
- PASS 后 Closer：`doc/tasks/progress.md`、必要的 `AGENTS.md`/`README.md`、D11 验收记录；不改产品代码。

## 实施步骤（独立验收）

1. 新上下文 Step0：本地/Gitee/GitHub SHA、代理、工作区、依赖、Node/Electron、设计/代码漂移。
2. 审查全部 candidate diff 与任务范围，核对 D1–D10 红态 oracle 真实甄别新旧结构。
3. 独立复跑全量静态/构建、dev+production、跨进程、WRT、隐私/Key、生命周期/资源。
4. 按 Sixth §9 与 §10 建证据表。H3a/H3b 硬门缺失或失败必须 HOLD；Provider、Windows packaged
   notification、真实 Session 登录网站条件不可用则明确 NOT RUN，但不据此阻断。
5. 只给 GO/PASS 或 HOLD/PENDING；发现缺陷发 REPAIR/REPLAN，修复后重新独立复验。

## 验收标准

- RSS/Atom、Page Region/Diff、结构化条件、Event 双侧 Evidence、Digest/通知、调度/退避/资源全部当前 HEAD 证据。
- H3a 三项全部为真实产品路径证据：公网 RSS/Atom、无 RSS public Page Watch fallback、真实失败分类/退避/
  清理且零假 Event；fixture 不替代。
- H3b 完整满足 detailed-design §15.6 固定资源 oracle 与 §15.7 标准 Windows/GPU 生命周期；当前机器
  `GPU process isn't usable. Goodbye.` 记录不得被其它机器成功覆盖。资源证据必须来自 §15.6 冻结的专属
  Windows Job 累计 CPU、PID+creation time 瞬时资源、main 单值 heap、逐 Node type+总量、Battery Class
  absolute mWh 与结构化可回放 registry/DB owner 排水；日志字符串、当前成员 CPU 求和、relative battery、
  文件存在性或顶层变量置 null 均不能替代。
- Auditor 必须从 clean build 机器证据核对 H3b 根进程由 `CreateProcessW` 直接启动 exact repo Electron
  43.4.0 exe，以 repo CWD 的 `.` 解析 `package.json.main=./out/main/index.js`；无 npm/cmd/electron-vite wrapper，
  初始 PID 就是 browser/main。suspended Job assignment、kill-on-close、零 breakaway、Chromium child 捕获、
  Toolhelp/Job 的 PID+creation FILETIME 双向全集、root 先退后的排水和 root process exit code 必须全部闭合；
  环境/handle allowlist 或 build hash 缺证即 HOLD。
- qualification trace 必须来自 harness first-instance/reject-remote/current-logon DACL server 与 main client；
  bootstrap 在双向 PID+creation 验证后才交付高熵 pipe 名/nonce，argv/env/Chromium child/log/db/renderer 零秘密。
  Auditor 必须复核 exact-key JCS、bounded incremental UTF-8/LF、deadline/backpressure、无重连、双向 sequence、
  sample-open/close barrier 和每 sample 唯一 prefix replay；仅有 `{registry,identity}`（缺 exact `detail`）或可挑 prefix 的 snapshot
  不合格。同账户伪装、half-frame/CRLF/重复/乱序/重放/断连敌手证据缺失即 HOLD。
- Auditor 必须重建并核对 `watch-h3b-load-v1` 1,502-byte descriptor 及固定
  `3f59d95d74d373ef57e80eb56d05c4c9620a6e2bc2db8637ce5ddee48b5b85c3` SHA-256，并独立展开
  34,252-byte 100-entry manifest、命中固定
  `5652b57e407b728e78a090b56aa84a73bc81f6b977e8a9e6211d3a48c15b6beb` hash、deterministic v4-shaped
  Source首末`e93ee316-71ae-4fff-a374-c0ea3ab12fdc`/`3f00bf7e-b7f0-4117-bb66-90e6732c2bf1`与
  `scheduleOffsetMs=5,000/797,000` golden；逐项确认100 Source/Rule、SourceService empty-DB bootstrap保持
  sources100/FTS100/tag-links0、真实projection/fingerprint与双revalidation，以及40 Feed/40 public Page/20 Session
  Page、四`.invalid`host、冻结且不得后移的M0、A=28秒包含Session verified close、四host同波、33秒business/
  34.2秒release波距、25×4初始化31秒间隔、67 warmup（indices33..99，末波≤M0-18.8秒完成）与四轮400
  measurement acquisition。scheduledFor必须仍按15分钟推进，qualification release固定为
  `R=M0+5,000+34,200*w+[0,900,000,1,845,000,2,700,000]`；完整`Lslot≤34,000ms`，跨全部
  M0/Rule/barrier phase/worst-case时延必须得到coalesce`≤905,500/860,500ms`、new Event`≥1,839,500ms`与
  measurement last commit `≤M0+3,559,800`。两个 Digest 按index选成员、按unsigned UTF-8 bytes排序存储，
  只能纳入完整两轮/三轮，oracle分别为
  `changed/unchanged/failed=48/52/0, observation/Event=24/12` 与
  `78/72/0, 39/26`。资格 acquisition 必须从
  Coordinator 既有 `WatchAcquisitionPort` DI 注入，只在 authenticated bootstrap 后可达；NetworkPolicy/
  production acquisition 无 fixture 分支。H3b 的 Watch http-request/response/socket/provider/temp registry 应
  全程为0；host-grant应有567对、per-host141/142/142/142、gap/no-wait/final0，sample0合法且peak仅诊断，
  不能伪延长为lease。全局peak4必须由与Coordinator activeGlobal同步的独立`coordinator-slot`证明；通用async
  保持nested Promise语义，task-tab exact120/peak4/final0。不得因上述五类为0判“没有压力”，也不得用
  synthetic socket补峰，真实
  网络生命周期归 H3a。
- Auditor须用Node与独立PowerShell/.NET两套生成器逐byte命中detailed-design §15.6.1全部Rule/Digest/Document
  golden、两个Digest canonical数组各1,951 bytes及SHA
  `3b8b7861854044ac55240680dfcf76161261544cdd3ceb286e7e28f82353dd7d`/
  `7225b4d9000aa989994f0784cb7245cccb46e0094b661067c2147f76c2ae44d3`。legacy-red固定旧`d06cb3d`
  descriptor=788 bytes、日期2026-09-02 UTC；全日分布须为`13:84,14:363,15:545,16:352,17:96`，midnight
  稳定证明`14!=17`，不得以未定义canonical day或挑96个绿态替代。
- sample-open 必须先 pause admission/scheduler/digest/fixture owner、保存 absolute timer deadline，只等待 main
  sequencer writer quiesce，再在单一 JS turn 截 main snapshot；OS sample 后 close，按原 deadline resume。
  `Clock`同步API不得伪装await，不能等live resource=0后采样；物理frame→linearize≤500ms、logical→sample≤250ms、
  frame→sample≤750ms、sample→close≤1,250ms、frame→close≤2,000ms、close→resume≤250ms，所有外部deadline
  从完整frame起算且不在dequeue重置；barrier内mutation必须整轮失败而非排队。
  CONNECT/READ/WRITE 每 operation 独占 OVERLAPPED/event/buffer；timeout 后 `CancelIoEx`（包括
  `ERROR_NOT_FOUND` race）必须等 final completion 才 release/reuse，single-completion 与 peer crash teardown
  缺任一机器证据即 HOLD。
- Watch temp lease 必须以 nonce-HMAC opaque token 与无 reparse 专属 root 的 OS relative entries 在 barrier 内
  逐项相等，trace 不含 absolute/relative path、正文、URL 或凭据；symlink/junction/rename/case collision/
  cleanup 敌手矩阵必须闭合。Battery no-battery 只可来自成功完整 SetupAPI 枚举且所有 port 是 documented
  absence，并与 SystemPowerStatus 一致；tag error、exact struct/output bytes、relative/unknown、热插拔、
  PowerState/Rate 矛盾和 cleanup 任一未闭合都不得判 H3b PASS。observer 不进 Watch registry，但仍必须计入
  Job/OS/main/Node totals，禁止扣除观察成本。
- nonce 必须严格解码为 32-byte raw HMAC key并只留在 native locked owned memory；domain-separated message、
  两个 frozen token golden、collision/duplicate fail 与 complete/error zeroize 都须复验，Chromium child 零 key。
  RFC 8785 实现必须有 product/harness 独立 golden，覆盖 UTF-16 key order、non-NFC reject/no normalization、
  duplicate/lone surrogate/invalid UTF-8 与 safe-integer；普通 JSON.stringify/UTF-8 sort 不合格。Battery
  success+invalid tag 与初始 `ERROR_NO_SUCH_DEVICE` 必须 invalid，合法 tag 后 `ERROR_NO_SUCH_DEVICE` 必须走
  stale/change 下 slot 重枚举，不能算 absence。
- production handle ledger 必须证明 `CreatePipe` 后 read ends 经 `SetHandleInformation` 取消继承、
  `STARTF_USESTDHANDLES` 的 stdin/out/err 与三-handle allowlist 完全一致、harness 在 resume 前关闭 child ends。
  drain thread 到 capture 上限后仍读并扫描完整 GPU fatal stream；最终同时具备 root exit=0、Job active=0、
  stdout/stderr EOF+thread join，root 单独退出不算通过。
- Provider 与 Windows packaged notification 不是 Exit Gate 硬门：确定性 Digest 在无 Provider 时仍成功且
  `explanation=null`；应用内通知必需，系统 sink identity 不可用时诚实 unavailable。不得用“恰好一次底层
  HTTP 请求”评判 Provider PASS。
- Session 结构/隐私/受控 Electron 门必需；真实登录网站成功仅为无需账号、凭据或额外权限时的条件性观察。
- 噪声不会大量误报、失败与变化区分、应用退出语义诚实、数据保留明确。
- 结构性证明/真实观察/诚实限制分开；watch.db 明文/iframe/系统通知/后台限制如实。
- 工作区无凭据/用户数据/日志/临时文件/未解释变更；双远程只在 PASS 后由 Closer 推送。

## 完成定义

Auditor=GO/PASS；Closer 更新事实源、最终状态/格式/敏感检查、文档提交、推 Gitee 与经代理 GitHub；
三方 SHA 一致、工作区 clean；报告下一唯一动作“停止并等待用户明确切换 Seventh Stage”。

## 停止条件

H4 未 PASS、任一 §9/§10 未满足、H3a/H3b 硬门 NOT RUN/失败、验证失败、产品/设计漂移、敏感信息/垃圾、
远程不一致或需要产品修复 → HOLD/PENDING；不得用文档措辞掩盖。Provider、Windows packaged notification
或真实 Session 登录网站单独 NOT RUN 不触发 HOLD，但必须保留诚实限制且不得写 PASS。

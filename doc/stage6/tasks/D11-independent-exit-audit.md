# D11 — Sixth Stage 新独立 Stage Auditor、Exit Gate 判定与文档闭环

> **当前状态：HOLD/PENDING。**H4 PASS 前禁止启动本任务；历史 D11 尚未执行，不能沿用旧上下文、
> `observedForMs=99` 失败或任一次偶发 `47/47` 作为 H2 已修证据。

## 目标

使用新的独立 `gpt-6-astra/xhigh` 上下文，在当前 HEAD 独立接管并复验第六阶段正式契约，只输出
GO/PASS 或 HOLD/PENDING；实现者自述不能替代验证。依 2026-09-07 用户授权，PASS 后 Closer 完成文档/双远程
收尾，主 Prompter 自动继续 Seventh Stage 入口、风险承接、必要设计和任务准备，停在首个产品实现任务启动前。
未受影响的已通过证据可说明范围后复用，最终整体验收和必要回归不能省略。工程方案修订遵守 AGENTS.md
「工程自治授权」，不因旧冻结措辞阻止合理修订，也不得降低产品、安全、隐私与资源验收要求。

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
- qualification变体必须共享同一产品模块/commit/依赖，普通build编译期无可达资格入口。Auditor核对native
  同步pin全部六root、首tick/任何await前同步固定setPath、随后异步direct-parent/main PID+creation认证，
  认证后才装配logger/DB/Window；FileId匹配parent冻结值，准备ticket不是业务capability。按实际Electron43.4.0
  源码与CreateProcess起全Job独立IO观测复核入口前/延迟或失败认证/ready/退出不触及真实产品profile/Cookie/凭据；
  合成canary及提前访问反例必须证明观测有效，APPDATA变量、mtime或单次成功不能证明隔离。
  单向pipe main只写/parent只读、first-instance/reject-remote/logon DACL与全部non-inherited
  handles真实。错误parent/伪writer/非空或换绑root、断连/乱序/迟写/缺frame必须有反例；TS brand不能授权。
  协议不再处理秘密、入站命令或HMAC。Auditor以detailed§15.6.2 version2 strict DTO与唯一sequence核验实际trace。
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
  Coordinator 既有 `WatchAcquisitionPort` DI 注入，只在编译期资格入口与native身份/隔离认证后可达；NetworkPolicy/
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
- 每sample必须由共同QPC固定slot自主freeze，pause一个Clock decorator的全部owner并保持absolute deadline，
  只等writer而非live资源归零。原500/250/750/1,250/2,000/250ms上限全部满足；native write receipt与
  sample/closed/resumed真实时间、prefix恒等、零barrier mutation及parent每个OS API组全过程被freeze包含须
  逐slot可证。跨进程±1tick顺序不确定按2tick余量拒绝，不能比较不同performance.now原点或只看API完成时间。
  缺closed/resumed、假时间、跨窗、迟写、计时重置和barrier内排队必须红；不得借单向采集降低原缺样要求。
- parent CONNECT/READ与child WRITE的OVERLAPPED/event/buffer独占、timeout CancelIoEx后final-reap、peer
  crash/close与Job收口有机器证据；无入站功能不要求新增入站代码。observer不入Watch registry但仍计入全部
  Job/OS/main/Node总量。stop后禁止新业务，cleanupOf清理Promise全部计数并受原60秒/10分钟排水门。
- temp固定负载无创建路径、product零lease、每slot无reparse/稳定FileId的OS空root三者一致；unexpected
  entry/root替换/枚举或close失败不得PASS。删去HMAC/temp写能力不能删OS观察，不声称验证任意rename场景。
- Battery Class完整port/tag/returned-byte/absence/error/stale/relative/unknown/PowerState/Rate与cleanup分类
  仍逐项按§15.6.4执行；合法on-battery能量/百分比两个阈值同时通过，AC不等于N/A。JCS/NFC/duplicate/
  surrogate/UTF8/safe-integer等仍适用的writer/collector golden必须独立，不能共用错误实现互证。
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
三方 SHA 一致、工作区 clean；按本轮授权接续 Seventh Stage 入口检查、风险承接、必要设计与任务准备，
停在该阶段首个产品实现任务启动之前。

本轮最终交付另须完成用户要求的临时系统工具清理：按安装前后差异，通过官方安装器移除本轮新增的
VS2022 Build Tools/MSVC 与 Windows SDK，清理对应下载包和安装缓存；保留原有、其他软件共用组件与
验收原始证据。记录卸载结果和任何未移除项；发现新增外部依赖时报告并请求裁决，不静默保留。

## 停止条件

H4 未 PASS、任一 §9/§10 未满足、H3a/H3b 硬门 NOT RUN/失败、验证失败、产品/设计漂移、敏感信息/垃圾、
远程不一致或需要产品修复 → HOLD/PENDING；不得用文档措辞掩盖。Provider、Windows packaged notification
或真实 Session 登录网站单独 NOT RUN 不触发 HOLD，但必须保留诚实限制且不得写 PASS。

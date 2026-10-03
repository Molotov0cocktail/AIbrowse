# progress.md — 当前状态与下一任务

> 唯一进度源。历史放Git/原始证据；不再逐轮累积开发日记。风险编号不重排、不复用。

## 当前结论（2026-10-04）

用户已明确授权 Stage7 E1–E6 实现、验证、必要独立审核和阶段收尾，取代历史 E1 前停止边界。
本次接管 HEAD 为25a6aa5489b0596d529b97d62eab8ee789bb1e70，main干净，双远程跟踪引用同点。
入口文档已同步；E1差量合同见doc/stage7/tasks.md。E1实现、验证与新的独立安全审核已PASS，已提交并同步双远程。
E1实现提交fabcb2111c005a2f493f02dd30110279bb4451e7；Gitee直连、GitHub代理HTTP200后使用http.proxy推送均exit0，
两端ls-remote均核对同SHA。最终暂存106文件无日志/产物/私有数据，敏感扫描只命中两个已核baseline的测试字面量。
下一实施范围为E2维护准入、真实排水与容量合同闭合；不可信容器读取/解析须等待其预算冻结。
范围为Windows x64未签名内部候选、手动升级；不公开发布/自动更新，Stage7完成后停止。
并行子任务请求模型按AGENTS调度；工具未回显actual时记不可验证。

E1最终独审为PASS（`log/stage7-e1/independent-e1-final-review-001.md`），仅授E1，不授E2–E6或Stage7整体通过。
受审工作区106文件清单SHA256为e859f35d5b05dc02bc7fbcdd6e3c529dfca5652bd9d38668178d2b9a9a245e70。
首轮REPAIR/REPLAN原件`independent-review-interim-001.md`及全部失败保留。
IPC值schema、取消确认后的Key显示、第二实例聚焦与凭据配额已修复；实际包动态门由同候选005的Product与Tamper证据共同关闭。
Electron安全资格已据上游公告从43.4.0修订为精确43.7.7，Vitest安全补丁升至4.1.11；须在最终候选重做受影响门。
43.4.0壳资格、普通production三次失败和release构建红态原件均保留在`log/stage7-e1/`，不以旧包静态PASS代替最终运行。
2026-10-04用户确认没有独立Windows环境：E5独立环境硬门BLOCKED，继续实现和开发机验证，Stage7不得关闭。
旧profile隔离预检证实AppData/既有aibrowse卷与路径身份不一致，实际rename被拒绝，私有目录未移动或跨卷复制。
用户随后授权清空现有开发版数据，已受控执行；原件在`log/stage7-e1/authorized-profile-reset-9fc28e79375a4c87b009a1e5361f8787/`。
新根为MSIX虚拟化映射，KnownFolder别名/实体128位FileID、卷及ACL一致；改用空根合成scope与固定Job执行入口，
获得独立执行范围PASS（`independent-disposable-scope-review-001.md`）。不再需要空白账户，不恢复旧rename路线。
该同机scope不能替代E5；最终实际EXE证据与未通过的早期轮次分列如下。
Electron43.7.7六场景安全资格009及独立复验通过；全量213文件4119测试通过（full-tests-002.txt），需纳入后续增量终检。
production008默认全部PASS/正常退出；此前A04量化/隔离世界观测位置及D9精确DOM等待问题已修订工具并保留失败。
production session/sources/research/watch四组set/check共8进程通过（cross-production-001）。
trace定位ContextBadge重复preview累积Electron加载监听，已按Tab/世代合并。production009真实30更新峰值不涨且归零，
后段L3发现主进程明确none被误判unavailable，已红→绿修复并独审；最新聚焦2文件25项通过。
实际probe已加强为renderer明确确认全部30条且页面仍loading后再释放响应；dev-default001及production-default010完整通过，
均确认30条、监听baseline/peak=2/2且完成后0，无监听超限警告。normal build011对应最终普通production产物。
dev/production各五组set/check合计20进程通过；最终全量218文件4158测试通过（final-full-tests-001），
final-typecheck/lint/format-001通过。全量包含E2独立准备工具测试，不授E2产品通过。
release候选004静态独审通过，EXE SHA256为514a93eaa26d6f743fa0270d632de5fb09e2463f5fee7f72261af20d81ffdcbd。
首次实际All在Product的Snapshot操作失败，原因是工具未先打开默认关闭的AI侧栏；未进入Tamper。
失败journal为disposable-profile/journal-24fe0464b8074846851a6f18624c5d80，Job实际归零、marker与目录身份复验通过。
UIA流程已修复，固定失败合成目录的完整归档/新根工具经独审准入，第一轮原件完整归档。
第二轮journal-23c0ec96cc854f129338c1652fbf8867在credentials.json.tmp→final触发实际EXDEV，未进入原生确认或Tamper。
只读诊断确认KnownFolder声明路径与实体是同一Windows对象，Node普通realpath保留声明路径，realpathSync.native返回实体路径。
已保持Electron逻辑userData/Session不变，在单实例锁之后、logger/Store之前验证并固定全部Node持久化实体根；
不加入复制回退。固定九个成员作流式路径/对象检查，无累计文件数上限，深度32；源码差量已独审限定PASS。
新红绿及独审111项通过；native-root-production-default-001与native-root-cross-production-001共11进程通过，
普通production主入口绑定D012E189976A49D8622C5C00258681803F36CA4DEC3D9417E9415D8DA984C97B。
release候选005静态独审通过，EXE SHA256为88d7370c5569c3c08d50971ea3171459b5f5c07464663be3d30309183e70710e。
实际All加入已确认首进程终止后的同profile冷重启，核对原Key/配置版本与凭据世代、历史会话、三空库重开；
该工具使用受控强制终止，不将它写成正常关闭证据。工具差量独审限定PASS。
候选005首次实际All（journal-06a4b476c6694474b5a1cd04d72fd47b）已进入原生目标确认，但UIA工具未识别弹窗而失败；
Job归零且现场保留，Tamper未运行。只确认此前EXDEV未在该步骤重现，不授完整持久化或原生确认门通过。
工具按Win32窗口owner关系替换UIA顶层枚举假设。后继journal-0b39a32e1eaf43a3bea20e579bb6ae2b确认原生#32770窗口
与main同PID、owner精确相符；该轮因UIA选中同名但不支持InvokePattern的元素而失败，原元素类型未记录，
尚未点击取消，Job归零、原件保留。
工具统一收紧可交互选择器并补反例；不以标题单独认领窗口，不用坐标或系统消息回退。
后继journal-8f23042cf5a24539ba4d0854654ee291因非敏感设置值的即时读回假设失败，已改有界收敛等待。
最新journal-bfaadf81d8784fdb9429bbe4d31a5bee证明实际TaskDialog取消/确认控件为Pane、无InvokePattern，
WinForms Button夹具不覆盖此平台控件。已停止实际profile复跑，先做真实TaskDialog的公开语义动作资格；
两轮均Job归零、marker复验通过、失败原件保留；这些轮次未提供原生取消/确认、冷重启或Tamper通过证据。
同版Electron TaskDialog的MSAA语义默认动作已独审限定PASS（取消response0、确认response1、重复候选拒绝）。
候选005后继journal-b997103bbdd14bf1ae6987564f82d956的Product报告已PASS：原生取消/确认、3次合法绑定请求、
零重定向接收、第二实例恢复聚焦及同profile冷重启成立；配置/凭据哈希、世代与文件身份保持。
UTF-8字节canary扫描89文件、135项、4381680字节零命中；不将该扫描单独泛化为所有编码的泄漏证明。
该All在Tamper的ESM AppData探针顶层等待ready时悬挂，已受控停止，All失败及Product成功原件分别保留，Job归零。
探针改为ready前读取固定路径，最小真实资格已退出；新空scope的固定Tamper-only续验入口正由独审核准，
它绑定已有Product证据与同包哈希，不重复已通过产品序列、不改写旧All失败。
最终Tamper journal-8edf39ba16924ace964b70341acfc2ef实际PASS：原包存活、三个调试端口全未监听，
一字节等价空白篡改与移走ASAR后裸app两个反例均exit1拒绝、canary零执行；Job归零、marker复验通过。
独立复算`independent-release-dynamic-binding-001.json`确认两份报告与当前005 EXE/ASAR/header一致。
native-root-dev-default-001及native-root-cross-dev-001五组10进程均已通过。
final-full-tests-002为222文件4203项PASS；final-typecheck/format-002及final-normal-build-002通过。
final-lint-002的新工具入口错误已修；final-lint/typecheck/format-003与diff-check-003全部通过，E1门已闭合。
本轮smoke旧RT-10日志误写“未授权”，已修为“本轮未注入真实Provider凭据”；原件不改写，真实Provider仍NOT RUN。
E2只做独立容量资格准备，工具位于tools/data-qualification；最终run-003报告为
`log/stage7-e2/2026-10-03T17-59-41-617Z-7936/report.json`。预算尚未全部冻结，未开始E2产品导入实现，未授E2 PASS。
补测envelope-Hs4Ih1覆盖Research接近预算、Watch逻辑预算99.228%及Conversation结构/编码；不能把物理样本当历史上界。
独立utility资格前两轮在UI初始化失败，第二轮诊断确认file协议对ASAR内UI返回ERR_FILE_NOT_FOUND；未测到worker。
已改固定两资产安全协议并通过6项工具测试，保持相同fuses与权限；utility-55e3a21470824285b36c730a6e1b4a10
实际单轮7场景通过、Job归零。三轮native阻塞后的kill→exit为20.0853/3.1569/2.7043ms，
各16个真实UI往返样本、最大0.8/0.7/0.5ms；迟到/洪泛/畸形响应均拒绝且零切换。证据为该包runtime/report.json及job-result.json。
这仅资格化utilityProcess执行方案，旧失败保留，不能替代E2维护排水、导入或产品验收。
5GiB容器顺序I/O资格已执行，原件container-io-18c1a85af6964ce49052acf323fc3327；
实际写入/读回均5368709120字节、哈希一致，普通非稀疏且未压缩。写入8.487s、fsync0.224s、读回与哈希3.295s，
总I/O12.014s，RSS采样峰79958016字节；Job已归零。不声称冷缓存/物理盘吞吐，不授E2产品完成。
后续仍须维护排水与语义投影预算资格，才能冻结完整容器导入合同。
drain-18b0f2c92a5c465ebf26decb9c7c2747首轮保留失败：Conversation已实证dispose后仍落盘，Research夹具20s超时。
独审定位为夹具误拒规划阶段必需listGroups调用，真实库为failed/research-internal且模型零轮；修复并加入提前结束守卫。
drain-d8946b318de244fc85efb5fc4b3b1651三轮9个反例完成，Job2.551s/已归零，相关进程0。
Conversation提前返回后仍持久化；Research stop返回仍running，真实runtime结束才cancelled；Watch活动0仍有原采集在途，
原采集结束后旧run仍running。这些差距含人为150ms保持，不能冻结自然排水预算，不授E2产品PASS。
E2先实现主维护屏障及Conversation/Agent/Research/Watch/Digest真实排水；容器解析继续等待完整预算冻结。

### Stage6与设计轮既有证据（保留适用边界）

第六阶段已由新的独立D11判定 **GO / PASS**（受审候选`9365ec4`）。H1/H2/H3a已关闭；H3b第二次正式接电轮的**资源、固定负载、隐私、退出及Windows子门已闭合**，
用户2026-10-03因主要接电使用明确取消强制拔电测试；电池记NOT RUN、续航/功耗未验证，按#S6-092不再阻塞阶段。
RSS/private-v2及handle-v3的工具独审与两轮原件复算均已完成；第二轮资源PASS，
原合同RSS增长FAIL原样保留。第一轮句柄绝对median/P95真实FAIL也保留，没有通过更换公式抹去。
H4已对`d85667c..9365ec4`完整范围正式PASS，报告`log/h3br-current/h4-final-audit-001.md`；
新的独立D11报告为`log/h3br-current/d11-independent-exit-audit-001.md`；production默认及Watch set/check三进程exit0，
独立8文件114项通过，两轮正式原件/registry/61槽退出复核完成。Stage7五份设计及任务合同已独立PASS；本次依据新授权开始E1实现。
当前实现候选`391948e`（前驱`d53f607`），最终全量202文件4031测试PASS，typecheck/lint/format通过；
normal五产物及正式002的collector/qualification十二产物与原验收归档全部一致，无需为离线工具重建或重采。
此前“稍后安排，等我通知”已由取消强制测试的新裁决替代；不再等待或启动电池窗口，不改写既有机器报告。
2026-10-03用户确认UAC后，本任务新增Build Tools/MSVC/SDK已官方卸载并独立终检PASS；原有组件保留，未重启，清理义务关闭。
已从 `cc16bb57ce681e00d9d505060e20be9e49418d7e` 的干净工作区启动D10 **H3b-R实现**。
产品非暂停采样及独立构建目录已独审并提交 `5145164`；Windows Job采集器与独立报告器已实现，
首次真实Electron短验已正常完成并独立复算。电池采集、独立报告及正式运行入口已限定独审PASS，
启动前全量测试193文件3920项及typecheck/lint/format通过。工具候选`350c3f5`已提交，
首次正式接电轮`C7XQOSFIJOEGPO7ZLEYRELGKNA`已正常完成（北京时间19:39–20:39，drain至20:49）。
361个资源点、360个CPU区间及61个drain点完整。句柄median 3048>3000、P95 4187>4000、
OLS 175.188/h>60，原合同报告三项FAIL；其中绝对median/P95是真实产品超限，增长公式后续已有独立反例。
CPU/RSS/private、固定负载与退出门原判通过。电池因接电未验。
默认空白页固定开销、导航快照世代及跨文档click/fill修复均已限定独审通过；实际8组浏览器冒烟通过。
完整dev默认003、production默认002及各五组set/check已全部通过。旧Research往返失败具体字段仍unknown，
诊断实证原等待会放行loading Tab，已改受控静态页面及真实ready/完整快照门，保留原四字段恒等断言。
句柄增长按独立确认的失效工程oracle修订为`handle-growth-v2`，已实现并限定独审通过；绝对阈值与四Session负载不变。
新短验002在认证启动后约3秒失败，尚未进入固定负载；003仅新增首错诊断后正常完成，002首因仍unknown。
单次受控反例已证实native后继写入依赖主线程完成回调，排队超时发生于提交I/O之前；批排水修复已实现并完成真实红→绿和独立并发限定PASS。
修复后无hook短004已正常结束：四Session、5个资源点/4个CPU区间，首次全零10.051117秒，随后共6个连续零点。
统一构建与typecheck/lint/format通过，normal五产物与完整生产冒烟归档逐字节一致。
正式接电002 `OTHK7EMCIP7MWBIBIRWAFELO7E` 已正常完成，候选`f4fe624`（产品/native为`a4cc258`）。
北京时间2026-10-03 00:37–01:37测量、drain至01:47；361个资源点/360个CPU区间/61个drain点，
22027连续main帧、567Run/grant、120taskTab完整。句柄median/P95/peak为2626/3811/3811，
CPU为0.007815%/0.210885%/0.320190%，RSS为168.828125/436.878906/444.011719MiB。
RSS全点OLS56.621710MiB/h>24是原合同FAIL；private增长19.829256、main heap增长3.455278均未越界。
首次全零M1+10.0553873秒，slot1..60共60个连续零点，完整600秒后collector正常结束。
RSS同相诊断idle12.930401、Session18.427050、transition12.668095MiB/h；固定忙闲分布贡献43.487976，
组内项13.133734。独立反例证明全点会误判恒定开销，也发现仅两相会漏过渡点增长；新工具已覆盖全部可信过渡组并独审通过。
正式002的idle/Session/T4/T8最大RSS增长18.427050MiB/h、private8.836290MiB/h，句柄各组均无正增长。
T4共14点、四轮3/4/4/3；T8共19点、四轮5/5/4/5，跨度2800.010950/2839.993868秒，全部覆盖充分。
独立算术与最终CLI每轮598项一致；新结果见`review-growth-v3-formal-001/002-final.md`及对应`*-report-002.json`，
工具独审见`review-growth-v3-final.md`，均在`log/h3br-current/`。正式001新增长覆盖不足，资源仍因绝对句柄FAIL。
关闭后独占副本业务复算通过；NVIDIA对应版本在一次性dxdiag中WHQL=Yes。原件/报告均在`log/h3br-current/`。
停止旧012整合与classic ETW路线。
详见 `doc/stage6/acceptance-replan.md`、detailed-design §15.6/§15.7及D10。

主要根因是资源验收与自建完整Windows文件事件证明系统耦合，周期freeze、OS查询尾延迟和工具缺陷使测量无法开始。
旧测量失败本身不能判产品性能FAIL或PASS；本轮已取得完整数据，按原门判定句柄FAIL。
保留Watch产品架构、固定负载及全部数值/隐私承诺，采用非暂停分项采样。
用户已明确允许完整开发期间使用当前Windows账户，并声明应用内不会产生个人数据；不再要求新建账户。
使用全新合成根、零Provider，既有DPAPI/harness凭据不读取。当前账户不是OS文件沙箱；CJS前路径隔离
已按固定源码、启动参数、同步路径绑定与真实反例组合验证并限定独审通过；该证明不覆盖所有OS/DLL访问，
不把资源采样或启动专项通过当H3b通过。

## Git、产物与证据基线

- 本轮实现接管HEAD：`cc16bb57ce681e00d9d505060e20be9e49418d7e`，工作区干净；产品后继提交`5145164`。
- 当前工具候选`391948e`：主堆重复样本的可信峰值接线；`d53f607`为增长v3及重复槽修复，均已限定独审PASS。
  方法合同`e81f51e`/`48791ed`；本次最终全量`growth-final-full-test-002.txt`为202文件4031项，
  完整静态门`growth-final-typecheck/lint/format-001.txt`与最小后继聚焦/静态均通过，已随Stage6收尾推送。
  已提交 `a4cc258`：native批排水及真实红→绿，独立并发审核PASS；`b232853`为首错诊断、`1d5f7f8`为真实反例。
  `e78c9df`为Research受控夹具；`54136ad`为真实浏览器反例/只读控制台工具，产品修复`6024573`已限定独审。
  `4eff347`为增长判定器、`4a10a24`为Watch日期夹具、`fbcab59`为完整冒烟runner；
  此前`05b049e`为DB/load/副本工具、`0c8581d`为早期profile隔离，均已随Stage6收尾推送。精确HEAD以Git为准。
  上轮文档接管`d976ac5`的未提交收据已保存完整原文，最终工具候选SHA以Git为准。
- H3b资格产品候选 `43efffbc82ff11122230c2362d6484d5feb9b581` 仅获限定独审；RSS空默认namespace修复
  `ee61ceb9d60d89dd60f6186030d6890b019a94ee` 已独审；本轮产品后继`5145164`已限定独审，均已随Stage6收尾推送。
- 2026-10-03已正常将Stage6收尾 `6bc4f00ab065d2c751d89ab120106aa4accce805` 推至Gitee/GitHub，两次push均exit0；
  包含原H3a后全部H3b/H4/D11已审提交。Stage7设计提交`adf2899`及仅Markdown换行格式后继`a1e4d2b`亦已推双远程，ls-remote核验两端均为`a1e4d2bc8e0c3c2a23ca0703736d60865a101559`。GitHub操作前代理HTTP200；本记录后继的精确HEAD与远端以Git为准。
- H4完整审查起点固定 `d85667c54a354d322b0180d4c17873860a86c611`，不能排除首个D10大型实现。
- normal和三种qualification均已构建并分目录输出，必需addon在各自目录；旧out保存于
  `log/h3br-product-build-before/out/`。旧log候选不自动激活。
- 原progress完整4124行保存 `log/replan-20261002/progress-before.md`，SHA256
  `f79e502f68349532527888789328845fe7cb826d40fc4860a239320e5cf2fdad`；已提交历史也可从 `d976ac5` 读取。
  这是只读历史快照，不是第二进度源；含原未提交收据，原始失败日志均未删改。

## 阶段状态

| 范围         | 状态       | 证据/边界                                                                                                |
| ------------ | ---------- | -------------------------------------------------------------------------------------------------------- |
| Stage1–5     | 已关闭     | 各Stage任务/设计和Git历史保留，本轮不重审全部历史                                                        |
| Stage6 D1–D9 | 已完成     | 已有独立安全/持久化/UI审核，变更涉及的部分按影响复验                                                     |
| H1           | 历史关闭   | 其旧验收工程方案已由本轮替换，不重做旧合同                                                               |
| H2           | PASS关闭   | `9e41bd6`，原47项保留+24项；99ms红态和单调计时修复保留                                                   |
| H3a          | PASS关闭   | `log/h3a-default-independent-current/h3a-convergence.md`；RSS累计20次，default dev/prod最终各3次完整通过 |
| H3b / H3b-R  | PASS关闭   | 正式002独立PASS；电池按用户#S6-092列NOT RUN，旧失败与机器输出保留                                        |
| H4           | PASS       | `h4-final-audit-001.md`，完整`d85667c..9365ec4`，用户电池裁决单列                                        |
| D11          | GO / PASS  | 新独立审核候选9365ec4；`d11-independent-exit-audit-001.md`                                               |
| Stage7       | E1独审PASS | `independent-e1-final-review-001.md`；E2准备/维护接口为下一范围，E5独立环境BLOCKED，阶段未关闭           |

## H3b-R当前实现与验证

- 真实短验 `VXW46AFHWAOCBAVLQHBNDPZB3U` 已自然exit0：5个OS点、4个CPU区间、240条连续main帧，
  固定index80..83四次Session初始化，Coordinator/task Tab峰4，Provider/HTTP/socket为0。
  CPU median/观测peak 0.031249%/1.728728%；RSS 617.085938/803.742188 MiB；private
  352.125/376.707031 MiB；handles 3865/4144。短窗不授正式阈值PASS/FAIL，句柄需正式窗确认。
  M1+10.0577291秒首次root0/Job0/三EOF/DB独占/WAL-SHM无/temp0，共6个连续归零点（含首次）。
  原件及独立算术 `log/h3br-current/short-001-raw-independent-001.json`；采集JSONL、初报/复报全部保留。
- 首次measurement文件slot0为invalid，main短窗slot0缺失，均未填零/丢弃；不把短验当567负载或61点排水。
  采集期间一次只读进程/文件快照没有看到Electron及已写大小；最终原件证明该轮正常完成，未终止/重跑，
  不因此编造启动卡死根因。
- 首次正式接电轮已结束，独立报告与算术分别见 `review-formal-report-001.json`、
  `review-formal-arithmetic-001.json`（均在 `log/h3br-current/`）。CPU median/P95/peak 为
  0.007820%/0.226460%/0.319859%；RSS median/P95/peak 为431.359/773.785/793.215 MiB。
  句柄三项FAIL见当前结论。M1+10.0559193秒首次root0/Job0/三EOF/DB独占/WAL-SHM无/temp0，
  slot1..60共60个连续归零点，collector持有Job直到完整600秒drain结束。
  一次5 PID+creation限定CIM角色查询均超时，子进程角色仍unknown，未重试；见
  `handle-role-map-formal-001-note.md`。只读源码调查`handle-investigation.md`没有发现足以解释总量的
  native句柄泄漏。受控blank实验 `blank-run-002.txt` 实证挂载/显示/聚焦八秒仍无renderer，显式
  loadURL后才创建renderer并取得真实DOM。首次实验因CRLF工具解析失败保留于 `blank-run-001.txt`。
  默认空白延迟加载产品候选已完成：旧实现4项红态、新Browser157项及typecheck通过；显式about:blank
  保持加载，Session固定负载不变。独审和真实产品冒烟已限定通过，此常数优化不独自解释OLS。
- 默认空白候选独审F1（替代加载同步失败误报成功）及F2（正常ERR_ABORTED覆盖新加载状态）均已修复。
  真实七组smoke首次成功，但补强
  文档世代断言后 `browser-smoke-run-002.txt` 失败：同一固定目标快照initialDocumentId=1，
  稳定后=2。红态run `QRKLNZILA367VWXGVKFDVZYCYE`，bundle/map/launcher保存在
  `log/h3br-browser-generation-red-artifacts/`。F3现通过采集前后文档/导航/加载序号复验和有界重采关闭，
  175项Browser测试及真实`browser-smoke-run-003.txt`通过，独审`review-deferred-blank.md`限定PASS。
- 该审查另发现既有跨文档交互风险。真实`browser-smoke-run-004.txt`确认旧页面授权fill写入新页面，
  run `M4FDSAM22B3ZSUH2IJU3OO7CWQ`记录accepted=true/newDocumentModified=true；原bundle/map/launcher
  已保存在`log/h3br-browser-interaction-red-artifacts/`。隔离世界中实际文档私有token同步校验已修复。
  005实际发现完整脚本末尾分号导致的嵌入语法错误，真实SOURCE反例红→绿；失败产物已归档。
  006真实8组通过（含正常动作、旧snapshot并发、跨文档fill/click拒绝及历史返回新文档），run
  `GHMWJOM5NB25OEZS3CWXML5ESU`；产物在`log/h3br-browser-interaction-green-artifacts/`，独审
  `review-document-interaction.md`及binding收据限定PASS。固定平台注入会禁用BFCache的资格须随版本/通道变更复核。
- `handle-growth-v2`限定独审见`review-formal-tools.md`及`review-growth-evidence-001.json`：
  旧原件只读分类305 idle/51 Session/5过渡，20波各2–3点；原OLS保留，新诊断仍因绝对median/P95失败。
  原正式轮三项FAIL不改写，修订只用于新正式轮。
- 完整production默认冒烟`product-production-default-001.txt`因Watch固定日期夹具被真实日期保留清理而失败。
  两个未来日期的红态已复现，统一夹具业务时钟后27项聚焦通过；生产保留策略未变，后续失败夹具保留。
  原件`watch-store-clock-red-001/002.txt`及`watch-store-clock-green-001.txt`；最终dev/prod完整矩阵已通过。
- 新产品候选完整质量门199文件3993项、typecheck/lint/format通过，原件`final-interaction-*-001.txt`。
  dev默认轮`d2c7930eeb85401a99cc3de66dbac255`在8.19-B Research画布往返Tab四字段恒等断言失败，
  原stderr/stdout/退出收据保留。诊断002全场景通过，但捕获新链接Tab从loading到ready；该等待门缺陷已确定，
  001具体变化字段仍unknown。修复夹具10项先红→绿，dev003全场景通过，所有Tab均ready且四字段无变化。
  五组dev set/check（Session/Sources/Sources UI/Research/Watch）业务断言及退出均通过。原件前缀
  `product-dev-*`；production默认及五组set/check均通过，11份退出收据绑定相同入口hash，见
  `production-matrix-binding-001.json`；实际normal产物归档`log/h3br-final-normal-artifacts/`，尚不授H3b。
  最终质量门200文件4003项及typecheck/lint/format通过（`final-candidate-*-001.txt`）；三种资格产物已一致重建。
  Browser后继`a0b3875`仅翻译新增注释，
  编译后代码与6024573逐字节相同（`browser-comment-only-001.json`），006行为证据仍适用。
- `formal-002-console-environment.json`实证当前进程与物理控制台同为Session1、UserInteractive=true；
  只说明该时刻本地交互会话，不排除远程协助/锁屏。原OS/CPU/RAM/驱动事实可复用，新窗口仍核活动GPU。
- 新短验002（`a4b2c14`，run `BGM2EYMZCVCR7LWVYRRFULECPQ`）启动路径核对/ready认证通过，
  6条main帧后出现`qualification-capability-invalid`、`telemetry-write`和native完成路径fatal；
  collector记录`telemetry-incomplete-eof`并以79退出，未超外部期限。未取得负载/资源或正常退出结论。
  原件`short-002-plan.json`、`short-002-run.txt`及逐run文件保留；实际产物完整归档
  `log/h3br-short-002-artifacts/`。当前补最小首错分类与数字时序定位，不放宽时限或无诊断重跑。
- 首错诊断`b232853`保持原调度/两秒期限，45项native及20项IO生命周期通过并限定独审。
  短验003 run `PBMM25RXUGC5Y4ZSIAKY5NODEA`正常exit0，244连续main帧、5OS点/4CPU区间、
  四Session/Coordinator/grant完整，HTTP/Provider零。CPU median/peak 0.066388%/1.586228%，
  RSS median/peak 423.938/744.355 MiB，handles median/peak 2688/3846；不授正式阈值通过。
  stop+10.0640203秒首次全零释放，slot1..6共六点持续，7点drain完整；原件`short-003-*`及逐run文件，
  实际产物在`log/h3br-short-003-artifacts/`。本轮未复现002，不能据此声称其首因已定位或修复。
  独立复算`review-short-003.md`及`review-short-003-arithmetic.json`确认资源/负载/退出和副本hash一致；
  files首slot invalid、main首短窗slot缺失保留。GPU active NVIDIA，仅此字段不证明硬件渲染。
- 003两库由native独占副本复算通过100 Source/Rule、4 Run/Baseline、零Event/Digest，复制后原库仍释放。
  首份root身份JSON因调用方CRLF被严格解析拒绝，原件保留；`root-ids-002`改单LF后复核通过，非产品释放失败。
  受控反例`writer-main-delay-001` run `SYSRL5BWWQ2WQBYLH6324LVS3I`证实：main阻塞2.514421秒，
  seq2父进程已收到，seq3排队2.5216373秒后在提交I/O前超时，native执行仅33.5微秒、ioCompleted=0。
  child exit1、Job0及三EOF，工具exit0表示反例命中；实际红态addon/启动器/observer已归档至该目录`red-artifacts/`。
  保留两秒入队总限、队列预算及取消后实际完成要求，修复后台有序排水对逐帧main回调的依赖；002首因仍unknown。
- native批排水候选让后台连续处理已入队Work，main只按全局FIFO完成Promise；空批与新入队交接受mutex保护。
  50项原生聚焦及20项IO生命周期通过（`writer-batch-build-002.txt`）。真实绿态
  `ZIT5CH27SQQAEABEABQIGXB7F4`中main停顿2.513573秒，父端已收到seq2/3，seq3 native完成耗时
  上界76微秒；242帧/complete/自然exit0/Job0/EOF。原件`writer-main-delay-green-001/`，
  来源绑定`writer-batch-binding-001.json`。该注入停顿专项不是无hook资源短验，正式轮仍未启动。
  独审`review-writer-batch.md`核对10项绑定和14项实际归档，独立50项native测试通过，确认FIFO/批交接/
  Close/finalize及调度失败收口；实际绿态归档`log/h3br-writer-green-artifacts/`。允许最终构建和无hook短验。
- 正式旧产物已按plan四项hash核对后保存于 `log/h3br-formal-001-artifacts/`，manifest为
  `formal-001-artifact-archive.json`。当前normal、三种qualification及四参数collector均已重建；
  不得混用新addon与旧三参数collector。
- DB先以native独占复制关闭后的两库，hash前后及副本一致；SQLite仅打开副本，实际567Run、
  50Event、100observation、100typed Evidence、2Digest及全部业务内容通过。原件
  `formal-001-copy-001.txt`、`formal-001-database-report-001.json`；副本关闭后原库再次释放检查
  `formal-001-release-after-copy-report.txt` 通过（identity不变、WAL/SHM无、temp0）。DB12项反例通过。
- 启动专项 `startup-run-004.txt` 九场景成功（含无hook正常启动、延迟认证、拒绝参数、换绑及读取正控）。
  前三次失败分别为正控位置、NODE_OPTIONS路径转义和Electron过早app访问，原件完整保留；修复仅工具。
  `review-early-profile.md` 已独立核验实际产物/装配顺序、9场景及归档9项，授限定PASS；归档
  `log/h3br-startup-004-artifacts/` 保留实际out/launcher。新collector及全部产品构建已完成，
  仍需修复浏览器竞态后的新候选短验，不能把该专项当H3b总门PASS。
- 非暂停产品/预检独审 `review-nonpause.md` 限定PASS；原六文件reporter初REPAIR后修复，再审PASS，
  `review-reporter.md`保留全链。电池及DB当前实现已增量限定PASS，正式DB oracle待补完整。
  `review-extensions.md`对电池API、释放身份、watchdog及AwakeRequest限定PASS，允许正式采集。
- 原始关闭后DB业务复算通过短验全部项目（2库完整性、100 Source/Rule、4 Baseline/Run及零Event/Digest）。
  工具直接SQLite readOnly打开原WAL库后创建了sidecar，原始drain已证明这些文件此前不存在；该工具副作用
  与二次释放拒绝证据保留于 `short-001-database-report-side-effect.md`，不判产品泄漏、不删除原件。
  后续改为独占释放检查后的受控一致性副本复算，不再用Node SQLite重开原库。

- 产品侧甄别红态：旧writer阻塞会阻止sample产生；旧正式末点位于stop之后。已取消周期pause/freeze/重排timer，
  同步registry prefix与快照后异步发送，正式末点在M1前、M1独立停止。原件 `log/h3br-product-nonpause-red.txt`。
- normal输出仍为out/main；资格构建分为out/qualification及两种诊断目录，addon随对应目录构建。
  重建前旧out保留于 `log/h3br-product-build-before/out/`；此次修改不把旧产物当新候选。
- `tools/watch-qualification/` 新增最小Job/pipe采集器、独立报告器和安全预检。真实合成子进程/SQLite反例
  已运行，覆盖退出子进程CPU、残余进程、共享读/写/DELETE句柄及temp。安全复核发现DB路径应为
  userData/watch/watch.db，已修复，失败/修复证据保留于 `log/watch-qualification-build/`。
- 启动前全量测试193文件3920项通过，typecheck通过，原件 `log/h3br-current/`。
  全量lint首次因历史隔离产物目录ACL无法遍历而中断；已把`.h3b-workspaces`加入lint/format运行产物忽略，
  不改变源码检查范围或原件ACL。随后检查结果以各次原始日志为准，不覆盖失败。
- 当前没有新建账户、启动ETW/UAC、修改原profile ACL或读取真实凭据。短验已取得资源/释放证据，
  新增电池与总超时保护已完成风险复核，首次接电正式轮已结束；用户安排之后补电池窗口，尚未通知物理就绪。

## 既有重规划验证（证据复用边界）

- 独立产品评估实际运行：Node `v24.18.0`；
  `npm test -- --maxWorkers=1 src/main/watch/feed-parser.test.ts src/main/watch/watch-run-coordinator.test.ts src/main/watch/watch-processing-service.test.ts src/main/watch/qualification/full-load.test.ts src/main/watch/qualification/launch-isolation.test.ts`
  → exit0，5文件144项。覆盖现有负载和产品协议，不证明Windows资源或真实UI。
  来源为本轮实际工具回报；未单独保存当时stdout，不补造原始日志，执行摘要见下列实施审核报告。
- 三个独立调查上下文分别审查规则/设计、产品、历史原件，均支持替换验收架构。请求模型Astra high/xhigh；
  工具未回显actual，不额外验证身份。
- 本轮文档REPLAN及实施入口已独立PASS：`log/replan-20261002/review-evidence.md`；
  实施可行性初审发现首末采样、缺样节拍和安全入口三项，修订后定向PASS，初审记录保留于
  `log/replan-20261002/review-implementation.md`。这些结论不授H3b/隐私环境/Stage Exit通过。
- 14份变更文档Prettier检查与diff-check通过；规则skill经UTF-8验证通过。src/native/package/build配置零变更，
  未重建out、未运行新实测、未改系统。REPLAN本地文档提交后停止，下一会话按新合同实现。

## 必须保留的失败与局部成果

- classic综合路线9次未完成（此前另有诊断，9不是全部历史启动数）。第九次为
  `3EQGHQGLFILCE5JP5DG2W6WMOA`：应用279帧/complete、root0，观测器先失败；unresolved978，
  Name登记253IO/15代但proof/source为0，触发完整参数缺失仍unknown，4个freeze仅3有效。
  报告 `log/h3b-increment-independent-current/raw-review-3EQ-001/review-3EQ-001.md`。
- 第八次RMOO已证工作根处于保护log域与native祖先pin冲突；第七次MB3已证整合构建遗漏addon和预检漏项。
  报告 `classic-raw-review-RMOO.md` / `classic-raw-review-MB3.md` 在同一独审目录。
  普通无ETW短链V4Z/OPVW/MYQL曾完整退出，但不授正式资源资格。
- 两次RM对照：第一次三Start=29、零GetList，原因unknown；第二次9次GetList成功但复用session仍报告旧owner，
  18次计划未完成、按oracle停止。`log/h3b-native-current/rm-session-experiment-candidate/`保留全部原件；
  不采纳复用，不追加旧路线第三次。
- 012纯dependency/Name模型、assembly/slot有局部PASS；runtime实际ETW未验证，最终binding未冻结。
  `log/h3b-increment-independent-current/assembly-slot-review-001/review-002-pass.md`不授H3b。
  不把数千纯模型断言或hash封存当实际IO/性能证据。
- 旧BBC/NASA失败和RSS16/64账本保留，新目标增加4次、累计20；历史default/GPU部分根因仍unknown，
  已接受当前功能证据不等于旧失败已定位。当前旧失败不能被笼统写成环境免责。
- `7ZH3LHUDMG7EVBK6ESGEECUVEM`的4096-byte canary有历史残留，FileId未完整恢复，保留待精确所有权确认；
  不删除未知目录/文件。上次已知服务恢复Running/Automatic，PID/ETW会话清理收据在原件中；
  新会话若要运行先只读核实现场，不依据历史PID删除现有进程。

## 现存产品风险与限制

H3b接电长时资源、当前Windows及限定隔离证据已闭合；电池按用户#S6-092列NOT RUN及已接受的未验证限制。
没有证据需要全局重写产品架构；若新测量发现实质缺陷则按根因修复，保留相同oracle。

### 开放风险登记

- **审计 P2-3 会话字节上限（B9 独立处置，2026-08-15；未修复，后续硬化）**：
  会话持久化有会话数（50）与消息条数（200）上限，**无字节上限**——触发
  条件 = 单会话 200 条内持续追问或超大单条消息；影响 = 会话 JSON 文件可达
  MB 级（存在隐式上界：200 条 × 上下文预算/摘要截断）；现有缓解 =
  MESSAGE_LIMIT=200 + 预算截断 + ToolStep 摘要化（fill 脱敏/快照正文零持久化）。
  **B9 独立判定：不命中本阶段 Exit Gate**（无卡死/数据丢失路径，规模有隐式
  界）；登记后续硬化（Seventh Stage 或专项闭环评估单文件字节上限）。
  **2026-08-16 Fifth Stage 切换重新分级：升级为「Fifth Stage 必须吸收」**——
  不得机械延期：若 Research 结果/证据/运行记录进入 ConversationStore 会把
  长 Research 塞进会话 JSON 放大无界风险。处置（已落入设计）：Research 数据
  **不进入会话 JSON**——独立 research.db + 独立字节预算（单任务持久化
  ≤500k 字符/保留任务 ≤30/最旧清理）+ 会话侧仅挂任务 id 引用
  （detailed-design §9 + proposal §8.2）。
- **审计 P2-4 Vitest 默认 worker（B9 独立处置，2026-08-15；未修复，建议
  配置固化）**：vitest.config.ts 未固化单 worker，直接 `npm test` 走默认
  并行；触发条件 = 未按纪律显式 `--maxWorkers=1` 的调用；影响 = 墙钟断言
  在并行负载下边缘抖动（F-1 已去墙钟化，风险显著降低）；现有缓解 = 验证
  纪律显式单 worker（AGENTS.md §6）+ 本轮 B9 单 worker 1229/1229 全绿。
  **B9 独立判定：不命中 Exit Gate**（验证基础设施可信——命令显式固定，本轮
  与历史验证均单 worker 全绿）；建议后续闭环在 vitest.config.ts 固化
  maxWorkers=1（一行配置，消除纪律依赖）。
  **2026-08-16 Fifth Stage 切换重新分级**：维持**可延期至 Seventh Stage**
  （验证基础设施，不阻塞 Research；验证纪律显式 `--maxWorkers=1` 延续；
  若任一 C 系列实现任务顺手固化须在其任务闭环内单独验证——proposal §8.3）。
- **审计 P3 smoke 效率（B9 独立处置，2026-08-15；未修复，后续优化）**：
  冒烟全矩阵运行分钟级（本轮 dev 约 4.7 分钟/生产约 4.2 分钟，双场景+
  跨进程门控合计约 15 分钟）；触发条件 = 每次全量验证；影响 = 验证耗时
  （非正确性）；**B9 独立判定：不命中 Exit Gate**（效率非阻塞条件；§9
  全量验证已通过）；登记后续闭环评估优化（不影响断言强度的前提下）。
  **2026-08-16 Fifth Stage 切换重新分级**：维持**可延期至 Seventh Stage**
  （效率非正确性）；但 C 系列冒烟必须不显著加重默认矩阵（新场景编号独立、
  断言不重复完整运行既有矩阵，延续决议 #93 纪律——proposal §8.3）。

### 既有边界及后续承接

- R-01 UI导航保护、R-02服务器重定向保护、审计P2备份发布清理竞态、P2-2日志保留/大小已关闭，
  原编号与结论保留于Git/相关Stage任务；不复用编号。
- PageSnapshot主文档/iframe降级、shared/url不支持IDN、搜索snippet/站点结构限制维持原产品设计。
- O-1 ConversationStore UUID路径纵深防御在会话导入/同步或信任边界变化前复核；无已知外部攻击入口。
- Provider跨run不持久化reasoning_content，要求原样回传的Provider旧会话重问可能受控400；原决议#35保留。
- Prompt Injection结构防御不等于语义免疫，第三阶段四类已接受设计风险继续由当前threat-model承接。
- 未打包系统通知、真实登录网站、当前Stage6真实Provider条件观察如实NOT RUN/条件不可用；不要把历史
  “凭据不可用”当永久免测。若有实际验证价值再通过本地安全机制向用户要短期配置，资源窗口始终零调用。
- 安装、签名、升级、分发及更广Windows兼容矩阵按Seventh_stage.md准备；不搬移当前Stage6未决硬门。

## 操作授权与清理义务

用户已授权本地工程实现、合理依赖/架构调整、测试、提交及审核后正常双远程同步；不用逐任务问是否继续。
尚未授权的系统级动作、实际外部权限、凭据或物理操作才集中请求，产品取舍不能伪装工程细节。
用户已答应准备好后提供≥30分钟拔电/不锁屏窗口，也授权必要时临时系统英文输入法及Nahimic暂停后恢复。
用户先选择接电验收、后补电池，曾答“稍后安排，等我通知”；2026-10-03又明确因基本插电使用取消强制电池测试。
最新裁决替代等待物理窗口的安排，不重复请求确认；接电证据仍不能授电池PASS。

**任务结束后必须移除临时工具**：VS2022 Build Tools/MSVC x64/x86及Windows SDK26100的本任务新增部分。
按 `log/native-build-install/before-install.json`、`after-install.json`、`removal-inventory.json` 和
`log/h3b-native-current/native-build-restore.vsconfig`核对，官方安装器卸载，不改/删原有SDK/WPT/调试器/运行库，不自动重启。
**2026-10-03清理已完成。** 首次UAC取消原件保留；用户随后明确“确认”，官方Installer于北京时间23:17–23:20完成指定Build Tools实例卸载，exit0，SDK随依赖管理移除，无需第二次SDK卸载。
实例与原49条新增登记均已消失，完整65个SDK MSI均有成功卸载日志，独立核验260个精确安装注册键零残留；MSVC编译器和SDK26100头文件/库不再存在。原有39项软件登记及版本保持，原Visual Studio Installer保留原版。
卸载前368文件快照包含原有与本任务新增文件：221个原有文件（WPT207、Debuggers4、旧Catalogs9、Facade1）长度/hash不变；147个本任务SDK Catalogs正常移除。
147项均与官方FileRemove一一对应，其48个MSI产品码/版本/status0全部匹配本任务2026-09-20的安装事件；9个保留Catalogs绑定既有WPT。
因此旧预检把全部Catalogs都列为原有保护对象不准确，不能声称368个全保留；按安装归属复核后确认未破坏原有组件。
官方进程已结束，未自动重启；本次exit0，CBS/WU重启标志为false，卸载前就存在的PendingFileRenameOperations仍存在，不归因于本次卸载。
独立终检PASS：`log/h3br-current/build-tools-cleanup-final-review-001.md`；官方结果、逐项核验、MSI安装/卸载证据及日志位于`log/native-build-install/`，均不入Git。
normal五产物与既有验收字节一致；未重新构建或重复产品冒烟，既有产品验收按未变源码/产物复用。原失败、请求账本及未知canary未清理。

## 下一唯一执行任务

完成Stage7 E1：release编译/包白名单、稳定identity与单实例、资产协议/CSP/IPC文档世代、所有Session权限与下载、
Provider凭据目标原生授权及实际EXE fuses/ASAR反例。先聚焦红绿，再全量与dev/production/packaged真实验收，
由新的独立安全Reviewer审核后逻辑提交、正常双远程推送，随后依次推进E2–E6。

Stage6 D11报告为log/h3br-current/d11-independent-exit-audit-001.md；设计独审报告为
log/h3br-current/stage7-independent-design-review-001.md。二者不授Stage7实现或包验收通过。
新增构建工具卸载义务已关闭；电池NOT RUN保持。原历史停止指令只作Git历史，不再约束本轮。

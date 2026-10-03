# progress.md — 当前状态与下一任务

> 唯一进度源。历史放Git/原始证据；不再逐轮累积开发日记。风险编号不重排、不复用。

## 当前结论（2026-10-03）

第六阶段已由新的独立D11判定 **GO / PASS**（受审候选`9365ec4`）。H1/H2/H3a已关闭；H3b第二次正式接电轮的**资源、固定负载、隐私、退出及Windows子门已闭合**，
用户2026-10-03因主要接电使用明确取消强制拔电测试；电池记NOT RUN、续航/功耗未验证，按#S6-092不再阻塞阶段。
RSS/private-v2及handle-v3的工具独审与两轮原件复算均已完成；第二轮资源PASS，
原合同RSS增长FAIL原样保留。第一轮句柄绝对median/P95真实FAIL也保留，没有通过更换公式抹去。
H4已对`d85667c..9365ec4`完整范围正式PASS，报告`log/h3br-current/h4-final-audit-001.md`；
新的独立D11报告为`log/h3br-current/d11-independent-exit-audit-001.md`；production默认及Watch set/check三进程exit0，
独立8文件114项通过，两轮正式原件/registry/61槽退出复核完成。Stage7五份设计及任务合同已独立PASS，停在首个产品实现之前。
当前实现候选`391948e`（前驱`d53f607`），最终全量202文件4031测试PASS，typecheck/lint/format通过；
normal五产物及正式002的collector/qualification十二产物与原验收归档全部一致，无需为离线工具重建或重采。
此前“稍后安排，等我通知”已由取消强制测试的新裁决替代；不再等待或启动电池窗口，不改写既有机器报告。
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

| 范围         | 状态         | 证据/边界                                                                                                |
| ------------ | ------------ | -------------------------------------------------------------------------------------------------------- |
| Stage1–5     | 已关闭       | 各Stage任务/设计和Git历史保留，本轮不重审全部历史                                                        |
| Stage6 D1–D9 | 已完成       | 已有独立安全/持久化/UI审核，变更涉及的部分按影响复验                                                     |
| H1           | 历史关闭     | 其旧验收工程方案已由本轮替换，不重做旧合同                                                               |
| H2           | PASS关闭     | `9e41bd6`，原47项保留+24项；99ms红态和单调计时修复保留                                                   |
| H3a          | PASS关闭     | `log/h3a-default-independent-current/h3a-convergence.md`；RSS累计20次，default dev/prod最终各3次完整通过 |
| H3b / H3b-R  | PASS关闭     | 正式002独立PASS；电池按用户#S6-092列NOT RUN，旧失败与机器输出保留                                        |
| H4           | PASS         | `h4-final-audit-001.md`，完整`d85667c..9365ec4`，用户电池裁决单列                                        |
| D11          | GO / PASS    | 新独立审核候选9365ec4；`d11-independent-exit-audit-001.md`                                               |
| Stage7       | 设计独审PASS | `stage7-independent-design-review-001.md`；E1–E6未开始，停在第一个产品实现前                             |

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
当前仍安装，尚未移除；不能只删下载缓存声称完成。2026-10-03官方卸载首次启动在UAC阶段返回取消，未开始卸载；已集中询问是否重试，等待用户实际操作。原有39项版本及368个保护文件hash未变，新增49项仍在；收据为 `log/native-build-install/removal-result-001.json`、`after-cancelled-removal-001.json`。禁止自动重试提权或自动重启。

## 下一唯一执行任务

Stage6已经GO/PASS，H3b/H4/D11没有待补硬门；电池依用户裁决NOT RUN，不再安排拔电。
Stage7五份设计及E1–E6任务合同已完成并独立PASS，报告为`log/h3br-current/stage7-independent-design-review-001.md`；本轮没有改产品源码、工具、依赖或构建配置。
设计基线为`6bc4f00`，设计入口为`doc/stage7/proposal.md`与`tasks.md`。本轮停在E1首个产品实现动作之前，
后续只有用户明确启动实现才进入发行构建/安全能力边界；不会把设计通过当发行包或Stage7产品完成。

**剩余操作为官方新增构建工具卸载。** 首次UAC未完成，主协调已集中询问是否现在重试；用户未答前不再次发起提权。
当前新增49条仍在，原有39条和368个保护文件不变，详见上节清理收据。若用户选择稍后，保留本待办，不能称整体清理完成。
收到就绪后先核现有实例/签名/清单，仅卸载任务新增Build Tools/MSVC/SDK；必要时按精确SDK bundle做后继官方卸载，
核对原有组件/文件与实际退出码，不自动重启，不删除共享父目录、旧失败证据或未知文件。

设计独审/文档格式/敏感模式与diff终检、逻辑提交及正常双远程交付均已完成；工程收尾没有重跑未变Stage6长时验收。设计审核之后仅Markdown引用块换行格式修正，无契约变更；暂存区发现的四处行尾空格已在独立后继提交修复，最终范围diff-check通过。
正式原件、失败及unknown继续保留：`log/h3br-current/`；H3b非暂停工具源码均已在Git。
D11监听器诊断观察到同一对象在未销毁时归零；一次性hook污染子进程JSON的exit1完整保留，未替代无hook三进程PASS。
完整当前接管边界见`doc/prompt.md`，不返回旧012/ETW路线。

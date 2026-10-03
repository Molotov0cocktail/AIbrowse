# 第七阶段任务合同

## 共同实施约束

设计baseline：`6bc4f00ab065d2c751d89ab120106aa4accce805`；实际实现开始前记录当时精确HEAD与工作区归属。
权威源依次为Seventh_stage、proposal、detailed-design、threat-model；状态只在progress。
用户2026-10-04已授权依次完成E1–E6实现、验证、必要独立审核与收尾；原E1前停止边界失效。
文档审核不等于运行PASS；Stage7硬门满足并收尾后停止，不启动Stage8产品实现。

每项保留所有Stage1–6能力/隐私/数值承诺，先建可区分旧实现的反例，再修复；维护源码与测试均受Git管理。
共享规则：不读真实凭据/用户库来做夹具；固定范围合成数据、受控临时根、精确退出/清理；失败原件保留。
缺真产品决定、外部权限/凭据或物理条件时集中提问，继续独立工程事项；连续两轮同路无新证据则REPLAN。

## E1 — 发行构建与安全能力边界

- **目标**：使实际目录发行候选无法通过开发环境变量进入smoke/qualification、替换受信UI或重定向私有数据；
  同时封闭新Security Model确认的Provider凭据目标、权限、下载和资源来源缺口。
- **范围**：main装配/bootstrap、Browser/Session/IPC/Provider配置、preload最小DTO、renderer必需提示、
  electron-vite与新增包装配置、包检查工具、测试；不实现备份、自动更新或公开发布。
- **不变量**：17个工具、L0–L3、只写Key、Public/Session门不变。合法Provider兼容不能无诊断删除；
  不把同源sender视为真人确认，不靠提高监听上限或禁用安全机制清除警告。
- **实施**：先核当前版本的官方打包/安全能力；固定精确builder及辅助依赖，保留lockfile；先目录产物，
  正向文件清单排除smoke/qualification/native测试、日志、源码、凭据与数据库。安全方案按详细设计资格。
  固化Vitest默认单worker并验证无额外参数的测试入口。
- **反例**：release携带AIBROWSE_*、ELECTRON_RENDERER_URL、NODE_OPTIONS等仍不得启用开发能力；
  攻陷UI模拟不能将既有Key悄悄送到新端点；跨frame伪IPC、外部file/路径穿越、下载执行与新窗口按威胁表拒绝。
- **验证**：聚焦红绿→test/type/lint/format/build→dev及production回归→实际packaged目录运行；
  包内容、fuses和最小权限逐项验证，不只检查配置文本。秘密扫描使用合成canary，不打开真实Key。
- **完成**：新独立安全Reviewer PASS，任务证据/代码/实际产物绑定一致；仅本地候选，无release/tag/自动发布。
  必需fuse/资源协议/兼容资格失败先定位并修订工程方案，不能扩大权限换PASS。

## E2 — 数据维护、旧版本迁移与恢复

- **依赖/范围**：E1；Sources/Research/Watch Store、Conversation、main维护编排、最小UI/IPC、备份容器与恢复测试。
- **目标**：用户能主动备份/恢复重要本地业务数据；升级失败有可执行恢复方式，原库和已确认写入不静默丢失。
- **实施**：先用真实历史schema与合成边界样本冻结容器/成员/Conversation字节预算，再实现解析；
  未冻结预算不得开始不可信容器导入或授PASS。Research增加预迁移备份；迁移逐版本失败落点写准确。
  维护态、排水、快照、manifest发布、恢复清单/启动恢复及跨库Source/Watch协调按详细设计执行。
- **反例**：future schema零写、每一步升级/恢复中断、磁盘不足、库锁/损坏、备份碰撞、WAL不丢提交、
  容器超限/重复成员/路径穿越/UUID注入、伪manifest、缺Source引用、会话超限保留旧内容、取消操作无部分生效。
- **验证/完成**：Repository聚焦、真实多进程中断重开、迁移前后内容与保留政策、UI实际导出恢复、独立持久化/隐私PASS。
  备份排除Key/DPAPI/Cookie/session/raw正文/log，含用户私密业务字段的事实必须在预览和文档明示。
- **停止**：无法解释任一阶段的数据归属/恢复落点时先修协议；不通过删除旧库或放宽完整性要求继续。

## E3 — 崩溃、中断与可操作错误

- **依赖/范围**：E1/E2；main窗口和Tab生命周期、AI/Agent/Research/Watch终态、UI错误投影。
- **目标**：单网页故障不拖垮应用；UI重建和异常重启后状态诚实、可继续操作，副作用不自动重放。
- **反例**：合成页面WebContents/renderer退出、主UI退出、main异常终止、DB unavailable，
  Agent确认中断、Research取消与完成竞态、Watch消费slot后中断；用户Tab不得误关闭。
- **体验矩阵**：首次启动、无Key、无网络、Provider不可用、网页打不开、captcha、DB错误、Research/Watch失败，
  分别核对中文提示、数据影响和可执行恢复入口；captcha由用户处理，不新增自动绕过能力。
  安装/升级失败体验由E5接续；各项不能只用错误日志代替实际界面检查。
- **验证**：真实Electron故障注入、持久结果重开、任务owner清理、资源/句柄回落、连续失败有界停止；
  每个错误说明发生什么、数据影响及可恢复动作，无秘密/敌手正文回显。
- **完成/停止**：聚焦与受影响完整回归通过；涉及并发所有权由独立Reviewer核对。不能以全局catch日志代替恢复。
  不增加跨重启任务续跑或新Tab会话恢复承诺。

## E4 — 性能基线与受控诊断

- **依赖/范围**：E1–E3；现有logger、操作计时、用户诊断预览/导出及tools下固定负载工具。
- **目标**：覆盖启动/Tab/多Tab/Snapshot/首token/Research/大Sources搜索/Watch调度的可重复测量；
  只修有甄别数据的回归，保留已关闭日志预算，不重建通用取证系统。
- **验证合同**：运行前冻结机器/版本/电源/工作集/样本数/统计量/阈值；原件保持完整，缺失不填零。
  进程冷启动与系统冷缓存分开标注；Provider网络耗时与本地路径分开，凭据不可用记NOT RUN。
  Watch数值及10m/60m/10m规则不变，只有实际改动影响它时重验；用户电池裁决继续保留。
- **多Tab长时稳定**：E4冻结至少10个用户Tab、连续至少2小时的受控合成页面负载，含保留用户Tab与有界导航/关闭重建。
  运行前登记各类页面、操作序列、测量开销及资源绝对/增长和交互延迟oracle，不能事后挑样或调整阈值。
  必须核对无异常崩溃、无跨Tab状态误用、持久数据无损、全过程资源与交互响应、结束后真实退出/释放。
  Watch后台启用条件单列，原Watch硬阈值的适用固定负载不被此不同负载替代；E5在最终包上复验受影响部分。
- **隐私反例**：诊断预览与实际导出逐项一致，Key/密码/正文/Cookie/form canary不能进入输出；
  取消无文件、路径由main dialog确定、超限安全失败，无后台上传。
- **完成**：基线与相对回归oracle按详细设计冻结，目标均有数据或具体条件说明；确认的不可接受回归修复后复验。
  优化smoke只减少重复开销，不删除有意义断言。秘密/正文泄漏立即停止相关路径并修复。

## E5 — 安装、手工升级及独立Windows验证

- **依赖/范围**：E1–E4；NSIS、identity/version/icon/快捷方式、主进程路径/单实例/packaged通知及安装测试工具。
- **目标**：干净Windows普通用户可安装运行，覆盖升级保留业务数据，卸载保留userData且不删其它应用文件。
- **反例**：有空格/中文路径、同版本覆盖、真实旧版升级、程序占用/中断、未来库版本拒绝、
  取消安装、卸载后重装、不同Windows用户隔离；已知不支持的平台明确拒绝而非损坏数据。
- **验证**：至少一个独立于开发工作区的干净Windows环境，无Node/MSVC/SDK前置；
  新安装→主路径→升级→崩溃恢复→卸载→重装验证数据/凭据边界与遗留文件归属。
  packaged通知的显示/点击路由/内容隐私必须实际检查，截图和日志仅合成内容。
- **完成/停止**：独立安装证据成立；没有环境时记BLOCKED并集中请求实际操作，不以开发机preview替代。
  默认不改变系统默认浏览器、自启、服务或电源设置；不自动重启。

## E6 — 发布可复现性与新独立阶段验收

- **依赖/范围**：E1–E5；CI与构建清单、签名接口、release notes、全安全红队、最终Stage Auditor。
- **目标**：version/tag/源码/lockfile/产物对应，公开发布只使用已确认渠道与权限；未签名内部版诚实标记。
- **验证**：最小CI权限、依赖/许可证和包内秘密检查、两次洁净构建比较应用payload，
  若签名/时间戳导致封装差异逐项解释，不能声称未证明的逐字节安装器复现；最终产物hash和来源可追溯。
  第一至六阶段主路径回归、threat-model红队、迁移/崩溃/性能/独立安装逐项对照Seventh_stage Exit。
- **签名/发布**：凭据只在受控secret通道；签名前冻结fuses/ASAR；无证书不伪签、不降低更新完整性。
  本方案不提供自动更新。真实公开发布、发布账户/证书或CI外部权限尚缺时必须列出，不隐式发Release。
- **完成**：新的独立`gpt-6-astra/xhigh` Stage Auditor GO后方可称Stage7完成；范围/NOT RUN/已知限制与产物相符，
  正常提交及双远程同步遵守代理规则。任何实质安全/数据缺陷不能作为“已知限制”自行接受。

## E1 本次差量实施合同（2026-10-04）

- **TASK / BASELINE**：E1；`25a6aa5489b0596d529b97d62eab8ee789bb1e70`，main干净，无已有修改。
- **GOAL / NON-GOALS**：落实本文件E1及详细设计§3、威胁模型S7RT-01–06/15–16；交付Windows x64未签名目录候选。
  不公开发布、不改变CookieEncryption、不实现自动更新、不重新安装已卸载的构建工具。
- **CURRENT VERIFIED STATE**：Stage6 D11与Stage7设计独审原件已核对，适用范围保持；当前源码无release隔离或Key目标绑定。
  历史PASS仅覆盖未改产品范围，不授新包通过。Node实际为24.18.0。
- **FIXED DECISIONS / INVARIANTS**：沿用详细设计§3及E1不变量；独立release输出与正向资产清单；主进程原生确认持有授权。
  保留aibrowse实际identity/userData；打包器与fuse版本先查官方和最小资格，再精确安装。兼容失效先定位并修订工程方案。
- **SCOPE / PLAN**：并行打包资格、凭据目标绑定与资产/Session边界；主协调负责bootstrap/IPC集成及文档。
  同文件单写者；模块产物合并后做实际release资格，再由新独立安全Reviewer复核完整E1风险边界。
- **TEST PLAN / ACCEPTANCE**：先保存可甄别旧行为的红态；聚焦绿态及受影响回归、默认单worker全量、typecheck/lint/format/build；
  dev/production默认及受影响跨进程冒烟；实际EXE环境反例、包清单/合成canary/fuses/ASAR篡改、Session/IPC/Key零外泄反例。
  全部必要证据与候选一致、独立安全PASS后才提交完成状态及双远程推送。
- **STOP / REPLAN**：连续两轮无新增证据则换方法；资格失败不降低阈值，不把配置文本当运行证据。
  外部硬门缺失集中说明并继续独立工作，不以当前账户新profile冒充独立机器。
- **FINAL EVIDENCE**：通用工具入tools/，原件保留log/stage7-e1/；结果和候选绑定写本文件/progress，不建立第二进度源。

### E1 资格修订与外部条件

Electron43.4.0在E1依赖资格中命中需上游修复的sandbox preload cache公告；按详细设计§3.1更新43.7.7，
实际产物与受影响壳/全量验证重新绑定。打包工具依赖继续按具体公告、能力与锁树资格处理，不盲目依赖audit自动修复建议。
用户2026-10-04确认目前无独立Windows环境；E5独立安装硬门保留BLOCKED，继续其余工程工作，不关闭Stage7。
当前账户真实EXE测试另做可逆profile隔离工具资格；原profile仅原子rename、禁止读取/复制/解析私有内容，
先证明排他所有权、持久恢复清单、逐步中断恢复及原FileId/ACL恒等，再经独立审核执行；不能以该方法替代E5。
实际只读预检发现当前AppData与既有aibrowse根的volume API/最终路径身份不一致，同父同卷原子rename前提不成立。
工具必须拒绝实际切换；未知根因保留，不跨卷复制私有profile或放宽身份门。E1实际EXE需另一个可通过隔离资格的数据环境，
本机空白测试账户可作为E1候选条件，但仍不替代E5独立环境。其余源码/合成工具验证继续。
用户随后明确现有AIbrowse仅为开发版且未留实际用户数据，授权删除当前账户的AIbrowse数据。
因此本轮允许一次性清空精确KnownFolder/AppData下的aibrowse开发数据根，先核实际路径/进程/重解析属性，
不触及仓库与原始验收证据。删除后固定KnownFolder根落在当前宿主的MSIX虚拟化映射内，旧同父rename路线退出使用。
合成scope核对KnownFolder别名与解析实体的128位FileID、卷及ACL，以双句柄锁定同一空根；
通过有界所有权marker、固定All执行入口、进程创建时间与Windows Job证明本轮归属，独审后准入实际EXE。
该路线不移动或恢复旧profile；失败保留整份自有合成根、终态记录与原始日志，不能把失败根当空根直接重跑；
该授权仅替代此处旧profile保留要求，不允许自动清除后续测试失败数据或放松产品恢复语义。

Electron升级后的A-04冒烟保留“最多三步，第四步零调用/零副作用/零审计”。原断言把CSS滚动1+2+3当作整数6，
在当前设备像素比例下得到6.6666665，属于失效的渲染量化假设；改为同一实际浏览器三步参考与四步参考必须可区分，
精确核对实际scrollBy调用序列为[[0,1],[0,2],[0,3]]、最终位移严格等于三步参考，原失败保留。

实际production trace定位到ContextBadge在Tab加载期重复preview，引起Electron等待加载监听累积。
徽标按活动Tab与文档状态合并刷新，每个存活Tab最多一个在途preview，只保留最新脏世代；加载期等待既有Tab事件。
旧请求、已销毁Tab及旧effect不得发布结果；预览或初次列表失败显示“预览暂不可用，提问时实时采集”，
仅无活动Tab显示无上下文。提问/Agent仍在执行时实时采集，不能复用徽标快照。
以真实组件反例和实际Electron加载期30次更新的监听峰值/完成后归零证明修复，不提高监听上限。

实际EXE第二轮在凭据tmp→final原子rename触发EXDEV，保存失败且原生确认尚未出现，作为新的真实红态保留。
按详细设计§3.1统一Node实体根，保留逻辑userData/Session/单实例及原子持久化；不只修改credentials或加入复制回退。
补同对象旧目录、两侧缺项、嵌套路径偏移/链接及预算反例，复验Provider配置/凭据、Conversation与三库、日志落点，
重建最终包并重新实际运行后再由独立安全Reviewer闭合此差量。

### E1 最终证据与交付边界

实现差量基线为25a6aa5489b0596d529b97d62eab8ee789bb1e70；新的独立安全Reviewer已限定E1 PASS，
报告`log/stage7-e1/independent-e1-final-review-001.md`，受审106文件清单SHA256为
e859f35d5b05dc02bc7fbcdd6e3c529dfca5652bd9d38668178d2b9a9a245e70。
候选005的EXE为88d7370c5569c3c08d50971ea3171459b5f5c07464663be3d30309183e70710e，
ASAR为ee5e3623b2e905e22a621c19593337e99ce52193a346dfb353d0703ccb79abe4。

Product journal-b997103bbdd14bf1ae6987564f82d956覆盖原生取消/确认、绑定网络去向、第二实例和冷重启；
该All的旧AppData探针悬挂原件保持失败。修复后固定新空scope的Tamper journal-8edf39ba16924ace964b70341acfc2ef
实证调试入口关闭、等价单字节ASAR篡改失败、裸app拒绝；`independent-release-dynamic-binding-001.json`
将两份报告、当前包与篡改副本绑定，不将旧All改为成功。
全量222文件4203项通过，最终typecheck/lint/format及diff检查通过；native-root之后dev/production默认及各五组
跨进程set/check原件通过。全部位于`log/stage7-e1/`，未变化的独立六场景Electron安全资格按范围复用。

本轮实际网络使用合成Key和受控loopback；真实外部Provider NOT RUN，不能称无授权或凭据不可用。
实际包冷重启使用受控强制终止，三库只证明空库同对象/schema/完整性重开；既有业务行另有dev/production证据。
UTF-8字节canary零命中、DPAPI和无Key读回机制分别报告，不扩大为所有编码的观察结论。
production audit为0，完整构建树仍有8条同一缓存公告的high传播，当前调用面无共享缓存且依赖不入ASAR；
不称依赖树全无漏洞。Windows x64未签名内部候选、手动升级、E5独立环境缺失和Stage7未关闭边界不变。

## 本轮交付检查

按各E任务和Seventh_stage逐项核对实际证据，必要独立审核PASS后逻辑提交、正常双远程同步。
Stage7只有在E6新独立Stage Auditor通过且全部硬门满足时才关闭。历史失败、电池NOT RUN及外部缺证如实保留。

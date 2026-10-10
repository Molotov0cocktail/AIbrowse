# 第七阶段任务合同

## 共同实施约束

设计baseline：`6bc4f00ab065d2c751d89ab120106aa4accce805`；实际实现开始前记录当时精确HEAD与工作区归属。
权威源依次为Seventh_stage、proposal、detailed-design、threat-model；状态只在progress。
用户2026-10-04已授权依次完成E1–E6实现、验证、必要独立审核与收尾；原E1前停止边界失效。
文档审核不等于运行PASS；Stage7硬门满足并收尾后停止，不启动Stage8产品实现。

2026-10-10用户授权工程重定方案：不改变最终产品实现效果时，可修改本文件及其它项目文件的工程约束、
验证路径、工具设计、负载/工程预算、执行顺序与审核组织，说明同一产品承诺如何得到等价或充分证据后同步合同。
既有具体方案和工具前置门不是永久需求；当前要求通过困难时，直接向用户提交明确替代方案与影响请求裁决。
不能将实际失败改判成功；可能改变产品效果或接受未解决用户风险的调整须用户决定。

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

### 当前恢复验收路线（2026-10-10 接管重定）

baseline 为 `54783cd0c3e22c1fb692b54fca95fc650e2ea15d` 和接管时全部既有工作区/暂存差量。
目标是取得真实产品备份、恢复、guardian 继任及冷启动后的四域一致性证据；不修改产品数据、安全、容量或性能承诺。
以下历史 UIA/原生 Open 宿主/精确 wrapper flags 资格路径暂停，不再作为本轮前置门；原工具与 REPAIR/失败原件保留。
理由是该路径的控件绑定和资源监督缺陷属于工具，不能推出产品恢复失败，也不值得继续用通用控件取证代替产品验收。

实际发行补证的普通窗口操作现获用户授权由外部UIA或可见控件模拟动作完成，原因是用户暂无法逐步手动点击。
仍运行真实已安装发行包，不改变renderer/preload/IPC或增加测试接口；每次动作前复验精确PID/创建时间/安装image及摘要、
主窗口归属和当前可信应用文档/控件语义，原生窗口另核owner/类型/当前字段，拒绝不唯一或陈旧控件。
本次只读小样若UIA不提供React文档/控件，则停止该定位方案，可按用户明确允许的模拟点击使用已复核的真实窗口截图：
仅点击安装版固定顶栏和可见诊断面板，动作前复核窗口实体/边界/前台及点击点归属，截图明确显示相应文字与状态。
当前场只有已知空白用户Tab和合成SourceA，不将这一窄视觉操作承诺为任意敌手页面的通用自动化能力。
先做一次有界只读观察，再按实际状态执行本次诊断生成、取消和同一预览保存；保存字节/摘要与预览一致、正常退出后的
完整持久行列oracle仍是产品证明，工具动作成功不能代替这些结果。单个观察15秒/512节点；无新增信息或绑定失败即停止该动作，
不重开旧通用控件资格链。Windows安全桌面UAC不得绕过，用户休息期间不启动需其确认的后续安装事务。

新路线只在 `tools/data-qualification/restore-check/` 的独立编译入口提供固定 dialog 返回值和主应用 DOM 按钮动作。
入口先隔离合成 userData/sessionData，再动态装载普通非 smoke 的原 main；renderer/preload/IPC、维护排水、
真实 SQLite utility、文件验证/切换、guardian 和启动健康准入不替换，不新增产品测试 IPC、运行时环境开关或生产故障开关。
适配器只操作唯一主 BrowserWindow 的固定入口文档，动作前核固定按钮/唯一性/启用状态；网页不获得工具能力。
构建、实际源模块与产物须绑定，发行包中不存在该入口或适配器；原生 Save/Open/确认的真实发行交互另补证，不能由适配器授 PASS。

复用已独审 A/B/H 固定小夹具与完整行列 oracle、未改变的容量/超限/中断证据，不重跑高成本矩阵。
R 依次为 A 健康装配→界面备份→正常退出→Job0/空 writer 账本→保留 A 并离线安装 B→
界面取消 Open、取消确认、批准恢复 A→真实 guardian 继任→正常退出→冷启动→四域完整一致性及旧 B 保全。
P 覆盖坏 index 的 partial 入口/取消/批准进入 gate、恢复合成 H、真实继任/冷启动、危险历史规范化与坏 index 保全。
每场共用 600 秒工作和原 30 秒真实退出收口；沿用 FixedTransferJob transfer 的 24 进程、单/树 commit 2/4GiB、
100ms 采样 RSS 单/树 1/2GiB，不复用旧观察器的 flags 假设。Job0 不宣称每个后继进程 exit0；
必须同时有精确阶段完成回执、生产 writer 账本双空和离线 oracle。所有真实场串行，首失败停止并保留；
最小启动/继任可行性失败且无新信息时换路，不扩建通用采集系统。新的独立持久化/安全/并发审核按整个风险边界执行。
完成以真实 R/P、发行交互补证、受影响回归和 E2 整体独审为准，纯工具绿态不能关闭 E2。

运行期 oracle 差量：固定夹具的审计表为空，但普通启动及维护排水各合法写入一条
`reconciliation/complete`。静态夹具全表不变假设不适用于实际应用；生产行为不为迁就该假设修改。
按真实调用链冻结 R 的 A 备份后及容器内审计为 2 条，恢复健康装配仍为同一 2 条、普通冷启动为 3 条；
B 在恢复前启动及维护后为 2 条，rollback 必须完整保留。H 离线备份及恢复健康装配为 0 条、普通冷启动为 1 条。
恢复 checking 装配跳过再次 reconciliation；危险历史规范化不生成此类审计，不把继任误记作普通启动。
审计逐行核精确五字段、UUID v4、rule_id=null、固定 kind/reason、场景时间窗、唯一身份和全部历史行恒等继承；
任何增减、改写或其它审计均拒绝。其余所有业务表/会话仍用原完整 oracle，不能整表无条件忽略。
离线 SQLite 校验只打开新的合成副本；产品退出原件仍须无 sidecar，不能把 oracle 自己生成的 WAL/SHM 当作产品失败。
保留首次 R 的失败原件，修正本工程假设后在新 scope 执行一次，不重用旧冻结 proof。

夹具 UI 兼容差量：旧 A/B/H 的 Watch `A-rule` 等文本 ID 虽能通过持久化 scanner，却违反正式 IPC 的 UUID 门。
产品门保持；共享小夹具改用编译期固定 UUID，八类实体及全部外键、facts/dedupe/hash/byte_length 一起一致生成。
新的 expected 摘要只从独立创建的固定合成源冻结，不从恢复结果学习；原夹具源码/expected 和失败原件保留。
先保存真实生产 query/output validator 拒绝旧夹具的红态，再验证三套完整语义、H危险历史规范化和原逐列篡改反例。
不引入恢复结果逆映射或重算摘要来掩盖篡改；来源变化须新构建，旧小夹具 PASS 只留历史，不授当前 UI 夹具通过。
容量/中断的其它夹具与产品源码未改变，其适用证据继续复用。

### 历史实施差量（保留依据与证据边界）

- **Windows会话文件身份差量（2026-10-11）**：全量真实替换反例发现64位NTFS文件ID转为JavaScript number后可舍入碰撞，
  临时成员虽被移位且仍存在，异身份文件仍可能通过原dev/ino比较。文件归属须从独占描述符读取精确bigint dev/ino，
  发布前、发布后及失败回滚使用同一种精确身份；普通单链接、非符号链接与目标不存在门保持。
  保留原真实替换反例，增加超过2^53的稳定碰撞红态；修复后核旧索引保留、异身份哨兵不改不删、只回滚本次消息，
  完成受影响会话写入/持久化回归及独立风险审核。该修复不改变会话内容、50/200上限、备份格式或存储位置；
  旧失败与此前容量/恢复证据保留，但新实际小R/P和最终候选绑定当前来源，不以旧来源证明新实现。
- **partial退出失败差量**：会话索引读取失败必须继续关闭业务/维护准入并进入恢复入口；
  单纯装配读取失败且没有未完成写入，不得伪装成退出排水失败而阻止原生确认后的正常关闭和冷恢复。
  区分storage/read failure与实际写入、在途工作或退休失败，后者仍须锁存并拒绝成功退出。
  先用真实坏index、零业务操作的shutdown建立旧行为红态，再核坏索引维护拒绝、真实持久化失败、
  取消/退出并发、partial gate/relaunch装配及受影响回归，新的独立持久化/并发审核通过后才进入实际partial验收。
- **物理上限夹具可行性差量**：物理Sources/Research/Watch仍为512/64/512MiB，业务/schema门同时满足；
  合法夹具只经SQLite自身分配和释放形成freelist，禁止文件尾补零、truncate扩长、稀疏文件冒充合法库或VACUUM碰运气。
  工具仅操作新建合成副本；先以≤1MiB小库证明固定算法，使用两个编译期scratch表，bulk每条zeroblob≤8MiB、最多512条，
  预留16页供独占单行tail表，按实际page_size/freelist精确补剩余页后DROP两表，不无界尝试payload。
  尾段只执行一次，若SQLite实际页数与假设不符即保留并REPLAN；原schema定义/user_version、数据、完整性须保持。
  这一步只授算法小可行性，不授64MiB实际首门、最大三库、SQLite backup后长度或组合full50通过。
  后继真实生成、来源绑定、空间与进程预算先补正式差量并独审；现有完整50会话结果只复用其已证范围，不拼成物理最大PASS。
  首个真实生成只选择既有固定合成Research源，核既有来源证明后复制到新UUID工具根，目标恰好64MiB；
  生成后关闭连接，再由SQLite backup写第二份独立64MiB文件，逐份核页数/文件长度、freelist、schema、版本、完整性和Research业务投影。
  只复用生产私有staging连接策略：journal_mode=MEMORY、temp_store=MEMORY、cache_size=-8192须读回，
  生成连接关闭且无sidecar后才开始backup。目标backup会创建临时rollback journal，原零journal假设已由小型实测推翻；
  改为两份64MiB、独立128MiB journal预算J及16MiB工具额逐文件按实际分配单元计费，另留原1GiB空余。
  J是当前首门的工程准入限额，不由一次小测的512B观测推断最大值；不占用或替代工具余量。
  backup进度及前后检查只允许目标固定-journal，源侧sidecar、额外附属文件、链接/身份变化或首次观察超J均停止并保留；
  结束关闭后必须无sidecar。每次观察须核当前路径和文件身份/长度，仅报告maxObserved，不宣称连续峰值或磁盘预约。
  新J预算和运行时检查经独立复审后才恢复真实首门；节点间无法原子冻结文件系统的诚实边界不改写为硬磁盘限额。
  复用已审FullTransfer原生import监督，120秒工作/原30秒退出、单进程/2GiB提交/1GiB采样RSS门保持；
  固定Node、构建来源/制品、源与输出路径/身份及排他所有权均须绑定，失败保留，首失败停止。
  新工具独审后仅允许一次64MiB首门；Node生成与backup保持容量不代替实际Electron产品worker资格，最大三库/组合full50仍另行验证。
  64MiB首门通过后，下一个有界可行性对象固定为同一既有合成集合的Sources源（151,023,616B及既有hash/proof），
  仅在新的`physical-sources512-UUID`根复制并扩至512MiB，再生成独立512MiB backup；不更改已完成Research64工具或原件。
  复用已审padding/journal/复制/原生Job原语，补Sources schema/5000条业务数据、逐份页数/freelist/完整性/FK读回。
  空间为两份512MiB、J=128MiB和16MiB工具额逐文件取整加原1GiB；120+30秒、单进程RSS1GiB/commit2GiB保持。
  新固定入口无任意路径/SQL/容量/重试参数，源码、Node、源proof、制品和输出身份闭合后经独审仅运行一次。
  512MiB构造若触发内存/期限或算法假设失败，保留原件并定位事务/缓存等工程约束，禁止放宽门或无诊断换批重跑。
  此门仍只授Sources512的Node可行性。后继Watch512复用同一已审原语与预算，只选择原同集合Watch源
  （110,444,544B及既有hash/proof），在新`physical-watch512-UUID`根生成两份512MiB；旧两域工具与原件保持。
  固定200规则、2800事件、8400证据项及1030摘要，生产Watch schema/业务scanner与全部十五表稳定摘要须保持；
  补小库关系/合法同计数篡改/中断及身份反例，新的独审与最终构建绑定后才执行一次实际Node门。
  三域构造仍不代替实际Electron worker与三库加full50组合，该后继另行绑定正式合同与来源。
- **物理三库与full50组合差量**：三域Node首门通过后，在新的`physical-full-transfer-UUID`根组合既有三份
  原始构造库与已验证full50会话，原件只读且逐份绑定proof/hash/身份；不重新构造容量夹具。
  输入为Sources512MiB、Research64MiB、Watch512MiB及3355458876B/51会话子成员，均来自同一既有合成业务集合。
  新工具置于`tools/data-qualification/physical-full-transfer/`，复用已审核FullTransfer导入复制、生产Electron
  transfer-worker、guardian、预算与退出协议；仅固定输入来源/闭合证明及物理长度oracle发生变化。
  构建期适配若用于复用旧协调模块，必须只替换显式列出的工具模块依赖，拒绝未命中/多命中/生产模块替换；
  旧FullTransfer源码保持，适配映射和全部实际来源进入构建证明，不能将替换后的工具称为原旧制品。
  导入120+30秒单Node、commit2GiB/RSS1GiB；真实Electron备份→发布→读取该容器恢复到暂存区，
  两操作各沿原1500秒及分阶段预算，整轮3060+30秒、24进程、单commit2GiB/树4GiB、单RSS1GiB/树2GiB。
  100ms采样、实际child退出/guardian退休/外层Job0和固定54成员集合保持；空间按原campaignSpace逐文件
  取整含全部同时保留副本、J及1GiB余量，不能拿已有源空间抵扣新scope需求。
  生产schema/业务scanner、5000/30/200/2800/8400/1030计数与完整会话树摘要保持；
  备份和恢复暂存三库必须读回512/64/512MiB物理长度及非sparse/非压缩分配，容器仍≤5GiB。
  保留原完整50小三库结果与RSS失败，仅运行这次新增组合；先聚焦固定来源、错proof/成员/物理长度及失败收口反例，
  新独审与最终绑定后串行一次。它授Electron容量管线，不授UI、DatasetSwitch、完整服务图冷恢复或E2整体PASS。
  独立反例确认“磁盘成功回执”不能证明发布本身在期限内完成，故实际入口改为同一PowerShell中的唯一campaign：
  预检前CreateNew占用campaign claim，失败不能单独续跑transfer。内部顺序执行import与transfer，各自保持原120秒和3060秒
  绝对期限及各自原生Job；import完成最终IO、环境恢复、全部关闭及期限复核后，只向同一调用栈返回闭合内存结果。
  调用方立即复验同一import截止和input-proof摘要，再启动transfer；删除从磁盘import-result授予后继的入口。
  不新增PowerShell子监督或递归成功标记。所有持久结果均为pending-wrapper-exit，不独立授成功；最终发布前后与关闭后仍检查
  原期限，整轮只有最终stdout成功和实际wrapper exit0共同授证。晚Move、关闭失败、伪造/迟到前序结果和预检失败须有反例。
- **完整容量RSS失败差量**：真实FullTransfer在会话处理阶段触发原单进程1GiB采样门后，保留失败输出和已释放Job证据，
  不提高原RSS/commit/时间门或直接重复同轮。先定位有界流读回与会话投影的分配来源；
  当前可确认TransferInput.copy每64KiB重新分配，修为一次调用复用至多64KiB缓冲，回调只在同步返回前消费借用视图。
  全部现有调用点均同步hash或写入，不保留该视图；独立read仍返回自有缓冲。短读、双重摘要、精确EOF、
  输入身份、取消/期限、短写和最终整组读回继续保持。先用有界分配反例及受影响容器/会话/流水线回归验证并独审，
  再以新来源绑定做有诊断的实际资格；纯分配改善不证明历史唯一根因或实际RSS已达门。
  下一轮复用现有GetProcessMemoryInfo结果，仅当RSS刷新峰值时记录已核精确PID、十进制创建时刻、root/other闭合角色及采样尝试序号；
  不增加API调用、路径/命令行采集或样本，不按角色排除计数。尝试序号不宣称整轮采样已完成，原RSS判定与退出协议保持。
- **实际会话失败差量**：实际默认production中的持久化失败必须保留原轮FAIL；缺少错误分类时不能据dev成功归因抖动。
  先移除失败路径的合成数据删除，成功后仍须真正排水和资源关闭才清理；已被旧清理删除的原件如实记缺失。
  必要写入诊断只允许编译期阶段、成员类别及闭合错误码，不记录路径、消息、正文、Key或异常message/stack。
  先用确定性失败反例证明分类与保留，再以有界重现定位；不增加重试、放宽投影或掩盖写入失败。
- **FullTransfer原生夹具差量**：旧console夹具在原24门下实测完整48个Job成员并失败，不能把CreateNoWindow当作无辅助进程证明。
  只替换资格夹具为Windows GUI子系统；先纯编译反例及实际PE的AMD64/PE32+/Subsystem2/非DLL校验，主产品和原24全成员门不变。
  新对象须独审后从transfer-success（根及一个child）最小可行性开始，随后import-success、import-child、transfer-limit、timeout；
  各新scope，前四沿原12秒、timeout沿原1.5秒，额外30秒仅确认Job实际归零。每进程显式1MiB、落盘≤1MiB，首失败停止。
  不从成员数中剔除conhost，不增PID容量或重用旧console三项PASS代替新对象；历史48的具体成员来源未被证明，仍按原证据报告。
  超时后的额外30秒只用于关闭已拥有的Job和精确根进程，二者共用一次单调截止；
  Job计数归零不等于根句柄已signal，后者必须在该同一剩余收口期限内证明，不能改成0秒探测后冒称通过或重新给30秒。
  正常工作及正常收口仍在原工作期限，未知退出保留所有权和首个明确失败类别；不能用wrapper退出后的PID消失补造原持有证明。
  真实Node导入在单进程门下实测完整2成员并被拒绝后，仅import改用DETACHED_PROCESS与原EXTENDED_STARTUPINFO_PRESENT，
  transfer保留原创建标志。绑定Node实际PE仍为AMD64/PE32+/Console；不修改EXE或根据进程类别放宽原1门。
  官方[Console创建语义](https://learn.microsoft.com/en-us/windows/console/creation-of-a-console)说明detached启动不连接console，
  这不证明本机一定没有其它成员；旧第二成员未采集映像，仍unknown。失败成员只允许在已核精确句柄上记录
  root/system-console-host/other/unknown闭合分类，不记录路径/命令行，也不按分类排除成员。
  独审后先一次固定真实Node小脚本，验证fs/crypto/stdout/stderr与完成文件；不创建child、不接触完整数据，
  12秒工作、原30秒退出收口、落盘≤1MiB，原import1/commit/RSS门不变。失败即REPLAN，不能直接重跑完整导入。
- **原生选择器资格差量**：UIA控件形状和初始文件名投影属于工程假设，不当作产品需求。
  真实保存窗口须保持主进程精确身份、同PID/owner、原生窗口类型及产品标题校验；
  缺少唯一可写输入时先用有界、无私人名称/值落盘的结构证据重定选择器，不以坐标、CDP、JS或任意IPC绕过。
  当前诊断只限唯一FileNameControlHost、最多8层祖先/16个后代及原512节点树，采集后受控失败并停止后继动作。
  控件关系无新证据、未知归属或预算失败时换方案，不重复相同轮。原30秒动作、35秒helper收口、480秒runner及600+30外层期限不变。
  后继恢复成产品验收前须独审新的唯一控件定位、写入值读回和原生按钮语义；诊断分类不能授保存或恢复PASS。
  本机结构已证明host下唯一Edit类窗口缺少UIA ValuePattern，后继工具限定用该host子树的唯一ID1001/Edit HWND。
  写入前后核原产品PID/创建身份、原生dialog/owner、HWND实际Edit类/控制ID/GA_ROOT、enabled/visible及非只读；
  不凭UIA Pane类型或全窗口任意可写控件替代这些身份。窗口或host关系变化立即拒绝。
  只许固定WM_GETTEXTLENGTH/WM_GETTEXT/WM_SETTEXT，采用不同进程的SendMessageTimeoutW，单次≤1秒且不超过原30秒剩额；
  禁用broadcast和NOTIMEOUTIFNOTHUNG。文本≤4096个UTF-16单元，仅在内存比较默认值/已批准的固定目标，禁止原值落盘。
  目标仍为runner自有目录内不存在的绝对.aibak，写后及保存前读回必须完全相等。按钮能力须单独资格，不随文件名修复扩大。
  API依据为[SendMessageTimeoutW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw)、
  [WM_SETTEXT](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settext)及
  [GetDlgCtrlID](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdlgctrlid)；这些只证明调用语义，实际HWND资格仍须本轮验证。
  实际原生读回初值为固定stem后，初值资格只接受两个完全相等字面量：AIbrowse-backup.aibak或AIbrowse-backup，
  输出分别为exact-default/exact-stem；不猜测省略扩展名的历史原因，不接受任意其它名、大小写变化、空白或路径。
  该工程差量只修订初值可见投影；写入的目标仍须完整、绝对且以.aibak结尾，两次读回必须与完整目标逐字相等，
  HWND/host/owner/按钮/30秒门不变。归档只允许同样两个闭合初值分类，仍核完整结构与来源自绑定；先反例、回归及独审再实际。
  初值通过而固定按钮选择失败时，先在同一已核owned dialog执行一次只读按钮投影并受控停止，不增加Invoke或其它按钮动作。
  仍沿原512节点/30秒门，仅投影ID1/2、UIA Button或Windows class Button候选，至多32个；输出只含闭合ID/type/class/name分类、
  同PID、enabled/offscreen、HWND是否存在和InvokePattern是否存在。名称只在这些候选内映射既有保存/取消有限语言集合或other，
  不记录原始未知Name/ID/class、文件名、路径或桌面其它窗口。完整枚举、精确dialog前后复核与预算缺一即失败；
  下一次动作方案由实际投影决定，不根据未观测到按钮便猜测禁用、类型或ID原因。诊断轮不授取消/保存PASS。
  实际投影取得原生Button/ID1或2、精确名称、同PID、enabled/visible及HWND，但缺UIA Button/Invoke后，
  动作方案改为该精确原生按钮的MSAA默认动作；不能只按ID匹配同对话框内其它无HWND候选。
  UIA有界唯一枚举结合原生class/Button、GetDlgCtrlID、GA_ROOT/IsChild、dialog owner、产品精确进程身份，
  并核MSAA S_OK、ROLE_SYSTEM_PUSHBUTTON(43)、可用且可见状态、原有限语言精确名称及非空默认动作。
  role/state必须为严格int，name/defaultAction必须为严格string；不得将null、布尔、数字字符串或小数转换成有效事实。
  实际009证明WM_SETTEXT与Edit完整双读仍不足以证明IFileDialog最终选择：目标路径不存在，备份落入原默认位置。
  当前文件名提交方案须REPLAN，先核实际编辑/选择语义再做最小资格；不得直接重发保存、只追加消息碰运气，
  或把默认位置文件移到预期位置追认成功。原件、真实动作与路径失配同时保留，实际完整场景仍FAIL。
  复用E1已审MSAA调用语义，按当前保存窗口范围补新的绑定/动作前复验；不引入任意消息、键盘或坐标点击。
  保存前仍须原生文件名完整目标读回，取消不写目标；只调用一次默认动作，异常/迟到不得补发。
  [MSAA默认动作](https://learn.microsoft.com/en-us/windows/win32/api/oleacc/nf-oleacc-iaccessible-accdodefaultaction)
  可能同步阻塞，调用前后核原30秒，35秒helper及600+30秒Job负责真实收口，不把方法返回当产品成功。
  成功还须原取消零产物/再次保存/完成UI/独立备份读回/正常退出；Inspect恢复为资格检查成功语义，旧有意义断言重新纳入。
  工具来源闭包、成功归档的闭合动作证明与来源清单同步；现有归档身份/ACL/限额/只保全自有合成数据协议保持。
  先用真实观测形状和敌手身份/超时/语义反例、新独立安全审核后执行一次完整小场景；任一资格失效保留并换路。
- **成功资格现场保留差量**：现有ArchiveCompleted仅接受Tamper成功轮；小备份成功后不得改用失败归档或删除profile。
  在下一轮ProductTransfer之前，为成功证据加载器增加固定small-backup-cancel-save-readback分支，
  与旧Tamper的BindingJournal/run目录形状互斥，原ArchiveTransition同父保全、FileID/ACL、新空根及失败保留协议不变。
  原成功terminal、launch/report、精确产品身份、profile、包及全部工具来源摘要、备份读回与固定发布文件须相互绑定，
  外层Job实际释放和当前marker/根身份仍须复核；不按任意ok报告授权移动目录。
  新NativeSaveControl也须进入工具来源清单。源码自绑定在运行前完成，不改写历史回执或豁免归档器本身。
  证据路径只能由固定journal派生；有界读取、持锁与新独立安全/持久化审核通过后才执行实际成功归档。
  该固定小备份工具的metadata、源码、包及备份复核共用一次150秒单调读回期限，64KiB块前后核时，不分段续租。
  metadata沿原单文件门且累计≤8MiB；16个固定源码（含独立原生按钮helper）每个≤8MiB、累计≤32MiB；
  包只读固定EXE≤512MiB、ASAR≤32MiB、Guardian≤512KiB（后者沿包校验器原门），累计≤544.5MiB；
  备份沿现有≤5GiB界限。以上是当前工具准入预算，不修改产品数据容量；验证失败在intent前停止并保全原目录。
  此分支只保全工具拥有的合成profile，不授恢复、非空三库一致性或独立Windows验收通过。
- **新增持久边界中断差量**：复用旧DatasetSwitch的适用330点证据，新增固定18点实际子进程终止与新进程重开，
  只覆盖后来加入的gate创建/flush、replacement临时记录创建/写入/flush/发布、两个旧active归档前后、
  新active临时文件创建/写入/flush/发布、gate退役前后及active清除前后。另一次正常控制必须先证明18点枚举恰好命中。
  生产源码不加故障开关；工具仅对固定dataset-active模块作可逆的构建期暂停插桩，匹配点缺失/重复即拒绝构建，
  剥离插桩后须与绑定原文相同。其它边界沿既有DatasetContext.boundary；不替换文件IO、启动判定或实际退出。
  固定小型SQLite标记库与Conversation哨兵用于文件协议oracle；父进程持有精确child，终止并确认exit后才新进程重开。
  必须保留旧三库/会话与opaque active原件，正常准入只能开放完整新代；不完整凭据只能进入recovery-required。
  使用实际DatasetStartup和只读健康句柄核标记，不把这些合成标记当完整Repository schema或真实服务图健康。
  每child沿原8秒工作/2秒退出，19场及重开共用600秒、分配量≤64MiB；IPC每帧≤512B且每child≤128帧，
  stdout/stderr合计≤4KiB。首个枚举、退出、归属、时间或空间门失败停止，不追加重跑或把旧预算失败改写PASS。
  spawn前冻结单调工作截止，message/exit/输出close结算均复核；timer只触发停止，延迟回调不延长期限。
  kill返回false或抛错须保留失败并继续持有实际退出，不能把后来非零自然退出当目标中断成功。
  exit与stdio全部close共同结算，尾部输出仍计入4KiB；输出排水沿同一剩余工作或退出期限，不另给时间。
  工具源码放tools/data-qualification/replacement-crash，先纯反例与新独立持久化/并发审核，再由主协调串行实际运行。
  这是进程中断证据，不声称物理断电、空间耗尽或完整产品恢复验收通过。
- **默认冒烟 SQL 审计差量**：SRT-12 的文本 `prepare/exec` 扫描需要分类 E2 新增执行点。
  只按完整相对路径登记 Sources/Research/Watch 的四个 transfer-validation Repository 模块，
  以及 storage 的 staging-sqlite、startup-probe、transfer-pipeline、transfer-schema；分别承担
  已审核的编译期业务查询/参数绑定、固定 FTS 重建、安全 PRAGMA、完整性/schema 查询和冻结迁移。
  main 中 DatasetStartup.prepare、StartupPreparation.prepare 及恢复runtime中replacement.prepare的确切
  协调语句单独判为非 SQL，不放行其它 main/storage SQL 调用。
  不允许按 storage 目录整体放行；同名异目录、任意新增模块、main 动态 SQL、renderer/preload SQL
  保持拒绝。该文本检查证明执行点职责分类，SQL 本身的封闭性仍由实现测试和独立审核证明。
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

### E2 旧集合120秒耗尽差量（2026-10-10）

baseline为`54783cd0c3e22c1fb692b54fca95fc650e2ea15d`及已有E2工作区；只补详细设计§4的旧O时间门，
不重新跑旧330边界。工具放`tools/data-qualification/old-data-deadline/`，只创建新的固定UUID合成根。
使用小型固定十三成员/嵌套会话哨兵，不冒称合法业务数据库或完整服务健康；每场≤16MiB，整轮≤64MiB。
正常控制证明同一DatasetSwitch文件流程能提交；随后固定inventory、backing-up两场各一次，首个oracle不符即停止。
inventory只在已明确识别的旧Sources文件读取进度点延迟；backing-up只在首个旧成员实际复制并flush后延迟。
每场在生产DatasetContext现有端口注入一次120250ms真实等待，保留原120000ms单调截止的前后校验；
不得改生产时钟、产品期限、源码或用虚拟时钟结果授真实门。等待返回后的拒绝不证明任意阻塞IO能强制取消。
纯反例可用短额度/受控时钟验证选择点、一次性等待、旧内容/身份保持和预算不续租，并明确区别实际运行。
旧数据普查/复制应返回old-unchanged/interrupted，旧十三成员及旁支的身份/字节不变，work及失败副本保留；
已持久扣除rollbackCopy额度不得恢复。实际旧child退出后用新进程重开：inventory允许recovery-required，
backing-up应识别完整原旧代并返回old-restored；两者均不允许切换新数据或重新领取旧O时间。
正常控制与重开每child≤10秒，两场耗尽每child≤150秒，全部顺序执行并共用360秒工作及原30秒Job退出门。
复用已审核的FixedTransferJob transfer模式和精确进程退出协议，总24/单进程RSS1GiB/树RSS2GiB、
commit2/4GiB及100ms采样不变；只启动固定Node工具和至多一个直接worker，不启动产品、网络或Provider。
工具来源/制品/固定Node、自有路径身份、小证据和实际child exit/close须绑定；失败保留且不复用scope。
实现及有意义反例经新独审后才运行；此门不授ENOSPC、SQLite业务一致性、R/P恢复或E2整体PASS。

### E2 超限文件读前拒绝差量（2026-10-10）

沿当前E2 baseline及详细设计§4的原硬上限；新增`tools/data-qualification/oversize-preflight/`，
在排他新建`oversize-preflight-UUID`工具根中只构造四个负例：容器5GiB+1、Sources512MiB+1、
Research64MiB+1、Watch512MiB+1。它们明确为稀疏敌手输入，仅验证实际文件长度门，不能授合法数据库、
实际容量分配、磁盘耗尽或完整恢复PASS。合法物理三库证据继续使用已审核的SQLite构造文件。

文件先CreateNew，再经[FSCTL_SET_SPARSE](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_set_sparse)
设置稀疏属性，成功并读回后才SetLength；不取消稀疏标记，不遍历/复制/哈希整个超限正文。
只写固定有界头部，逐份核唯一文件身份、真实EOF、稀疏属性及实际allocation≤1MiB，整个工具落盘≤16MiB，
保留原1GiB空闲余量。文件系统不支持、身份漂移或首次预算失败即停止并保留，不退回真实填满卷的方法。

固定Node与已审import监督保持120秒工作/30秒退出、单进程、commit2GiB/RSS1GiB；原期限覆盖构造和运行，
制品/来源/路径/一次性claim全部绑定。调用真实`inspectNativeRestoreInput`及`openPrivateStagingDatabase`，
同时复用已有纯测试的“先检查size再打开/解析”顺序反例；实际负例只声明真实超限拒绝和原件保持，
不能从相同错误文本单独推断内部零读取。以有界合法控制证明入口确实可达，核报告与原件、无额外sidecar。
新增工具先完成小夹具/错来源/边界/停止反例和独立复核，再串行一次实际负例；不重复物理最大合法库构造。

### E2 后续真实恢复的夹具与语义差量（2026-10-10）

本差量baseline为`54783cd0c3e22c1fb692b54fca95fc650e2ea15d`及已有E2工作区；详细设计§4与原资源门保持。
先在`tools/data-qualification/product-restore-fixtures/`实现固定小A/B/H数据集和独立语义oracle，
每套三库及Conversation合计≤16MiB，不读取真实profile，也不调用大容量prepareFixtures。
A/B各含不同固定标记、非空Source↔Watch真实关联、Research task/result/evidence、一个会话与两条消息；
生产schema/业务scanner先通过，再按固定prepared SQL及闭合主键/关联集合验整套，拒绝混代、空库和错关联。
允许正常启动的时间及恢复规范化字段变化必须逐项定义，不用全profile字节不变替代业务一致性。
H另外包含旧running Research、未终态Watch run与已消费slot、claimed Digest、active cycle及pending notification。
恢复oracle为interrupted/uncertain、schedule paused、notification failed且attempts=0，旧claim/cursor/slot保持、
Session consent失效；不能用全paused且无历史的夹具证明不重放。原件、红态、工具来源与小预算全部保留。

后续真实场景R用健康产品UI保存A，再在已证明所有writer退出的自有根安装B；覆盖Open取消、原生确认取消、
批准恢复A、真实drain/守护继任、四域UI读取与关闭后语义读回，以及再次普通冷启动。
场景P用合法三库与坏会话索引触发partial，先取消/批准重启并证明gate与原资源退出；继任者须是零Store恢复入口，
随后显式选择受控合成H备份，覆盖取消/批准、恢复健康图及普通冷启动，保留坏索引和旧动作事实。
H备份由生产管线生成时明确标作受控合成输入，不冒称健康产品UI备份。小工具纯测试不授R/P实际PASS。
继任身份监督、原生Open/确认动作及wrapper闭合schema另做差量；实际运行前冻结每场动作数、总期限和源码，
不沿用小空备份480/600秒预算容纳额外动作，不在执行中扩时。最终E2独审仍核完整候选及实际R/P证据。

### E2 恢复后继身份差量（2026-10-10）

沿用上述R/P与详细设计§4，不修改产品启动参数、内部IPC或guardian协议；工具只新增
`tools/data-qualification/product-restore-process/`中的有界观察器及纯反例，旧ProductTransfer十六来源保持。
原生批准前连续持有旧main/guardian及已捕获utility的精确句柄，固定外层ReleaseProfile Job成员/限额、
EXE与guardian制品、同实体profile和当前账本世代；R最多一次交接，P按partial→恢复入口→健康图最多两次。
每次只接纳一个新main：创建者必须是持有的旧guardian，创建时刻晚于旧main退出且在旧guardian生命周期内；
新guardian须为新main的精确子进程，参数中的main/root/nonce/空appRoot与同根新账本一致。
pid/FILETIME/映像/实际成员需用持有原生句柄复验；CIM仅补闭合参数与父系，不输出原始命令行。
账本image是文件身份摘要，不是制品SHA；profile的FileId128与legacy index是不同投影，须各自从同根核对。

接受后继前旧main/guardian及所有已持有utility必须signal，旧guardian及账本登记的数据writer须exit0；
Chromium服务也计预算并保留实际退出码，但其非零退出不等于数据writer协议失败。取消、未知signal、
guardian或登记writer非零/未知退出、第二后继、
同时两个活main、错父系/同PID异创建、换根/换账本/错nonce、迟到批准均拒绝，不据PID消失认定退出。
允许两个精确guardian在已批准交接内短暂重叠，总24进程原生门保持；不能要求转移期间成员集合静止。
不强求采到writers的null/null瞬时值；短命未捕获utility的退休，结合冻结guardian的不可跳过顺序
（原writer Job0、旧句柄signal、持久退休、关闭内部Job/锁后才启动后继）、精确旧guardian exit0、
唯一可信后继父系及新同根账本推断。组合证据缺任一项即失败；报告区别此推断与直接持有观测。
**观察器不得打开或跨交接保留内部DataWriters Job及owner.lock**，避免自身阻止新guardian取得同名对象。

常驻观察helper计入原tools≤4；只保留关键状态变化，单帧≤4KiB、最终回执≤64KiB、每交接最多512条/2MiB，
持有身份最多128个；触顶停止，不引入ETW/IOCP/通用跟踪。原生API、CIM、回执flush/close均扣原场景绝对余额，
不续租产品阶段；新main出现后的身份/UI可行性至多原boot60秒与场景剩余的较小值。
后继不带force-renderer-accessibility，按原UI30秒/512节点做一次实际观察；失败保留，不手动启动替代进程。
有意义的身份/并发/截止反例和新独审后，直接进入冻结R/P首个实际资格；不用额外通用合成矩阵代替R/P。
此工具不授Store健康或四域语义PASS，仍须真实UI、关闭后固定oracle及再次普通冷启动。

### E2 原生文件选择资格的共用边界（2026-10-10）

baseline同上。已失败的WM_SETTEXT、MSAA值设置和焦点候选及诊断保留在progress与原件；
这些旧路径不再是当前执行方案。当前候选只按下节Save/Open选择区编辑差量实施。

最终选择oracle为自有IFileDialog的OnFileOk内GetResult与成功Show后GetResult精确一致；
GetFileName与控件双读只作文本对照，不能代替Shell item。
依据：[GetFileName](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifiledialog-getfilename)、
[GetResult](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifiledialog-getresult)。
WinExe x64夹具在自己STA线程建立owner HWND、dialog与Advise cookie，全部COM/事件/Close/Unadvise同线程；
所有COM引用与CoTaskMem须释放，异常和取消也需结算。fixture终态缺席时只据Job0证明终止，COM正常释放保持unknown。
IOleWindow取得精确dialog HWND，外部helper按PID/creation/image/owner/#32770/唯一host及1001/Edit绑定，
拒绝只读、不可见、身份漂移和非唯一对象，不做桌面全局搜索。

每场UI共用原30秒，helper35秒仅收口；原始单调tick/frequency从fixture握手传到全部端口，
同步返回后与后继动作前仍复核，不据事后拒绝声称同步COM可以中断。
整轮120秒工作和30秒真实退出，复用已审FixedTransferJob的filename模式：进程≤4、commit单2GiB/树4GiB、
采样RSS单1GiB/树2GiB及100ms采样，两个退出事实共用原收口截止；原import/transfer模式不得受影响。
只允许自有fixture/helper及对应conhost，先入Job再执行并持有精确句柄，不启动产品/Chromium/Node/Provider。
单回执≤64KiB、总证据≤1MiB；源码/制品、调用次数、COM收口、闭合结果与实际Job0均须绑定。
回执按完整词法与固定键解析，拒绝转义字段名和重复键，不能在反序列化覆盖后才检查。
保留UI512节点、祖先8、后代16及文本4096 UTF-16门，不输出未知Name/Value/异常正文、完整目标字符串或桌面清单。

先覆盖文本与最终选择分歧、缺/重复事件、Show/Advise/Unadvise/释放失败、STA/重入、身份/类型/状态漂移、
越界路径/链接、来源漂移、未知Job和证据迟到。独审通过后由root串行实际；夹具通过不等于产品恢复通过，
仍须经真实产品原生选择、取消、确认、后继及四域语义验收。

### E2 原生Save/Open选择区编辑差量（2026-10-10）

实际focus-diagnostic已定位本次SetFocus抛错，旧WM_SETTEXT/MSAA未提交路径的内部原因仍unknown。
停止该焦点路线；新工具置于`tools/data-qualification/native-file-selection/`，不改变产品或旧十六来源。
同一精确Edit仅执行一次EM_SETSEL(0,-1)后一次EM_REPLACESEL（不保留Undo），使用SendMessageTimeout及原30秒剩额，
单次仍≤1秒。二者没有业务返回值，不能把消息结果0当失败，也不能把发送完成当最终选择成功。
第一次失败/迟到时不得第二次发送；替换后沿已有原生完整双读与身份核验，文本不全或拼接即停止，不补发。
无焦点、键盘、剪贴板、坐标、WM_COMMAND、修改标志或其它消息回退。
公开接口只证明编辑能力，最终Shell提交仍待实证：
[EM_SETSEL](https://learn.microsoft.com/en-us/windows/win32/controls/em-setsel)、
[EM_REPLACESEL](https://learn.microsoft.com/en-us/windows/win32/controls/em-replacesel)。

新scope最多两场新进程/新dialog，Save成功才进入Open，不重跑旧reference。
Save沿现有不存在的自有默认/目标路径及已审MSAA保存按钮；Open使用IFileOpenDialog、不同的自有默认目录与目标目录，
仅预建一个固定小aibak路径控制文件（≤4KiB，源码固定字节），持有身份并核前后摘要，明确不是有效恢复容器。
Open强制filesystem、file-must-exist、path-must-exist、no-recent并读回；Save强制FOS_NOTESTFILECREATE、DONTADDTORECENT与FORCEFILESYSTEM并读回，
不设置多选，不创建所选Save目标。Open按钮使用独立闭合名称/ID1/原生Button/MSAA角色及状态资格，不放宽旧Save白名单。
两场都要求恰好一次OnFileOk的GetResult与成功Show后GetResult为精确目标且一致；GetFileName只作对照。
错误/缺失事件/默认或其它路径/迟到/释放不明即停止，Save失败不得启动Open，更不能接产品R/P。

原STA/COM释放、精确PID与owner、UI512节点/祖先8/后代16/文本4096、每场30秒/helper35秒、
整轮120+30秒及filename模式4进程/内存/RSS/100ms门、单回执64KiB/总1MiB均保持。
构建只快照源码和编译，Run预检前独占claim；来源/快照/制品/目的精确绑定，失败scope不复用。
使用现成csc及原共享Job，不重装工具、不改其限额；小路径控制计入总量，未知路径/文本/异常正文不输出。
先覆盖两消息次数与迟到、只读/身份漂移、部分替换、文本正确但最终路径错误、Open文件替换、两场前置及释放反例；
新的独审后仅一次实际。通过后再把同一原语接入产品原生Save/Open及取消/确认/继任，不绕IPC或注入选择。
若此机制仍失败，保留结果并重新评估工程证据手段，不继续追加消息组合。

首次实际Save已证明一次事件和最终GetResult均精确目标；同轮Open在initial前预检失败、零写零动作，
现有原件无法区分UI结构、disabled、身份或读取异常。下一候选仅给已有helper的phase/failure补闭合分类，
字段、原过滤/授权门、消息、fixture与共享Job均保持；未知异常只记helper-unexpected，不输出异常正文。
阶段固定为preflight/runtime/handshake/binding/native-edit/native-button/initial-recheck/initial/select-replace/button/complete。
失败分类只描述运行宿主/范围与runtime、handshake/时钟、进程/dialog身份、树/host/edit边界、按钮资格、
绑定变化、初值/目标/读回/输入持有及原释放/期限。ID1且ClassButton的结构候选恰好一个时，
才区分句柄、PID、disabled、offscreen或固定名称不匹配；零个/多个仍为button-count，不用诊断放宽授权。
先以真实helper函数反例区分旧笼统结果，再独审并在新scope串行一次短Save→Open资格；保留同轮失败全貌。
旧Save可按明确范围复用，此处重复短Save只为保持既有两场入口和上游不变，不重跑产品或大矩阵。
本轮只关闭可诊断性缺口；Open仍须实际完整通过，缺fixture终态时COM释放仍unknown。

实际诊断若为host-count，不得把Save的UIA宿主结构强加给Open或放宽为任意Edit。
先以同一失败IFileOpenDialog配置做一次只读结构观测，purpose固定open-structure-observation，
新scope/一次claim，只运行Open；原selection-qualification的Save→Open顺序保持。
只记录ControlView扫描数、FileNameControlHost数量zero/one/many，以及原生Edit/ComboBox/ComboBoxEx32的闭合结构：
最多512个节点、16个候选、每个最多8层父链；class与controlId用固定枚举，未知归other，
仅附samePid/visible/enabled/isChildDialog/rootIsDialog/hasHwnd，不记录Name/Value/路径/原始HWND或PID。
每步核原期限和精确进程/dialog身份，回执≤64KiB、总产物≤1MiB，原30/35/120秒与Job门不变。
观测不写Edit、不调用按钮；仅由已拥有fixture的既有取消路径退出，须核取消终态、Unadvise/Release及Job0。
完成仍qualified=false/productRun=false；缺终态或身份/额度失败即整轮FAIL，保留投影但不授选择成功。
该观测只说明当前失败夹具的结构，生产Electron的Open配置差异另行核对；据结果制定严格等价定位并独审后才恢复选择资格。
[旧Open/Save控件约定](https://learn.microsoft.com/en-us/windows/win32/dlgbox/open-and-save-as-dialog-boxes)
不视为现代IFileDialog内部控件的稳定保证。

### E2 产品恢复原生确认接线差量（2026-10-10）

`tools/data-qualification/product-restore-ui/`承接真实R/P的固定UI动作，旧ProductTransfer与E1工具源码保持。
先实现与文件选择无关的恢复确认动作；Save/Open选择接线等待上述实际最小资格通过。
确认只接受产品源码的`restore`与`partial`两种固定正文、标题“确认恢复本地数据”，
及“恢复并重新启动”/“取消”两个精确动作。调用方不能传入任意正文、名称、脚本或消息。
沿原30秒UI/35秒helper收口、512节点与4096 UTF-16文本门；不输出未知UI名称或异常正文。
使用精确产品pid/FILETIME/映像与owner窗口，唯一原生#32770对话框、唯一同PID原生Button及实际控件ID；
控件ID是首次绑定时的正整数身份，之后必须保持，不根据任务对话框平台实现猜固定ID。
每次完整有界遍历核标题/正文/两个动作，动作前再次核同一UIA对象、HWND、owner、ID与原生进程句柄。
按钮复用已审严格类型MSAA读取：S_OK、ROLE_SYSTEM_PUSHBUTTON、可用可见、精确动作名、非空默认动作；
不限制系统本地化的默认动作动词，不使用E1旧工具的类型转换作为新资格。只调用一次CHILDID_SELF默认动作，
失败或迟到不补发；同步COM受外层helper监督，不能宣称可中断。
批准前由runner先arm已审后继观察器；helper完成并真实退出后，runner验证闭合动作原件再写既定批准投影。
取消不消费批准交接槽，也不授予后继。旧进程在批准动作后可正常退出，动作后不要求窗口继续存活；
仍核原动作期限、MSAA释放与helper退出，具体后继只由已审观察器接纳。
先建立错正文/目的、重复按钮、类型与状态漂移、迟到、重复动作及释放失败反例；新独审与R/P装配绑定后才实际使用。
本差量不增加产品权限，不替代R/P整场预算、包绑定、语义读回或最终E2审核。
产品文件选择另外使用窄适配器复用已验证Edit原生端口及同一两消息，不修改冻结的夹具helper。
Save保留默认文件名/stem资格；Open允许空或有界的稳定初值，两次完整读回一致后才替换，初值正文不落盘。
目标只来自本场journal下固定product-A.aibak或synthetic-H.aibak，保存要求不存在，打开持有已生成输入并核身份/摘要。
每次操作仍消费唯一动作，不重发；编辑后必须重新通过按钮完整enabled/visible/身份及MSAA门，
原UI剩額同时约束读、两消息和最终动作。该适配器的纯测试不替代前述最小Open实效资格或完整产品动作。

### E2 R/P 固定场景装配与总预算（2026-10-10）

新runner位于`tools/data-qualification/product-restore-campaign/`，外层入口固定为RestoreR/RestoreP。
既有ProductTransfer的动作工具、失败scope与原件保持；允许共享release-profile wrapper只为新增固定dispatch、
对应总预算和闭合验收schema做必要差量，须独审该影响面。旧入口不借新预算，也不把旧来源绑定追认为新wrapper证据。
共享JobProcess只增加接收原Stopwatch和绝对截止的新重载，既有调用保持原行为；Restore的准入、启动、callback、
轮询和最终退出判定均扣同一原钟。传入runner的preflightElapsedMs同时扣减整场与工具180秒，不在进程启动后重新计时。
闭合固定路径失败回执可使外层提前进入Job失败收口及30秒实际退出核验；该路径永远不授正常退出或成功。

R顺序固定为：安装小A→正常启动→UI备份A→普通关闭及writer退休→保留A四域并安装B→正常启动B→
Open取消→选择A后原生确认取消→再次选择A、先arm再批准→唯一守护后继→四域UI→普通关闭→
A整套语义及旧B回退副本oracle→无可访问性附加开关的普通冷启→四域UI→普通关闭→再次A oracle。
P顺序固定为：合法小A三库和固定坏会话index→partial启动→取消重启确认→先arm再批准partial→
持久gate/零Store恢复入口→Open取消→选择合成H后确认取消→再次选择H、先arm再批准→
唯一健康后继→H四域UI→普通关闭→H restored oracle及坏index保留→普通冷启→四域UI→普通关闭→再次H oracle。
H备份仍是生产管线生成的受控合成输入；不自动发送模型请求或导航真实站点，不用零调用单独证明不重放。

每场UI/确认helper最多32次，每次UI总30秒，35秒只供helper收口；读备份完成状态也保持30秒，
本场小A若超时则保留失败，不在运行中延长。R最多3个、P最多4个启动/继任资格窗口，各沿boot60秒，
首次UI取原UI30、boot剩额和场景余额的较小值；普通关闭最多3次各30秒。固定装配、绑定与离线语义总180秒，
不借产品阶段预算。R整场4410秒=两项产品操作3000+UI960+boot180+普通关闭90+工具180；
P整场2990秒=恢复1500+partial排水20+UI960+boot240+普通关闭90+工具180。
这些是保守相加的工程总上界，重叠时间不续期；各产品原1500秒/分阶段门、partial20与UI/boot更紧的门仍独立有效。
外层另30秒只确认实际退出，原Job24、commit/RSS、main≤1、guardian≤2仅精确批准交接、tools≤4保持。

正常关闭另由`product-restore-lifecycle/`的窄观察器持有精确main/guardian句柄，ready后runner才发Window.Close。
要求两个句柄signal且exit0、同根账本退休和外层Job无产品成员；不以PID消失代替退出，不打开内部Job或owner.lock。
继任仍使用已审product-restore-process。全部原Promise/helper exit+close保持所有权，失败交外层Job收口；
观察器不自行杀产品，不新增通用取证系统。原件单帧4KiB、每会话≤512条/2MiB、最终64KiB，身份≤128。
四域安装/移动只限已证明全部writer退出后的自有根，验证绝对路径、同根身份、闭合成员和≤16MiB每套预算；
旧集合移入同一受控证据目录保留，不覆盖、不清理失败或以新profile替代E5独立环境。
实际前冻结完整来源/包/工具/动作schema并交新的独立审核，首失败停止；源码接线或纯工具PASS不授R/P通过。
工具bundle沿现有发行Vite/Rollup的常量与tree-shaking规则构建，避免esbuild单文件变换保留资格静态依赖。
实际读入的编译源码全部绑定；被消除的资格模块只能进入精确、已审的构建输入名单，不能进入rendered运行模块。
最终输出及rendered图均拒绝qualification、Electron运行入口和未冻结依赖；不能用stub或漏记输入取得绿态。

## E3 — 崩溃、中断与可操作错误

实际故障补证使用窄 `tools/data-qualification/lifecycle-check/`：普通非smoke main/preload/renderer/IPC与guardian，
仅工具bootstrap隔离合成userData、启动两类固定loopback页面并从主进程触发真实 renderer crash/main uncaughtException。
固定三场：网页崩溃与重载及主UI两次自动恢复、main异常退出、冷重开数据核对。
第三次有界恢复选择的确定性预算分支复用新独立审核，发行包原生选择另补证，不能以模拟选择授实际原生通过。
每场原始时间钟，全部≤120s；main故障从注入起≤10s退出1，其它正常场exit0，均要求完整Job0及writer退休，
异常场只接受明确预置的exit1/exit-nonzero且其它原生门成立，不能把任意工具/进程失败解释成故障注入成功。
动作每步复核唯一主文档，原UI返回值与各Tab URL/ID/世代对应，持久数据只对新副本运行全表oracle，原件不生成sidecar。
本工具不提供产品测试IPC/启动flag，不替换产品业务服务、错误或崩溃处理；最多首轮可行性后一次正式场，失败保存并针对根因修复。
同场补诊断真实IPC：崩溃前预览cap在新文档中必须拒绝且零保存调用；恢复后使用仅存在于工具bootstrap的固定
save-dialog输入适配核取消零文件、批准后原生fs写入的字节/摘要与完整预览相同，并核网页/输入/Cookie/路径等合成canary缺席。
这个适配只证明选择返回后的产品导出链，发行包的实际原生保存仍另补，不由工具替代授实际文件选择PASS。

真实恢复 R002 暴露 Research 历史首次读取早于服务图准入的竞态：打开面板应重新读历史，
初次拒绝不得永久锁成空列表；IPC 异常映射固定中文状态，用户有显式刷新动作，迟到旧请求不得覆盖新结果。
此修复保持任务/数据/Provider 语义，无轮询业务重放，R002 原失败保留并由新绑定的完整恢复场验证。

当前最小实现合同：单网页崩溃同步失效 document generation/navigationSerial 和在途加载，保留该用户 Tab 与其它 Tab，
新增闭合 failure 投影区分 load-failed/renderer-gone；旧 finish-load 不得伪报 ready，新主文档导航才清除崩溃状态。
先甄别反例及受影响 TabManager/PageReader 回归；真实 Electron 与 UI 恢复另补，不能用纯事件模拟替代实际崩溃。
主 UI renderer 崩溃后保留同一窗口、BrowserController 和服务图，仅重载固定可信入口；同步退役旧 guard/订阅/确认、
中断该 UI 的在途 Conversation/preview，不 dispose 业务服务或重放动作。自动重载预算为原 60 秒窗口内最多两次，
达到预算或加载失败后显示固定原生恢复选择，最多一次明确手动重试，仍失败提供退出，不循环重装配。
主进程未捕获异常/未处理拒绝采用一次性 fail-closed：关闭准入，尝试正常排水和 guardian 退休，10 秒总截止后 exit1，
异常主进程不继续业务；guardian 继续负责退出写者/现场保全。错误只显示固定中文影响与重启建议。

实际主UI故障的源码复核发现 preload 一次握手 null 被永久缓存的缺陷；早期原件只有固定入口加载完成而bridge未恢复，
没有逐事件trace，native事件精确顺序仍unknown。保留全部 owner/mainFrame/entry/token 世代校验，
仅在可信文档 commit 后向本主UI发送无token/无payload的固定 UiDocumentReady 通知；preload先监听再初次Open，
初次null后只因该通知进行一次单飞重握手，通知本身不授权限，token仍由现有主进程入口逐次核验。
不轮询、不重放业务IPC；二次null/异常或10秒总握手截止均拒绝。通知先后顺序、并发、旧文档/非法文档、
二次失败与截止须甄别红绿及新独立安全复核，再以新绑定实际崩溃场证实恢复，不改判旧场PASS。

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

主UI恢复完成必须同时取得固定入口loadURL成功和当前可信文档授权RendererReady，二者共用原10秒总截止。
未Ready时到期进入既有有界选择，不以loadURL fulfilled单独标idle；此完成判据缺口先保留纯反例。
真实握手拒绝点先以一次窄观察区分，不猜测补重试：工具仅记录主UI导航/commit/crash/load，Open原handler结果
token/null布尔、当前frame/commitframe同一布尔、bridge类型/readyState及preload-error固定类别，最多128条；
不记录token/URL/正文，不改变handler返回值。
固定Electron43.7.7在crash重建后复用WebFrameMain，detached仍粘滞true；实际715dfa原件证明新文档URL/owner/currentframe
均正确却两次Open因该位拒绝。该平台位不再作为可恢复性/授权oracle；改以Electron事件的processId/frameId与当前
mainFrame的processId/routingId一致、frame.isDestroyed=false及精确sender/currentmainFrame核验，再保留固定入口
和当前guard token/世代。旧RFH、旧process、子frame、销毁frame、旧token及异常getter均拒绝，不能只删detached放行。
独审此替代API边界和Ready完成门后直接运行修复实际整场，不新增通用观察器或第三次字段诊断。

后继fa5ab6实际已通过两次UI恢复/网页重载/诊断逐字节导出，但main异常场exit0且writer未退休，整轮FAIL保留。
窄验证仅比较当前Electron的原生错误对话框未关闭与AbortSignal关闭后的退出码/Job0；不扩建通用采集器。
原生错误提示最多占9秒，为既有10秒异常退出总门留出原生销毁与guardian退休时间；不延长总截止或降低退出码/账本断言。
通知取消只关闭固定错误提示，不授权业务，不中断持久化排水；产品真实异常重开必须仍由完整四域oracle证明。
窄原生二例已证明finish后耗满提示10秒会触发guardian强退91，9秒取消可exit1；旧exit0具体分支仍unknown。
采用同步关门→排水并行有界提示→提示结束→guardian finish→异常exit1，使guardian grace只用于真正原生退出，
而不提前消耗在等待用户知晓上。MainFailureShutdown自行race九秒和AbortSignal，不依赖通知端一定响应；原10秒总门保留。
正常退出与故障退出共用guardian finish所有权：故障接管后普通退出链不得发送finish；每个await后复验接管状态。
若故障发生时finish已发出，实际runtime已closed，则不等待新的用户提示或旧ack，直接异常exit1由guardian退休写者，
不重置已有grace、不二次finish、不将异常退役称为正常退出。对应排水/cleanup/已发finish三个交错均须甄别验证。

## E4 — 性能基线与受控诊断

当前性能执行差量：新增窄 `tools/data-qualification/performance-check/`，复用普通产品构建和现有 FixedTransferJob；
不改刚完成 R/P 的工具，也不重建 ETW/通用采集器。先一次不超过10分钟可行性，动作或采样不能可信绑定即停并换现有锚点。
短基线固定7次冷进程启动（不清系统缓存）、30次新Tab、三类固定DOM各30次Snapshot、5000 Sources/10查询各3次、
本地兼容流服务10次首token及5次Research；记录全部样本、p50/p95/max与观察开销，不用本地服务证明外部Provider网络。
先测baseline，再用事先规定公式冻结候选回归门：各类p95不超过baseline×1.20+20ms；新Tab/Snapshot/search最大5s、
启动最大30s、本地首token最大10s、Research最大60s为绝对停止保护。实际外部Provider凭据不可用则独立记NOT RUN。
启动ready点为普通进程启动至主renderer bridge可用且唯一初始Tab ready；7次同一隔离合成profile，不清OS缓存。
新Tab计真实IPC开始至目标WebContents ready，每次随后精确关闭，不用30并存Tab增加短基线负载。
三类DOM分别统计30次Snapshot及回归门；10个Source查询各3次合并30样本，同时保留各查询原值。
短baseline整场15分钟，完整业务首进程单Job至多10分钟，其余启动受30秒绝对门，首失败停止。
CPU以全appMetrics成员percentCPUUsage按真实间隔积分，报告Σ(percent/100×intervalMs)/wallMs平均逻辑核占用
及峰值聚合百分比；此负载没有已冻结CPU阈值，诚实记reported-no-threshold，不将此单项标为阈值PASS。
四域持久化比较单独核对生命周期审计：固定seed无审计，每个真实普通启动恰好一条reconciliation/complete，
闭合五字段、UUID/去重、ISO时刻及原生创建时间到创建时间加监督Duration的保守时窗包络；
RootStartedElapsedMs须≤1000ms且保留，记录为包络可能多包含的误差上界，不声称精确exit时刻。
短基线/候选共七条，长场/可行性一条。
短基线首实际失败在本地Provider DPAPI准备；产品使用同一profile却报告解密失败，工具setup曾在写入后直接app.exit。
将该合成准备进程改为关闭夹具server后app.quit，允许Electron正常收口profile加密状态；不改产品凭据或Provider授权机制。
原失败与hasKey/实际请求授权断言保留，新的完整七进程基线须证明真实跨进程可解密并完成原25次以上有界本地请求；
单纯源码顺序测试或准备进程退出不能授基线PASS，不重五分钟负载或重复失败scope。
不忽略审计表，不允许额外/缺失/改写行；其余27表及会话仍精确比较。旧错误地要求零新增审计的实际FAIL保留。
长时仅一次正式至少2小时：10用户Tab，固定三类合成页；每60s激活/快照、每10min导航、每15min仅关闭/重建一个精确Tab。
10s一次 app.getAppMetrics 全成员资源采样，固定最多721个时点（最终不足一个间隔额外一时点可单列），采样自身100次成本，
外层仍24进程、commit单/树2/4GiB、100ms RSS单/树1/2GiB，整场截止125min另30s仅确认Job实际0。
初始10min暖机不参加增长计算；该多Tab负载按实际稳定进程数分别计算RSS/private增长≤24MiB/h、handle≤60/h，
不得借用Watch负载的10/11分组，也不得用跨组整体回归抵消某组增长。正式长测前的新可行性场确定主体与过渡组，
每一组和全部原始点均保留；样本或时间跨度不足的组不能声称OLS证明。
稀疏过渡采用明确有界判据：每段最多两个连续10秒点、跨度≤20秒，前后须返回同一已评估稳定拓扑，
每个原始点仍满足原单/树RSS和commit绝对门；首尾缺双侧锚点、持续换组或超界均判缺证/失败。
稳定组各自原OLS增长继续约束过渡后遗留的资源，不能仅凭稀疏总数≤36授PASS；瞬态不声明独立长期增长已测。
应用与原生Job的单调时钟以明确启动offset绑定，所有测量点必须落入实际存活工作窗口，退出后点不参加判定。
退出期原始点继续保留为清理观察，不参加工作窗增长/交互统计；最后工作点至实际工作结束≤10秒。
交互p95相对短基线公式不变且max≤5s，任何crash/跨Tab世代误用/持久数据损坏/身份未知立即失败并保留。
结束核对10个用户Tab归属、真实正常退出、writer账本退休、Job0及完整合成业务oracle；不只依据退出日志。
四域合成预期在启动前生成并固定；进程结束、writer退休后仅校验副本，不用启动后的现状作为自身预期，原件不产生SQLite sidecar。
Stage6 Watch正式固定负载长测只按未受影响来源复用，不用它替代此多Tab长时门；电池继续NOT RUN。

诊断集成差量：复用严格投影生成器作为唯一 JSON/摘要/64KiB oracle，主进程从可信内存状态生成不可变候选。
可信文档 token 绑定候选 owner，单调 sequence、5分钟TTL、全局单在途导出；IPC仅空preview及精确sequence/digest，
不接受路径/正文/采样字段。完整字段/实际JSON预览后以原生保存写同一候选，不重采样、不复制原日志、不自动上传。
对话框返回后及写前复验owner/TTL，旧文档零新写；已开始的真实写入须等待其完成并报告真实结果，不能假取消或丢失工作所有权。
窗口/文档失效使能力退役，正常退出/维护记录并排水导出；未测计数/耗时为null而不是伪造0。
增加独立闭合结构化日志入口，固定component/operation/errorCategory和有限数值/枚举context，进程内sessionId；
旧日志API与全部行长/轮转/保留门保持。字段污染、候选错绑、迟到/并发/取消/失败、实际预览=文件及隐私均为验证门。

先并行实现纯诊断核心：`src/main/diagnostics/diagnostic-projection.ts` 与共享闭合 DTO，候选固定包含
schemaVersion、application(version/buildId)、runtime(electron/node/chromium)、有限 feature 状态、
有限 errors 分类、counts 及 durationsMs；不读原始日志、Error、路径、URL、环境或正文。
精确键/普通对象/版本格式/Git SHA/有界数字校验后生成固定键序 JSON、UTF-8 bytes 和 SHA256，递归冻结。
计数上限 1,000,000，耗时上限 86,400,000ms，最终 JSON ≤64KiB；未测耗时和未采集计数明确 null，不填零。
污染字段、原型、超长、非有限数字及候选变更/不可变性反例先验证；本增量不授产品预览/导出或 E4 整体 PASS。

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

诊断TTL内部以单调deadline判定，expiresAt保留wall-time展示语义；墙钟回拨不能延长候选，
精确截止/对话框返回后过期均零新写，正常退出AST夹具须包括当前诊断排水及main故障全局而不删退出断言。

## E5 — 安装、手工升级及 Windows 验证

安装权限裁决（2026-10-10）：用户明确批准安装、升级、卸载需要管理员 UAC 的全机 MSI 模式，先做有界小样，不预授 PASS。
这替代下述历史 per-user/禁提权方案：普通用户 MSI 的 M6/P1 实测恢复了旧文件，却损坏安装注册并阻断正常卸载；
旧轮 5/6、新轮 3/6 及全部注册/缓存/文件失败原件保留，停止该路线，不私改 Windows Installer 注册或缓存。
新权限仅授安装器；应用仍以普通用户运行，userData/凭据/DPAPI 按用户隔离，不安装服务、自启、自动更新或安装后自动启动。
安装根固定在 ProgramFiles 下的 AIbrowse，不把普通用户可改写的任意目录作为管理员写入目标；用户无需选择安装路径。
小样使用 ProgramFiles 下随机独占中文/空格目录、独立 Product/Upgrade/快捷方式 identity，每包≤1MiB，最多6次、每次60秒。
依次证明首装、事务后 Type19 失败升级完整回滚、旧版独有文件占用拒绝/回滚、正常升级、运行拒绝和保全未知文件的卸载。
先最小编译/反例及独立权限和持久化审核，再给出具体 UAC 操作与判据；任一产品缺陷停止依赖场并换路。
全机组件归属以 Windows Installer machine context 的实际组件、注册根及缓存包为准；HKLM locator 只提供候选，不能授删除权限。
全机每文件组件用真实 File keypath，guard必须将 machine API 的实际组件文件路径与缓存 File→Component→Directory逐项精确比较。
快捷方式编写Advertise=yes、固定DISABLEADVTSHORTCUTS=1以由Installer生成普通快捷方式；不压制ICE43/57。
HKLM只保留组件自有的perProductCode固定InstallLocation伴随值；取消历史HKCU marker作为全机文件keypath的工程设计。
此裁决保持旧版可用、数据保留和卸载不越界承诺，改变安装权限及范围；独立 Windows NOT RUN 风险承接已批准的同机替代。
权限增量资格：builder 缓存的 makensis 实测3.04，官方3.11/3.12记录了PLUGINSDIR竞争和elevated临时目录安全修复，
故全机包装不继续使用3.04。精确改用官方 NSIS3.13 便携构建工具，来源/下载包及执行工具摘要纳入构建输入并独审；
不修改node_modules、不新增MSVC/SDK/应用运行依赖。最小MSI可先编译，管理员EXE只在固定工具来源资格成立后构建。
暂存必须为限制DACL的真实独占目录，拒绝可改写/reparse路径；嵌入MSI及固定命令不能由用户TEMP里的可替换文件劫持。
当前准入修订：MSI的/a管理映像入口在AdminExecuteSequence写入前固定Type19拒绝，不提供任意TARGETDIR管理员写入。
准入helper编译为无控制台winexe、不读写Console；固定界面/退出码解释拒绝，避免QuickEdit文本选择暂停同步安装。
全机首轮小样保留1/6审核器NULL-SID错误、2/6控制台选择导致60秒超时；Esc后同次Type19实际完整回滚证据只授功能路径，
不改判期限PASS。修复后允许一次新来源7调用：原6项完整小样与/a写前拒绝，每项60秒/每包≤1MiB；
旧5+3+2累计和全部原件保留，不重置预算。旧健康合成注册仅以一次原生正常卸载退出，保留未知文件，不私改注册/缓存。
发行入口仅builder dir加新受控MSI/NSIS3.13构建；旧builder NSIS目标关闭。EXE/MSI及完整installer-build输入绑定纳入来源记录。
全机新小样/a、首装及2.430秒真实Type19完整注册/缓存/文件回滚已取得证据；旧文件占用实际超时且释放锁后迟到升级成功，
不能授占用拒绝通过。安装/卸载准入必须对全部旧实际已注册文件核写入/删除占用，包含incoming之外的旧版独有文件；
只尝试兼容句柄、零内容/属性写入、立即拒绝、退出前全部释放，不把锁留给Installer自己等待。准入检查总预算10秒。
CheckInstall/CheckRemove在CostFinalize完成目录解析后、InstallValidate的平台占用检查前执行；
不能仅放在InstallInitialize前而让平台先等待。此调整不改变InstallInitialize之后的MajorUpgrade和回滚边界。
修复仅该占用检查后复用未变/a、事务编写与已绑定回滚；先真实只读lock反例，再最多4次/每次60秒补锁拒绝、成功升级、运行拒绝、
未知保全卸载，旧累计14+新≤4=≤18，另native002原生正常卸载≤1，总≤19；不重置旧7预算或全矩阵机械重跑。

以下 per-user 探索记录作为失败工程历史保留；与以上新裁决冲突时不再指导当前实现。

安装事务重新选择（2026-10-10）：自写两槽 helper 的独立实测已确认失败路径误删旧安装、
清理中断后无法恢复及本地清单被伪造后删除未知文件等缺陷；旧源码和失败原件保留为 REPAIR，停止接入发行包。
NSIS 保留中文安装界面、per-user 和内部 EXE 交付；文件归属、失败升级回滚、注册与卸载改由 Windows Installer 事务承担。
这替换失效的工程实现，用户仍获得同一名称/图标/快捷方式、手动升级、失败时旧程序可用及全部 userData 保留。
受控生成器只从通过包策略的 win-unpacked 生成正向 MSI File/Component；userData、凭据和数据库永不进入组件。
per-user组件与非advertised快捷方式使用稳定HKCU keypath，不能压制ICE38/43假装符合安装归属。
文件归属由当前用户Windows Installer实际组件注册及对应缓存包的闭合File→Component→Directory集合共同核验，
本地marker值不授删除权限；自定义安装根在注册卸载/升级时经原生AppSearch定位并由guard与实际注册根精确比较。
实际per-user安装没有预设HKCU Uninstall根，故改为MSI组件自有、固定per-ProductCode HKCU InstallLocation伴随值；
该值只提供CostFinalize前的目录候选，不能授归属。guard同时验证该值存在/字符串/与MsiGetProductInfoEx实际注册根相同，
缓存Registry表只接受每组件marker及恰好一个固定locator；缺失/伪造/CLI属性改写均关门，旧失败原件保留。
M5定位修复后允许一次新独占小MSI矩阵，最多6次/每次60秒/每包≤1MiB：首装、事务后Type19失败升级、
旧版独有文件占用失败升级、正常升级、locator篡改卸载拒绝、恢复locator后注册根卸载并携CLI异根。
记录旧轮5/6及失败根因，不重置累计请求；任一产品缺陷停止依赖场，保留原件并正常卸载合成注册，不强杀或改策略。
CLI改写INSTALLDIR不得使卸载或升级作用于另一目录；未知归属和缓存缺失关门，旧版独有文件占用的失败升级也必须实测回滚。
MajorUpgrade 在 InstallInitialize 后执行，禁止提权、重启、自动启动和 Restart Manager 强制关闭。
系统或用户策略禁用回滚时拒绝安装；自写 guard 只做只读准入，不删除、移动或提交文件，不以可改写本地清单授予删除权限。
准入核对绝对规范安装根、祖先/成员重解析点、当前运行实例及 Windows Installer 的实际已注册组件归属；
首次安装遇未知冲突拒绝写入，升级遇未知文件冲突/链接拒绝，卸载保留未知文件、非空目录与全部 userData。
固定现有打包器的 WiX/NSIS 工具来源及摘要，不增加 MSVC/SDK、不修改 node_modules；工具源码、项目与比较 oracle 纳入 tools/。
先最小编译，再独立审核持久化/路径/回滚风险，再运行批准的同机真实首装、手动升级、失败回滚、运行拒绝、
链接/未知文件、卸载及重装矩阵；仅配置、生成器测试或平台文档不能授真实门 PASS。
任何原件保全无法证明时停止该路径并重定工程方案，禁止用更宽权限或强杀让安装成功。

当前安装构建增量保留已有目录候选，并增加 NSIS x64、固定 internal 文件名、已批准的UAC全机MSI与固定ProgramFiles根、
应用普通用户运行、不含 elevate helper、不安装后自动运行；使用受控图标资产。替换 builder 默认可能强杀应用的运行检查，
运行实例/guardian 未退出或观察失败时退出安装/卸载，不调用 close/kill；数据保留提示采用中文。
构建源码与实际安装包须先验证，安装目录链接/未知文件归属、失败升级及卸载越界仍为验收反例，
配置就绪不表示这些门已通过；不在本机真实用户数据上试验破坏性路径。

- **依赖/范围**：E1–E4；NSIS、identity/version/icon/快捷方式、主进程路径/单实例/packaged通知及安装测试工具。
- **目标**：批准的全机 UAC 安装完成后，Windows 普通用户可运行；升级保留业务数据，卸载保留各用户 userData 且不删其它应用文件。
- **反例**：有空格/中文路径、同版本覆盖、真实旧版升级、程序占用/中断、未来库版本拒绝、
  取消安装、卸载后重装、不同Windows用户隔离；已知不支持的平台明确拒绝而非损坏数据。
- **验证**：用户 2026-10-10 明确批准同机替代：当前 Windows 账户中的受控 NSIS 首装、手动升级、卸载和重装，
  加实际安装包依赖、权限、内容与数据边界检查；安装运行不经开发工作区/Node/MSVC/SDK 启动入口。
  新安装→主路径→升级→崩溃恢复→卸载→重装验证数据/凭据边界与遗留文件归属。
  packaged通知的显示/点击路由/内容隐私必须实际检查，截图和日志仅合成内容。
  实际旧安装包仍有Stage6固定identityConfigured=false占位，Windows通道零attempt；此为产品接线缺陷，旧通知场不授PASS。
  修复为Windows发行启动固定AUMID实际setter成功状态、packaged/platform/supported资格，不虚构OS getter；配置失败保留应用内提醒。
  对native通知保留有界强引用至终态/清理，native show回调记录回执，默认正文与精确点击授权/持久化语义保持；真实OS显示不由回执推断。
  实际renderer红控已证明普通notification推送不能完成原生点击路由；改为仅用户主动原生click产生闭合activation（event/digest+内部UUID），普通提醒不自动切换视图。
  复核最小化主窗恢复、所选event不受列表过滤/前50项限制、目标缺失不串到其它项，以及晚到digest响应/维护/清理不能覆盖当前目标；不增加通用IPC或跨重启激活。
  当前性能场为非packaged，两版均not-packaged且不调用发行setter/不创建WindowsSink；冻结场期间仅新增未导入模块/测试及隔离补丁，
  待收口后应用既有冻结文件差量，再独核性能及备份恢复证据适用性，不冒称整份旧来源未变。修复后的最终安装版补一条真实活态通知路径。
  通知补证可使用仅绑定127.0.0.1的有界合成HTML服务器，通过正式UI建立显式Session授权与规则，
  固定A→B内容变化、正式UI立即运行产生真实Watch事件及产品通知，再由人工或用户授权的外部可见窗口操作核对路由与隐私。
  当前外部通知补证仅一条合成Session路径/20分钟，Windows目标toast之外的通知/桌面内容不采集；完成后正式UI暂停本次规则、自然退出与关闭夹具。
  连续两次无新增信息停止该路线，真实失败保持，不追加通用采集器或直接调用通知API代替产品事件。
  首轮两次OS观察均未开始（WinPS模块不可用、历史入口解析失败），保留NOTOBSERVED；允许一次前台pwsh7的历史卡片只读替代，
  Win+N最多一次、10秒内只定位唯一AIbrowse单卡，先核最近可调用单卡及≤24节点边界再读取文字；无卡、多卡或边界不明立即停止并关通知中心。
  不重发事件、不采集其它通知/全屏图。原进程已退出，历史卡片只覆盖实际显示和内容隐私；不得以冷态点击替代活进程路由验收。
  最终包活态路径复用上述10秒/唯一单卡/先证≤24节点边界再读Name的窄原语；旧toast的40秒与读Name在先分支退休，旧来源和失败原件保留。
  live-toast仅在当前绑定进程、可信应用文档、浏览视图及Windows shell/同一单卡动作前复验均成立后单次Invoke，再从应用真实详情核目标。
  同一卡须以首次和动作前非空、有界UIA RuntimeId逐项相等证明，shell身份、文案、节点数及矩形相等不能替代实体绑定；替换、无卡或边界不明均零Invoke停止，不重发事件。
  输入夹具源码纳入tools/Git，服务器最多存活15分钟、固定两份正文、不读凭据或业务库；它不能直接调用通知API或伪造事件。
  本次真实产品升级以当前Stage7源码0.1.0参考包到0.1.1内部候选执行，二者完整产品均实际安装运行；
  参考包来自本轮Stage7已保全源码快照，不是旧E1程序；版本字段只改变发行元数据，候选另含全量发现的预览取消文案及精确文件身份修复，
  该产品增量须单独验证并审核，不把此比较冒称E1旧程序迁移或两版产品源码逐字相同。
  历史schema/旧数据兼容另按E2独立迁移和真实R/P证据覆盖。小样19调用已结束，不重启该预算；
  产品矩阵独立最多6次MSI事务、每次180秒（首装、升级、运行卸载拒绝、正常卸载、重装、最终卸载），
  欢迎页人工取消使用NSIS默认退出码1（用户取消），不能误用2（脚本中止）；先保存实际wrapper退出事实，再核零MSI与完整安装状态恒等。
  首次工具误断言2的失败保留，实际退出码原未持久记录故保持unknown；后来只读状态复算虽恒等，不能回填为该场PASS。
  该场实际零MSI，修正后的新scope须保留此前失败关联和累计真实事务，不重置安装预算或改发行模板迎合错误测试。
  实际首装wrapper exit0且保守整段12.251s、75组件/注册/cache/shortcut检查完成；后续工具在WinPS5.1把top-level
  JSON数组包成单个Object[]，读取未知文件路径失败。此前已创建的三个哨兵与外部绑定、完整首装前后及失败原件全部保留，
  后来独立只读核对75owned+3unknown、组件/cache/快捷方式与ACL恒等，不能据此回填原工具整场PASS。
  停用该层mutation编排，不扩建承接能力或重放首装；直接以已保护且摘要固定的真实NSIS EXE、原生msiexec执行余下五事务，
  每次先独占记录claim（累计首装已用1/6）、输入/原生进程创建身份，保存实际退出/计时，并在前后用既有只读Snapshot与独立事实判定。
  NSIS须exit0且完整生存期≤180秒；该保守上界包含人工页面等待，未取得child精确退出时明确NOTOBSERVED，不能伪称已测。
  直接msiexec须固定ProductCode/命令、exit0（正常卸载）或1603（运行拒绝），每次≤180秒；不强杀超时现场或重试。
  普通运行/人工窗口、75组件与缓存/文件/两快捷方式、3未知文件/ACL/外部哨兵及业务数据前后oracle保持，来源和预算不放宽。
  普通权限的`direct-native-transaction.ps1`只提权已保护的原生二进制，不提权工作区脚本；每一步CreateNew并核此前退出/累计次序。
  原生场景使用首次为空且实体已核的合成profile；自然退出后`native-profile-snapshot.mjs`只复制三个无WAL/shm/journal数据库，
  以精确BigInt身份及起止摘要证明原件未变，SQLite仅打开副本，完整28表/完整性/外键及Source字段构成升级与恢复oracle。
  首次CopyFile平台UNKNOWN失败保持，新路径用既有≤16MiB有界读取后wx副本，不新增通用采集系统；空会话不伪称非空四域，非空四域由实际R/P覆盖。
  原生小备份由`native-backup-inspect.mjs`复用既有完整wire校验，≤16MiB且同一缓冲摘要/精确身份起止不变，
  只将固定三库帧以wx写入新的证据根，再复用上述28表副本oracle；不依赖备份字节等于原数据库，SQLite备份整理可改变物理布局。
  该入口仅准入本次三库存在/空会话场景，不使用测试接口写产品数据或假冒产品导入，非空四域仍由已审实际R/P覆盖。
  NSIS取消在进入MSI前验证，无事务调用；首实际缺陷停止依赖场，全部原件保留。
  不重建通用UI采集器：NSIS与发行包原生对话框可由用户按具体步骤操作，结果须同时绑定实际包摘要、
  MSI退出/注册组件/缓存/文件与快捷方式、普通用户进程身份，以及操作前后受控数据证据；用户口述不替代持久化oracle。
  `tools/build/product-msi-matrix.ps1`保留原失败，后续只复用已冻结Snapshot只读事实核对，固定ProgramFiles根；
  提权代码及输入先保护并复算同内容摘要，不执行可变工作区脚本，不强杀进程、不改注册缓存、不删除未知文件。
- **完成/停止**：全部同机替代证据成立后可按内部候选范围完成；独立干净 Windows 仍记 NOT RUN，
  其它 Windows 配置及机器范围开发依赖影响未实测的剩余兼容风险由用户明确接受，不写成独立环境 PASS。
  默认不改变系统默认浏览器、自启、服务或电源设置；不自动重启。

## E6 — 发布可复现性与新独立阶段验收

最终包承接差量：先落定受控工具/正式合同，完成逻辑候选提交；在同一洁净候选commit做两次完整来源起止绑定构建，
两次运行payload全75成员与ASAR仍须逐字一致，选定其中一份最终EXE/MSI后不悄然重建。文档收尾可后继提交，独审确认仅文档差量，不因此重建产品。
旧dirty实测包到新clean包的适用性另行独立核定，不伪称payloadEquivalent：备份恢复/诊断/持久化与安装机制行为图保持，main输出差量限定为可定位的
__BUILD_ID__字面量及上述经独审的Windows通知接线/生命周期修复；renderer输出仅允许对应主动activation接线、精确所选详情和晚到查询保护的差量，相关资源指纹/入口引用逐项归因。
preload源文件字节保持不变，但其捆绑的共享校验器输出可随闭合activation分支改变；方法、IPC通道和能力白名单保持，最终main/preload/renderer输出都须按实际差量核对，不以源文件未变声称preload产物未变。
通知旧证据不可复用为通过，须最终包新活态实证；仅通知变化不得声称整个旧payloadEquivalent。
其余ASAR/PE完整性资源变化须逐项归因，fuses/runtime/guardian不变；MSI新ProductCode/PackageCode、
稳定组件GUID、条件/CustomAction/序列、内嵌MSI与payload闭包另核。出现其它机制/行为差量即停止复用并重新确定受影响实测。
既有真实六次产品账本保持：ordinal1/2复用原首装/手动升级，3/4仍拒绝/卸载已安装旧candidate ProductCode；
5/6重装/卸载选定的最终clean包，仍累计6次/每次180秒。追加CreateNew补充manifest，绑定原manifest/旧失败、ordinal4实退出与完整退休状态、
最终commit/双clean结果、最终包sha/bytes与新ProductCode，固定受保护final-candidate.exe/msi输入；不改旧清单或旧candidate文件。
普通权限窄recorder仅支持ordinal5/6的这项补充承接，不执行任意脚本、profile改写或终止进程；新输入只在一次既有授权UAC下受保护复制，随后核ACL与哈希。
最终保护复制入口`tools/build/final-package-stage.ps1`只向该既有保护根排他创建final-candidate.exe/msi，先准备可审核的固定系统PowerShell内联代码和来源绑定；不提权执行可变工作区脚本或启动安装事务。
复制从已绑定普通文件的同一阻写读句柄验长度/摘要，输出flush后核完整bytes/hash和可信所有者/写ACL/无链接祖先；既有文件或失败场不覆盖、不清理或自动重放。
补充清单严格校验JSON boolean，并引用固定路径的双洁净构建与行为适用性独审机器报告及各自SHA；报告须明确PASS且交叉绑定同一commit、原清单及所选最终包身份。
报告、ordinal4回执及状态先以普通文件共享只读句柄核长度预算，再读取定长buffer并核EOF，同一份byte[]验摘要和解析，禁止先全量分配后验预算或验后重读替换。
ordinal6还绑定实际第5次claim/exit的摘要与身份；
这些输入绑定只防止工程证据错配，不能由声明或摘要替代独立审核及实际安装事实。
退休状态报告另以evidenceSha256绑定同scope固定ordinal4-retirement-evidence.json完整只读原件；窄recorder只复算该绑定，完整文件/注册/cache/shortcut/unknown与数据oracle由独审判读。
第5次实际核75组件/文件/cache/快捷方式/unknown ACL、普通权限启动、SourceA保留及诊断新BuildId；第6次核完整退休/未知文件和数据保留。
外部原生UI工具从所选制品清单显式接收预期EXE SHA，不将每轮产物摘要硬编码进工具再触发源码/BuildId循环；固定安装路径、PID/创建时间、窗口owner与可信文档/控件复验继续保持。
旧场次按当时原件和源码摘要解释，新工具资格或动作不得复用旧冻结proof；修改仅解除制品输入与工具源码的循环绑定，不放松实际应用身份核验。
旧原生Save/Open/恢复/诊断与升级据上述精确行为等价复用，不为纯BuildId变化重整轮119MB矩阵。安全桌面物理确认缺失时仍暂停这些事务。

最终运行安全复验保留真实安装/恢复的非空合成profile，不为旧工具的empty/marker/同包Product前置而移动、清理或重造归属。
最终选包重新运行包/fuse/ASAR/PE完整性/guardian及静态输出绑定；未变的凭据、IPC、导航等E1运行结论按精确差量复用。
专项入口`tools/release/final-runtime-security-check`复用既有字节变异与有界原子Job，只在排他副本进行main等价空白单字节篡改、移走ASAR加入带哨兵裸app两场；
各须6秒自然拒绝、精确root创建身份及实际Job0、canary零执行、原选包完整hash不变，合成profile同实体/三库冷bytes/hash不变。失败停止，不以强制退役授PASS。
正确包恶意env/debug参数正控与第5次最终安装版的普通启动合并取得，复验禁止端口/Node canary/数据根替换未生效和可信应用文档，再自然关闭并核guardian/子进程退休。
普通启动允许正常日志/Chromium状态/启动审计和既有notification_outbox排水；不承诺整个profile零字节变化，三库变化须用既有28表冷副本oracle归因并保持SourceA与已存事件，不清理制造相等。
工具不读取凭据，不设置产品测试接口，不把当前账户合成根称为独立环境；首次为空及实体身份原件与本场前后冷态事实是外层归属替代依据。

确定性 guardian 编译差量：相同源码的实际 R/P 构建产生不同 helper 摘要，旧 Framework csc 的时间戳/MVID
不能满足完整 payload 复现。改用现有 PowerShell 所带 Roslyn 的 deterministic 编译，不新增 MSVC/SDK/依赖安装；
Guardian.cs、WindowsApplication/x64、Release 优化及现有 Framework 4 引用目标保持。固定编译器程序集版本/摘要、
引用/源码/构建脚本摘要及选项进入构建清单；编译器不符即停止，不回退非确定性编译。
编译到独占新建临时文件，仅成功 Emit/flush/大小/hash核验后替换既有exe；语法失败保留旧exe及两份JSON逐字节不变，
失败临时文件保留，不能把旧manifest与被截断的新exe留成可用成功产物。
先在两个新输出根验证 exe/manifest 逐字节一致及错误编译 fail-closed，再用实际 E3 生命周期场验证新 helper
的准入、writer 退休、异常退出与 Job0，并独审受影响的构建和生命周期边界。旧二进制/失败保留；不排除 guardian 比较。

先建立最小来源清单与复现比较器，源码位于 `tools/release/build-provenance.ts`、`compare-payloads.ts`。
来源记录真实 Git SHA/dirty、version、lockfile 与两个构建配置摘要、精确工具链；dirty 可以形成工程证据，但不合格为最终候选。
复用已验证包策略后记录实际 ASAR 内全部逻辑文件的 bytes/hash、header/hash、EXE、外置 guardian、包清单/fuses/integrity
及安装器 bytes/hash。比较器拒绝闭合集合/版本/来源错配和缺失/未知/修改成员；不预先排除 guardian 二进制差异。
完整应用 payload 等价与 NSIS 安装器逐字节相等分开报告，不由其中一项推断另一项。
完整payload另绑定win-unpacked全部外层文件的路径/bytes/hash，包括Electron DLL、locale及icudtl；
不能将这些真实运行内容的变化归为MSI/NSIS封装元数据。来源清单验证全部文件与installer-build正向集合恒等。
WiX每轮只从复算固定归档后新建的独占解包根编译，不复用未校验的可变解包缓存。
安装器固定 `AIbrowse-${version}-win-x64-internal.exe`；workflow_dispatch 仅 contents:read、无 secrets/公开发布步骤，
固定 Node 24.18.0/lockfile、质量门、release 构建/包检查与内部 artifact。实际两次洁净构建与最终审计仍须运行。
CI的windows-2025默认PowerShell会变化（当前官方清单7.6.6），不能用它替代已冻结7.6.5/Roslyn输入。
该job仅下载官方PowerShell7.6.5便携zip，SHA256固定32eb8f6cdce08f86e987d625a2733e54ac3e289ae7e1621b14c0b5bcec2434ea，
校验后在RUNNER_TEMP独占目录解包并只修改本job PATH；不全局安装、不新增MSVC/SDK。guardian的程序集摘要门仍保留。
本机继续复用现成7.6.5，不为CI重复安装；实际CI未执行不写PASS，本机受控双洁净构建承担本次产物复现证据。
本机GitHub工具下载继续检查7890代理；官方GitHub-hosted job使用该宿主原生网络并记录，不要求并不存在的本机回环代理。
安装构建开始/结束固定作者源码和实际payload摘要，release副本独占创建并复算；EXE/MSI/工具与来源记录相互绑定，
不能以末尾源码摘要冒充构建前来源。CI只上传内部产物及清单，未执行的job保持NOT RUN。
目录打包复用 `npm ci` 已固定的 `node_modules/electron/dist`，不在打包阶段再次联网取同版Electron；
该工程替换针对真实GitHub直连下载超时，运行时仍固定43.7.7/x64，需核对本地version/实际PE、完整外层payload与fuses。
自定义本地dist模式保留官方示例default_app.asar及根目录version，正向包政策已真实拒绝该输出；
固定afterExtract转换复现electron-builder常规解包的同两项处理，仅接受新的release/win-unpacked及普通、非链接祖先，
示例须为普通单链接110862B文件且SHA256为0eb2491b0a9ac94790389d39c09dd5005c6c1f0665842943829bbd0193f6cc4f，
version须为普通单链接6B文件且内容精确为43.7.7；先完整核验二者再移除。其它成员继续按原白名单核验。
转换必须先于完整性清单生成；真实afterPack位置过晚已产生含示例的完整性清单并被原policy拒绝，该失败包保全。
转换源码纳入Git，并在两次洁净构建的完整源码起止摘要中绑定；失败产物留存，不从失败目录补删后冒充新构建。
本地运行时来自既有依赖，下载/缓存不是独立环境证据；CI仍由精确lockfile安装依赖，未执行保持NOT RUN。

- **依赖/范围**：E1–E5；CI与构建清单、签名接口、release notes、全安全红队、最终Stage Auditor。
- **目标**：version/tag/源码/lockfile/产物对应，公开发布只使用已确认渠道与权限；未签名内部版诚实标记。
- **验证**：最小CI权限、依赖/许可证和包内秘密检查、两次洁净构建比较应用payload，
  若签名/时间戳导致封装差异逐项解释，不能声称未证明的逐字节安装器复现；最终产物hash和来源可追溯。
  第一至六阶段主路径回归、threat-model红队、迁移/崩溃/性能/批准的同机安装替代逐项对照Seventh_stage Exit。
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
历史2026-10-04用户无独立Windows环境，当时E5硬门BLOCKED；2026-10-10用户明确批准E5同机替代及所述风险，
当前环境验收只按本文件E5批准合同。独立Windows实测仍NOT RUN，旧环境硬门不再阻止据完整替代证据完成Stage7。
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

## E2 本次差量实施合同（2026-10-04）

- **TASK / BASELINE**：E2；产品基线fabcb2111c005a2f493f02dd30110279bb4451e7，E1独审PASS并双远程同步；
  入口收尾提交54783cd。tools/data-qualification为本轮已有未提交准备源码，不覆盖或丢弃。
- **GOAL / NON-GOALS**：完成§4完整数据维护与恢复；先落实维护准入/真实排水并关闭剩余容量资格，
  再实现不可信容器读取和敌手SQLite验证。不新增后台服务、自动重放、独立环境冒充或任意路径/SQL能力。
- **CURRENT VERIFIED STATE**：实际utilityProcess七场景和5GiB流式I/O资格可按适用范围复用；
  drain修复后三轮反例证明现有stop/dispose不能保证真实静止，失败首轮与修复轮均保留。
  合法旧消息compact JSON为3145839字节，原1MiB候选无效；4MiB消息/64MiB会话/结构与元数据资格已完成，
  读前硬界限按详细设计§4.1冻结，不声称历史上界。后继采用分层预算，先在可信固定夹具实现正式纯语义扫描/迁移，
  再经实际Electron接线冻结完整时限/IPC/空间；外来容器读取仍不得提前开始。
  Watch历史v3经现有迁移后同版本schema定义漂移已确认，需历史白名单及staging规范化。
- **FIXED DECISIONS / INVARIANTS**：世代与排水接口按详细设计§4.2；同一同步段封闭新入口，再等所有原始工作，
  不把计数归零/Promise.race/已发终态当完成。保留原库、已确认数据和失败原件，所有三库同代切换。
- **SCOPE / PLAN**：并行Conversation/Agent/Research与Watch/Digest域维护；主协调负责入口屏障、Sources/preview/
  notification/导出接线、预算冻结和后续容器/恢复编排。同文件单写者，关键边界由新独立Reviewer复核。
- **TEST PLAN / ACCEPTANCE**：聚焦新接口红→绿、迟到入口/原Promise/持久化/Tab失败/错代和重复调用反例；
  受影响回归与实际接线资格后冻结剩余预算。继而执行E2正文规定的敌手容器/数据库、真实崩溃点重开和实际UI导出恢复，
  必要全量与dev/production检查、独立持久化/隐私PASS后提交E2完成状态。准备工具通过不能替代E2通过。
- **STOP / REPLAN**：任何未跟踪续体、不能证明数据同代、合法旧数据被裁切或容量/历史schema假设失效均先修合同；
  drain失败零快照/切换，不自动重跑或延长阈值。外部E5硬门缺失保持BLOCKED，继续独立实现。
- **FINAL EVIDENCE**：工具纳入tools/data-qualification，原件log/stage7-e2；正式预算与稳定接口写本设计/任务，
  当前状态写progress。独立报告绑定源码/历史schema/产物及实际运行，不新增长期状态文件。

### E2 数据转移退出排水差量

- 范围为 DataTransferService 的 ShutdownProducer 接口及其聚焦测试，主进程装配由主协调负责。
  保持现有数据、隐私与期限承诺，不增加自动恢复或强制关闭原生窗口。
- 先建立 picker/worker/显式恢复 pending、同步重入 shutdown、成功 handoff、未知 child exit 与
  maintenance pending 的红态；实现原 Promise 所有权、永久封门及真实退出复核，完成受影响回归和独立审核。
- 期限届满、取消回执、kill 请求均不得替代真实结束；不明退出或持久化失败保留原件与句柄。
  同步契约见 detailed-design §4.2.1；原件继续留在 log/stage7-e2，不重建长期事实源。

## 本轮交付检查

按各E任务和Seventh_stage逐项核对实际证据，必要独立审核PASS后逻辑提交、正常双远程同步。
Stage7只有在E6新独立Stage Auditor通过且全部硬门满足时才关闭。历史失败、电池NOT RUN及外部缺证如实保留。

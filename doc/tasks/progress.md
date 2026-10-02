# progress.md — 当前状态与下一任务

> 唯一进度源。历史放Git/原始证据；不再逐轮累积开发日记。风险编号不重排、不复用。

## 当前结论（2026-10-02）

第六阶段尚未完成。H1/H2/H3a已关闭，H3b没有正式长时资源结论，H4/D11未开始。
已从 `cc16bb57ce681e00d9d505060e20be9e49418d7e` 的干净工作区启动D10 **H3b-R实现**。
产品非暂停采样及独立构建目录已独审并提交 `5145164`；Windows Job采集器与独立报告器已实现，
首次真实Electron短验已正常完成并独立复算。电池采集、独立报告及正式运行入口已限定独审PASS，
启动前全量测试193文件3920项通过；尚未执行正式资源窗口。
停止旧012整合与classic ETW路线。
详见 `doc/stage6/acceptance-replan.md`、detailed-design §15.6/§15.7及D10。

主要根因是资源验收与自建完整Windows文件事件证明系统耦合，周期freeze、OS查询尾延迟和工具缺陷使测量无法开始。
不能因此判产品性能FAIL，也不能判PASS。保留Watch产品架构、固定负载及全部数值/隐私承诺，改为非暂停分项采样。
用户已明确允许完整开发期间使用当前Windows账户，并声明应用内不会产生个人数据；不再要求新建账户。
使用全新合成根、零Provider，既有DPAPI/harness凭据不读取。当前账户不是OS文件沙箱；CJS前路径隔离
尚未实证，独立报告必须保留该缺证，不把资源采样通过当隐私或H3b通过。

## Git、产物与证据基线

- 本轮实现接管HEAD：`cc16bb57ce681e00d9d505060e20be9e49418d7e`，工作区干净；产品后继提交`5145164`。
  上轮文档接管`d976ac5`的未提交收据已保存完整原文，最终工具候选SHA以Git为准。
- H3b资格产品候选 `43efffbc82ff11122230c2362d6484d5feb9b581` 仅获限定独审；RSS空默认namespace修复
  `ee61ceb9d60d89dd60f6186030d6890b019a94ee` 已独审；本轮产品后继`5145164`已限定独审，均尚未推送。
- 双远程上次已核验同步于H3a收尾 `bcd38eeba5b81d055ad319aded9a748b6969c861`；本轮不做网络写入，
  不因文档REPLAN审核通过就推送未验收的完整H3b候选历史。下次网络操作仍核真实状态，不假设远程未变。
- H4完整审查起点固定 `d85667c54a354d322b0180d4c17873860a86c611`，不能排除首个D10大型实现。
- normal和三种qualification均已构建并分目录输出，必需addon在各自目录；旧out保存于
  `log/h3br-product-build-before/out/`。旧log候选不自动激活。
- 原progress完整4124行保存 `log/replan-20261002/progress-before.md`，SHA256
  `f79e502f68349532527888789328845fe7cb826d40fc4860a239320e5cf2fdad`；已提交历史也可从 `d976ac5` 读取。
  这是只读历史快照，不是第二进度源；含原未提交收据，原始失败日志均未删改。

## 阶段状态

| 范围         | 状态             | 证据/边界                                                                                                |
| ------------ | ---------------- | -------------------------------------------------------------------------------------------------------- |
| Stage1–5     | 已关闭           | 各Stage任务/设计和Git历史保留，本轮不重审全部历史                                                        |
| Stage6 D1–D9 | 已完成           | 已有独立安全/持久化/UI审核，变更涉及的部分按影响复验                                                     |
| H1           | 历史关闭         | 其旧验收工程方案已由本轮替换，不重做旧合同                                                               |
| H2           | PASS关闭         | `9e41bd6`，原47项保留+24项；99ms红态和单调计时修复保留                                                   |
| H3a          | PASS关闭         | `log/h3a-default-independent-current/h3a-convergence.md`；RSS累计20次，default dev/prod最终各3次完整通过 |
| H3b / H3b-R  | 未通过；短验完成 | 已取得真实资源及正常退出；正式长时、隐私、电池及DB业务总门仍须闭合                                       |
| H4           | 待开始           | 可做独立准备，H3b完成后授最终结论                                                                        |
| D11          | 待开始           | H4后新的独立Stage Auditor                                                                                |
| Stage7       | 未开始           | Stage6真GO后入口/风险/设计/任务准备，停在第一个产品实现前                                                |

## H3b-R当前实现与验证

- 真实短验 `VXW46AFHWAOCBAVLQHBNDPZB3U` 已自然exit0：5个OS点、4个CPU区间、240条连续main帧，
  固定index80..83四次Session初始化，Coordinator/task Tab峰4，Provider/HTTP/socket为0。
  CPU median/观测peak 0.031249%/1.728728%；RSS 617.085938/803.742188 MiB；private
  352.125/376.707031 MiB；handles 3865/4144。短窗不授正式阈值PASS/FAIL，句柄需正式窗确认。
  M1+10.0577291秒首次root0/Job0/三EOF/DB独占/WAL-SHM无/temp0，随后连续6点保持。
  原件及独立算术 `log/h3br-current/short-001-raw-independent-001.json`；采集JSONL、初报/复报全部保留。
- 首次measurement文件slot0为invalid，main短窗slot0缺失，均未填零/丢弃；不把短验当567负载或61点排水。
  采集期间一次只读进程/文件快照没有看到Electron及已写大小；最终原件证明该轮正常完成，未终止/重跑，
  不因此编造启动卡死根因。
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
  新增电池与总超时保护已完成风险复核，下一步执行正式窗口；用户已安排先接电完成资源验收，再补电池窗口。

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

H3b长时资源/电池/当前Windows兼容性和新隔离证据仍开放，不转移Stage7以获得Stage6 PASS。
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
这些不是当前已就绪的事实；本轮没有待处理UAC或新测量安排，不复用已经消费的就绪答复。

**任务结束后必须移除临时工具**：VS2022 Build Tools/MSVC x64/x86及Windows SDK26100的本任务新增部分。
按 `log/native-build-install/before-install.json`、`after-install.json`、`removal-inventory.json` 和
`native-build-restore.vsconfig`核对，官方安装器卸载，不改/删原有SDK/WPT/调试器/运行库，不自动重启。
当前仍安装，尚未移除；不能只删下载缓存声称完成。

## 下一唯一执行任务

完成新增电池/启动总超时保护/副本DB报告的受影响复核，记录正式候选与环境，执行完整固定负载及资源窗口。
短验已有有效数据，不重跑取绿、不继续扩展通用取证；若正式测量失败，按具体产品或工具原因修复，
不继续012、全机ETW、逐补丁UAC循环或另写通用证明框架。完整执行指令在 `doc/prompt.md`。

当前仍在实施，不是文档REPLAN停点。后续正式顺序为H3b → H4 → 新D11 → Stage7设计准备，
停在Stage7首个产品实现前。

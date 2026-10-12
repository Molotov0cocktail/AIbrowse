# 遗留问题修复与严格诊断（2026-10-12）

## 后继严格验证与根因诊断合同（2026-10-12）

- TASK / GOAL：用户新指令要求严格测试上一轮列出的剩余事项，确认是否成立并定位根因；本轮恢复有界诊断，替代上一轮停止状态。先验证与归因，不扩大为新产品功能或发布任务。
- BASELINE：`dedbfdcbdcea2723eb09c4f73c0f1b5810cbe9e8`，接管工作区干净；`output/` 仍旧 FIRST，源码候选与安装包分开取证。
- AUTHORITATIVE SOURCES / INVARIANTS：沿用本文修复合同及各 Stage 安全/数据/退出门；不得放宽阈值、吞掉未结 Promise、清空失败账本或用 Fake 冒充真实 Provider。不读取真实业务正文作测试，不改真实数据与选定包。
- EXPECTED SCOPE：退出挂起、Watch 新旧 locator 行为与历史数据边界、Research URL 候选/模型回传、Digest reasoning、资源增长/进程退休、旧 fatal；另外对发行身份、既有安全与设计限制、验证缺口逐项分类。通用诊断源码置于 `tools/legacy-diagnostics/`，原件置于 `log/legacy-diagnosis-20261012/`。
- IMPLEMENTATION PLAN：三个独立诊断方向并行准备；真实 Electron/资源场按运行槽串行，避免彼此污染。必要插桩只记录有界请求标识、实体/阶段/时间/状态，不记录真实 URL、正文、密钥或模型思考；资源工具可记录本场自有 loopback 合成定位符用于精确归属。正式设计不变量不变。
- TEST PLAN：已定位问题采用旧/新实现与正/负例；退出先最小生命周期对照，再视证据决定一次关联插桩默认场；资源先复算旧原件与观测可行性，再运行能区分负载/句柄类型的短场，禁止直接无差量重跑两小时。真实 Provider 首批不超过 8 次合成内容调用，先核安全凭据路径，再记录用途/计数/分类。
- ACCEPTANCE：每项结论标明已复现、代码/产物确定、尚未复现、设计限制或外部条件不足；根因须有机制证据及甄别对照，不能把相关性或一个成功场当因果证明。历史资料已清理的 unknown 继续保留，当前复现不能伪称恢复历史唯一原因。
- STOP / REPLAN：同路线两轮无新增证据即换路；需物理电池/另一台 Windows/外部登录权限的项目不伪造完成；缺少关键观测能力时明确剩余不确定性。不自动更新 output、发布或修改产品承诺。诊断报告和工具经过适用独立复核后本地保存，不把被测产品失败改判通过。
- FINAL EVIDENCE：由本节后续结论矩阵、Git 与原始结果承接；不新增第二套长期进度源。
- 环境裁决：用户本轮明确选择“只测当前电脑接电状态”，随后进一步明确无需断电或其它电脑测试，因为软件主要就在当前条件下运行。两项排除本轮验收范围、不作为当前使用场景的阻塞，也不冒称已实测或承诺跨环境覆盖；不再请求这些物理条件。
- 完整退出观察的工程修订：首关联场因观察器自身新增监听器碰撞既有监听计数 oracle，未形成完整产品场；保留这一工具 FAIL，允许且仅允许一次有甄别红→绿的观察器修正及补正场，仍用原 300s/退出观察 10s 预算。补正场任何结果均停止，不增加第三场，不放宽产品 listenerCount 断言。

### 本轮诊断结果

| 事项                       | 当前实证与归因边界                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Watch 页面归属             | `watch-counterfactual.config.ts` 在内存中将两个模块替换为旧 FIRST 对应 Git 源码，未改工作区；同一 33 项反例/正例旧版 19 FAIL / 14 PASS，当前版 33 PASS。证明只核 origin 的旧缺陷及当前修复区分力，不把模块对照称为旧 EXE 全场运行。日志 `boundaries/watch-historical.txt`、`watch-current.txt`。                                                                                                                                                                                |
| 包身份/签名                | 实际 `output/build-provenance.json` 仍绑定 `207cdde3cb05550679c612e6e3561aac7a2bf248`，EXE SHA256 与旧 FIRST 一致，签名实际 `NotSigned`；CI 文件实际存在。首次工具误读 manifest 顶层字段返回 null，后按 source.gitSha 读取的 `artifact-identity-002.json` 才是有效来源证据。                                                                                                                                                                                                    |
| 安全与数据边界             | 24 文件 442 项聚焦测试通过；真实合成 SourceService/SQLite 写入备注可在原字节读取，blocked 信源仍拒绝 agent 获取。保留/清理、会话容量与存储矩阵另 4 文件 151 项通过；只操作合成库。                                                                                                                                                                                                                                                                                              |
| 旧数据无法自动反推全部错配 | 新甄别测试证明两个 query 不同的页面 locator 不等，但脱敏 Projection URL 恒等；仅凭该投影不能恢复原 query。未读取或改写真实历史库。                                                                                                                                                                                                                                                                                                                                              |
| Research 目标网址无结果    | 离线实际 Runtime 在同一 URL 目标、Sources/Search 均空时 completed 且候选/捕获/证据均 0；加入明确 Source 后候选 1 并进入捕获。根因是目标文本 URL 不自动注册候选；第二场捕获端口为合成失败，只证明入口差异，不冒称采集成功。原提示修复不改变该产品能力。                                                                                                                                                                                                                          |
| IDN 表述收窄               | 三项输入对照确认无协议中文域名走搜索，完整 HTTPS 中文域名和 punycode 则可规范化导航；此前“完全不支持IDN”过宽。                                                                                                                                                                                                                                                                                                                                                                  |
| 引用的语义边界             | 同一合成段落“没有证据能证明产品安全”内的“产品安全”子串可通过存在性校验，凭空捏造的摘录被拒；证明来源存在性不等于上下文结论正确，不称其为已经越权执行。以上边界新增四项测试全通过。                                                                                                                                                                                                                                                                                              |
| 依赖告警                   | 当前 `npm audit` 全树 10 项（2 high/8 moderate），production 子树 0；本地 lock 链指向构建工具，实际 ASAR 中未找到相关包成员。三个公告为 GHSA-ch52-4w7c-c8xp、GHSA-68fv-2mgg-jv7q、GHSA-hp3w-g68c-fv3c；不将扫描告警当成用户运行包已被利用。                                                                                                                                                                                                                                     |
| 陈旧登记及文档             | 会话容量、UUID 路径守卫、测试单 worker 已有实现及适用回归，不再列当前未修 bug。README 中“全部 IDN 不支持”“没有 CI/打包配置”已按实际反例和文件纠正；本轮不证明远端 CI 运行结果，也不把配置存在当 CI 通过。                                                                                                                                                                                                                                                                       |
| 退出竞态                   | 两轮真实 Electron 最小矩阵可复现：快照 Electron API 调用开始后同 tick 或 setImmediate 关闭精确 Tab，API/controller/preview/drain 原 Promise 至观察结束仍 pending；正常、返回后关闭、导航控制结束。第二轮修正 loading-abort 夹具后确认取消在 API 调用前结束、0调用。根因收敛为销毁竞态下 API 原 Promise 未结算，而产品继续等待原操作。API 调用开始不证明 renderer 实际执行或底层 IPC 已派发。最后完整补正场自然 exit 0、未复现挂起；历史 d79 缺关联 ID，仍不能倒推其唯一触发者。 |
| 模型 reasoning 兼容嫌疑    | 合成离线 8 项通过；live-003 实际 6 次请求均 HTTP 200。Research 原始续轮省略 reasoning 与只补同源内存 reasoning 的控制均完成；完整旧工具历史省略 reasoning 与新问题控制均完成。当前已配置 Provider 没有复现这一兼容失败，不外推到其它模型或全部任务成功。                                                                                                                                                                                                                        |
| Digest 当前实际失败        | live-003 HTTP 200 后 failed/invalid-output；live-004 第 7 次请求进一步证明原始 JSON 合法、canonical/预算均满足，但根对象 7 字段且没有 sections。生产提示词未说明 sections/eventIds/explanation 输出 schema。第 8 次保留同一请求，只补 system 中完整 schema（其余逐 JSON 恒等），生产 Service succeeded/success，原始输出直接通过生产 validator。支持“输出协议未传达”的根因，不归咎 reasoning 或网络；一次控制成功不证明模型普遍成功率。累计 8 次实际请求，预算封顶。            |
| 当前短时资源场             | 唯一场 resource-run-70ad4d9be9cd466e9a499086bce9968b：636.684 秒、118 次快照/20 次周转、exit 0/Job 0、绑定不变。62 个类型点；静置前段 +215 句柄主要为 Thread +147/Event +68，快照段 +28、后静置 +21、周转 -235、末静置 +23。只定位类型和回落模式，不能外推小时率或认定泄漏根因。静置中 RSS 大幅下降而 private 小幅下降，不能当成持续单调分配。                                                                                                                                  |
| 新旧进程退出次序           | 本场 20 次旧 renderer 的真实 OS 退出均早于新 renderer 出生，间隔 2.9596–13.5307ms，实体寿命重叠 0；但 create 调用时旧进程可能仍存活。只证明本场没有实体并存，不保证 close 返回/新建 API 调用前已退休，也不替代任意时序保证。                                                                                                                                                                                                                                                    |
| 旧资源/fatal 原始材料      | 旧原采样已按用户历史清理授权删除，现仅能核对已保存独审复算/贡献，不声称重算原660点或关闭历史 60.9178/h 超限。旧 fatal 缺当时异常栈（产品 handler 丢弃异常参数），历史唯一根因仍不可恢复；新提前关闭 TypeError 与旧 fatal 分开，不能据新现象倒推旧原因。                                                                                                                                                                                                                         |

工具失败与污染边界：退出方向首次误用 `tsc -b` 在报错时生成了 1,797 个源码旁置 js/d.ts，
时间为本地 11:55:04–11:55:16。已按同名 TS 输入、Git 未跟踪、普通文件及精确时间清单逐个清理，
原 tracked preload 声明恢复到原字节；原件保留在 shutdown/accidental-emit-*。11:55:06 的 151 项
虽绿但处于污染窗口，不作最终依据；清理后的 11:58:49 同矩阵 151 项再次通过，最终四项边界测试
另有独立结果。此前 442 项及 Watch 对照在污染窗口之前，来源未受影响。

模型凭据准备两场零请求失败已定位为工具 sessionData 子目录造成 Electron 新建 Local State，
不是原密钥损坏；原配置、凭据密文与 Local State 摘要均未变。工具将两路径统一到隔离 profile 后，
live-003 真实请求 6 次、live-004 真实请求 2 次，两场进程 exit 0，原三文件摘要均未变。凭据、原始
stream、完整思考及完整 transcript 不落盘；通过生产校验的有界 explanation 按产品语义写入隔离
合成库，报告不回显正文。不得把准备失败计作 Provider 兼容失败。

资源准备首场因工具 appRoot 未含 guardian 路径而未进入负载；第二次启动资格又因工具在 React
初始 Tab 就绪前读取而失败，两者保留且不计为产品性能失败。修正私有完整 out 布局及有界就绪等待后，
第三次启动资格 6.60 秒通过：10 个合成 Tab、15 个实际 Job 进程，系统计数/快照均为 6,055 个句柄，
一次全树采集 124.22ms；产品与外层 exit 0、Job 归零、绑定不变。其后只执行一次有界资源负载，
不以短场替代历史两小时门。第二次提前关窗捕获的 TypeError 属新观察，不能冒称恢复旧 fatal。

观测适用边界：最小退出矩阵禁用 GPU 并人为控制关闭时序；旁置默认场保留原 Promise 身份和结果，
但同步日志、AsyncLocalStorage 与额外 then 会扰动时序，不能替代未插桩 production 退出门。资源类型
采集的快照/实时句柄复制不是原子事务，关闭及句柄值复用可造成 unresolved 或类型归属不确定；不能
用同句柄值证明跨采样同一内核对象，更不能把类型净增直接归因为具体代码泄漏。
资源原生监督器观测 37 个进程身份，类型工具保留 36 份 lifetime；短命启动成员不具备完整类型采样，
不能把 36 份记录称为全部实体类型覆盖。所有 Job 成员已归零另有监督器原生证据。

首完整关联场 `shutdown/full-54b06ab755d84ae58c18082875f7cf6f` 在 16.813 秒自然 exit 1/Job 0，
96 条观察操作均已结算。其失败是观察器新加的生命周期监听器使现有预览资格的 listenerCount 断言
失败，尚未到默认 Watch/退出尾部；不计为产品新缺陷、也不计完整退出通过。原三项观察器测试和
静态独审没有覆盖这一碰撞，保留该验证缺口；补正须新增监听计数/emit 语义的反例，不改产品 oracle。

该反例红态 1 FAIL/3 PASS；工具改为不加 listener 的 emit 观察，保持 this/参数/boolean 返回/异常后
4/4 PASS，定点检查和独立差量复核通过。唯一补正场 `full-283436f89b184c39a7e0a99d67b5b236`
107.864 秒自然 exit 0/Job 0，未触发观察窗强制停止，功能 marker 全通过、writer main/utility 均 null。
5,683 事件含 2,165 begin/2,165 settled，331 preview、630 API、100 close，最终 pending=[]；两次
关闭调用时仍 pending 的 API 均在各自 destroyed 前 fulfilled。结论是本场未复现，不是竞态已修复；
无第三场，无新产品源码差量，也不以插桩场替代未插桩生产候选的发行验收。

### 验证收口与当前未解决项

- 本轮 24 文件/442 项聚焦回归通过，存储/保留/会话矩阵 4 文件/151 项在清除误 emit 污染后通过；
  Watch 33 项对照、最终 4 项边界测试与上述矩阵存在子集，不重复相加。模型专项离线 8 项和分类器
  3 项通过；观察器最终 4 项通过，所有甄别红态和工具失败保留。
- 最终全局 `npm run typecheck`、全部诊断工具及配置 ESLint、工具 Prettier 检查均 exit 0；原件
  `log/legacy-diagnosis-20261012/final-quality/`。未改产品、不新增依赖，无须重复未受影响全量构建。
- 原始报告分别为 `shutdown/report.md`、`resources/report.md`、`models/report.md`；独立复核为
  `independent-review.md`，均位于 `log/legacy-diagnosis-20261012/`，只保存在本地，不纳入 Git。
- 独立 Reviewer 最终对诊断准确性、工具边界及文档给出限定 PASS，报告 SHA256
  `df40e33df4c95334757b984539d0643dc7ab1f9dcb9218d7e5cc3a55af5600f3`；明确保留首完整场工具失败
  及静态漏审，不授产品或发行 PASS。尝试创建新线程遇系统数量上限，复用未参与本轮工具实现的
  独立审核者；这不是新的 Stage 最终审核。文档格式及 Git diff 检查最终通过，产品/依赖零差量，
  output EXE 与 provenance 摘要仍分别为旧 FIRST 的 `373f81…` / `b587dc…`。
- 当前仍需产品修复的是在途快照关闭/退出竞态及 Digest 输出协议未传达；旧长时资源超门的分配根因、
  旧 d79 精确触发者与旧 fatal 原因保持 unknown。已定位到模块的机制不冒称恢复全部历史根因。
- Research 网址候选入口、本地明文与引用语义能力边界保持；当前 Provider reasoning 兼容失败未复现。
  output 旧 FIRST 未替换，旧错误 Baseline/Event 未自动修复。无真实业务数据修改、无产品修复提交或推送；
  仅保存通用诊断源码和上述文档纠错。本轮测试已停止，不继续追加运行、不启动 Stage8。

## 上轮修复合同（历史）

- TASK / GOAL：响应用户“请尝试修复所有的遗留问题，若难以修复则停下来汇报”，先核对当前实际遗留，再修复可明确定位的缺陷；遇到困难或产品取舍即停止并报告，不无界扩充验证。
- BASELINE：`main / 9083172b0d0848e62a78c4b7c03c697a81470572`，接管工作区干净。该版本已含 UI 深浅主题；`output/` 仍为旧 FIRST，二者身份分开。
- AUTHORITATIVE SOURCES：用户本次授权、`AGENTS.md`、Stage6 页面 locator / Digest 契约、Stage5 Research 候选与输出契约、`doc/stage7/tasks.md` 阶段后扩展回归节和 `doc/stage7/threat-model.md` §8。
- CURRENT VERIFIED STATE：Session 预览同源跨页面 Baseline 的 P1 已有实际场景与源码证据；Watch reasoning 拒绝为静态兼容风险；Research 目标文本 URL 不自动成为候选，曾出现零证据任务完成；长时句柄超限等已有用户接受风险，根因未证。不能把所有历史 FAIL/NOT RUN 都当成未修复缺陷。
- NON-GOALS：不启动 Stage8，不新增任意 URL/网络/SQL/模型权限，不改隐私承诺，不删除历史错误事件或真实数据，不重放不受影响的全套安装、性能或真实网站矩阵。
- FIXED DECISIONS / INVARIANTS：Session 预览、表格发现与正式采集须核对完整 canonical 页面定位（path 与有效 query，允许 fragment/默认端口规范化）；拒绝不能产生可消费预览、授权或 Baseline。保留默认拒绝、task-owned Tab、正文与 query 不额外落盘。AI 解释不能改写确定性事实。
- EXPECTED SCOPE：先并行调查 Watch 预览/命令、Digest Provider 流处理、Research 来源提示及已接受风险；实现限于确认根因的受影响模块和反例测试。必要设计差量由根协调维护，写者文件边界明确。
- IMPLEMENTATION PLAN：核对当前代码与证据 → 冻结每项最小修复 → 可甄别红态 → 修复与聚焦回归 → 安全/隐私/持久化新独立审核 → 必要 build/真实 Electron 冒烟 → 汇报已修与保留项。
- TEST PLAN：错 path/query、读取中跳转、正确 URL 规范化、预览消费与 create/rebaseline；reasoning 与有效最终 JSON、非法工具输出、输出预算及零 reasoning 持久化；Research 入口与零证据提示。先聚焦、再相关模块回归与静态检查；真实 Provider 仅在有明确验证价值及安全凭据通道时有界使用，不能用 Fake 冒充。
- ACCEPTANCE：每个已修项都有可区分旧实现的证据及适用审核；未修/未证项及困难明确列出。产品代码、运行构建与安装包分别报告，不把源码通过称为旧包已修复。
- STOP OR REPLAN：单条路线连续两轮无新增证据、根因不能在有界检查中定位、需要产品取舍/用户数据不可逆处理/外部条件时停止修复并集中汇报。用户明确要求遇难停报，本轮不自动延长为新一轮性能取证或新平台兼容工程。
- 交付：当前授权允许制作和验证修复候选，替代历史“不得修改源码/重建候选”的本轮限制；保留旧 FIRST 与失败证据。仅在新候选适用验证通过且不存在本轮困难阻塞后更新选定 `output/`；不得将未知风险改判 PASS。

## 上轮修复核对与结果（历史）

| 项目                         | 核对结论与本轮边界                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Watch Session 归属 P1        | 根因是预览和表格发现只比较 origin；修复完整 locator 读前/后核对、实际读取摘要、授权与命令消费复验。只改 preview/command 及对应测试，不改数据库和 IPC。                                                                                                 |
| Digest reasoning 兼容        | 思考增量误判非法输出；直接丢弃并继续严格校验最终 JSON，保留 toolCalls、done 和正文预算拒绝。                                                                                                                                                           |
| Research 来源/零证据提示     | 已确认目标 URL 不是现有候选入口，零候选 completed 属于明确降级契约。补确定性入口与无证据提示，不把提示改进称为直接 URL 采集已实现。                                                                                                                    |
| Research 工具 reasoning 回传 | 当前正式决议要求完全丢弃；特定 Provider 兼容尚未真实证明。涉及有界内存回传与正式契约调整，不在已明确局部修复外继续扩展，保留未证项。                                                                                                                   |
| 长时句柄增长                 | 旧固定实体场 60.91778813409878/h，阈值 60/h；已读 `log/stage7-e4/actual-supplement-independent-review-001/report.md`，增长分散于 Utility/Browser/Tab/GPU，缺类型与分配归属。难以据此定位可修源码，按用户要求在局部修复验证后停止，不新增长测或放宽门。 |
| 旧错误 Baseline/Event        | 不读改真实用户库、不删除重算历史事件。query 脱敏后无法可靠识别所有旧错配；保持已知规则暂停，须正确目标的显式重新预览/建基线。不会声称代码修复已纠正旧数据。                                                                                            |
| P2-3 / P2-4 / O-1 陈旧登记   | 当前代码已有消息/会话字节预算、单 worker、UUID 路径校验及反例测试；按实核关闭陈旧开放登记，非本轮新增修复。                                                                                                                                            |
| 其它范围限制                 | 电池/独立 Windows/CI 未证、旧 fatal 根因 unknown、严格进程退出顺序未证和跨 run reasoning 不持久化继续如实保留；不是新发现且可通过局部代码修复的缺陷。                                                                                                  |

## 上轮修复验证证据（历史）

- 原始日志统一保留 `log/legacy-repair-20261012/`；仅通用源码、反例测试、正式合同纳入 Git。
- Research 提示红态 4 FAIL / 26 PASS；修复后两文件 30/30，研究 renderer 六文件 74/74。正文前无证据提醒与正例、运行中/失败/取消不误报都有明确断言。
- Digest reasoning 有效 JSON 混合红态失败，修复后单文件 50/50；新增正文前/中/后 reasoning、数据库/WAL 零 canary、非法工具、done 后迟到事件、UTF-8 正文预算反例。真实 Provider 尚未调用。
- Watch P1 红态 19 FAIL / 14 PASS；修复后两文件 33/33，八个相关文件 143/143。首次 typecheck 因新测试 intervalMinutes 推宽为 number 失败，夹具改为字面量后全局 typecheck-002 exit 0；原失败保留，不改产品类型约束。
- 受影响 Watch、Research、renderer 与 Provider 集成回归：119 文件 / 2,378 项通过，exit 0，`affected-regression.txt`。全量 lint / format exit 0；新增 smoke 夹具后定点 lint、格式和全局 typecheck 另行 exit 0。普通 `npm run build` exit 0，`build.txt`。
- 新独立 `gpt-6-astra/xhigh` 安全/隐私/持久化 Reviewer 给出三项局部修复 PASS，实际模型未回显，身份不可验证；独立复跑 15 文件 / 267 项通过。`independent-review.md` SHA256 `563cacdeaf1b6df2966854437fddea1b0244dde0768eb8b965bbf63c6d00fb46`；后继 smoke 等价适配短审 PASS，`independent-smoke-addendum.md` SHA256 `3f1b90054b2fab4384688a2f060de676d49239a1e944576ad34d6461ced9baa1`。审核只覆盖本轮局部风险，不重开或冒称阶段最终验收。
- 默认 production Electron 冒烟首轮目录 `log/stage7-e2/default-smoke-production-d79c8b7dafce4e13ac6922776a4bbfac/`。03:37:37 Watch D9 场通过，03:37:41 全场 marker 与退出请求出现；03:37:46 仍有 `previewContext=1`、`conversation:preview=1`、main root / conversation producer 未排空。功能 marker 不是整轮通过；最终 outer exit 1、result/completion passed=false，整体 REPAIR。
- 原 600 秒总预算监督器在 wall 575315ms、work 575140ms 收口，应用分配预算 565391ms，报“固定验收超时；Job 已确认实际归零”。应用 exitCode=null，prepareJobZero=true、application jobZero=true；读回未启动，readbackJobZero=false 不代表已启动的读回进程泄漏。writer 账本仍有 main、utility=null，未满足退休条件；没有 production.readback.json。仅证明监督器回收了本场进程，不证明产品正常退出或冷态读回。零重试、零手工杀进程，未清计数或改旧 Promise。
- `result.json` SHA256 `d0b8895ae64317a382037a838b42094ba3a5d3f6e4deeb59aa6f3173ff461f63`；`completion.json` SHA256 `4b757113671961ec8da8fc11cff397b62de04bc1dd34ca671cba5d34c12020e7`；`production.result.json` SHA256 `38ab6bfb7d982f4a2008d84eff05b91646e479be41d3fba43a8377c839f71c65`。原始应用日志 SHA256 `13a3faa4336c8d49c27776beaf5cfacf21f5b949d4b569225512de44baeaff7b`，失败现场保留。
- 新独立退出补充审核判整轮 REPAIR，保留上述局部 PASS；`independent-exit-blocker-addendum.md` SHA256 `c1128efc29d5fe4a7eceb08e452124187051f35f0fbfc0a4e593d7e5685977b9`。本轮后继 44 场 UI 矩阵取消/NOT RUN；此前 UI 任务的通过不充作修复候选的新运行结果。

## 上轮遇难停止与未解决项（历史）

用户“难以修复则停下来汇报”的停止条件已触发：本轮真实集成退出存在未结预览操作，加上旧句柄
增长仍无分配归属。完成局部修复后停止新增产品实现与所有后继 UI/Provider/性能运行，保留首轮原件；
已启动监督器已在原预算内结束并确认其拥有的应用 Job 归零。当前不更新 `output/`、不 push 候选完成状态。

本轮退出的一次只读核查：Conversation 已将 AbortSignal 传递给 BrowserController/PageReader；
排空会中止预览 controller 并等待原 Promise，readiness 和 deferred blank 有取消结算。PageReader
已派发的 `executeJavaScriptInIsolatedWorld` 要等原 transport 返回后才再次检查 abort。由此可提出
“已派发快照传输未返回”的排查假设，但日志没有请求、tab 与执行阶段的关联，尚不能定位本次精确
await、归因 Electron 或证明与本轮夹具的因果；三处采集/会话模块本轮零差量。不能用清空计数或假
完成来取得退出通过。若后继继续，需要针对实际未结操作补充有界定位并证明原生传输退休；本轮不擅自启动。

局部修复的反例与独立 PASS 继续成立，不外推为整轮、旧数据、真实 Provider 或新发行包通过。
当前普通 `out/` 是修复候选；`output/` 旧 FIRST 未变，EXE SHA256 复核仍为
`373f81b386ea1cd439b6f1b1d350b3e9dbd05f173879200796cbf83998693aea`。

本地候选提交：Watch `178e4d6ad21f518a942ad987543e486c12ae27cb`、Digest
`cd6c9aeb3b34efeeeb8480f48585728da4f62fad`、Research
`19a4db950482b6a57a3fcab0413f69a1b4ebd8a0`。三项代码均为上述已测/已审差量，
提交仅保存候选，不改变整轮 REPAIR。未 push 任一远程，文档收尾提交以 Git 为准。

## 默认冒烟夹具等价修订

准备集成验证时只读发现旧 `src/main/smoke.ts` 的 8.26-E2E 向导将 Source 的 path 改为随机地址，
却仍读取原活动页；该旧成功场依赖本轮纠正的同源跨页面行为。产品校验不能为旧夹具放宽。
因此将本场改为独立 loopback 服务和精确拥有的 Tab：先在同源不同路径分别验证正文/表格预览
`security-rejected` 且 PreviewStore 不新增，再只导航本场 Tab 到正确目标，继续原七步真实
React/preload/IPC 成功链。集合比较前关闭专属 Tab 并恢复原活动 Tab，finally 幂等兜底并关闭服务。
原 Tab 集合/URL/标题/活动项、隐私、条件、确认与导出断言保留；新增真实错页拒绝覆盖，验证实质增强。
这是受影响测试夹具修订，不新增产品功能；只读发现后尚未运行旧夹具，不编造其运行失败。

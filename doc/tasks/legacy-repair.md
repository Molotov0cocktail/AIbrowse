# 遗留问题修复与严格诊断（2026-10-12）

## 统一设置、标题栏标签与浏览资料合同（2026-10-12）

- TASK / BASELINE：用户明确新增独立设置页、标题栏内标签、浏览历史和书签；接管
  `1a0597f52670be5e9ffcc38b3afd84c67cdddbd4`，工作区干净。该授权覆盖本轮基础浏览能力，
  不沿用 First Stage 的收藏非目标拒绝本次请求，也不启动其它 Stage8 能力。
- GOAL：本地数据、外观、AI 配置及低频诊断进入专门设置页；保留直接可达的 AI/信源/研究/监控。
  标签置于窗口顶部，采用 Electron hidden title bar + native Window Controls Overlay，原生三键、拖动、
  缩放和正常关闭链保留；控件不属于拖动区域。默认顶部仍最多两行，不另占原生品牌标题行。
- FIXED PRODUCT：用户明确历史一直本地保留至手动删除或清空，无 TTL 或隐藏条数淘汰。
  历史只记录普通 Tab 已提交的主框架 HTTP(S) 导航；Research/Watch/search 任务 Tab、子帧、空白及未提交失败不记。
  保留合法 query/fragment 供再次访问，拒绝 userinfo/危险协议；URL、标题、时间属于本机明文私密资料，
  不进日志/诊断/模型。书签独立于 Sources，可添加、搜索、修改、删除和打开，不自动成为 AI 信源。
- ENGINEERING：独立主进程 `browser/browser.db`，node:sqlite、编译期 migration/SQL、prepared 参数；
  稳定 keyset 分页，每页1–100、查询≤200字符、URL≤8192、标题≤1000；库无业务行数淘汰。
  renderer 仅消费有界 DTO，严格 IPC 与当前 UI 文档认证；模型工具集合不变。导航写入与标题更新也必须受维护准入，
  不能绕过排水/关闭。标题只更新精确访问 ID，清空后迟到更新不复活旧记录。
- SETTINGS：主题初始化和数据故障观察保持 App 常驻；设置页只负责显示/操作，不重复启动轮询。
  保存/恢复故障以紧凑全局提醒链接至设置，即使业务 Store 不可用仍有恢复入口。凭据依旧只写不读。
- BACKUP：新容器 v2 增加 browser 固定成员，并贯穿路径白名单、WAL/SHM/journal、startup-probe、
  schema/语义、维护、世代切换及回退。旧 v1 仅恢复原四成员，其不包含的现有浏览资料在同一排水静止点
  复制/核验后保留到新世代，事前 UI/原生确认明确说明；不静默清空、不拒绝旧有效备份。
  browser 备份输入包络512MiB、总容器仍5GiB；超过有界处理预算时明确失败、保留原库，绝不裁掉历史迁就预算。
  Guardian 票据仍属于写者进程，browser 句柄在 main writer 登记之后打开、退役之前关闭。
- PLAN / SCOPE：主协调维护合同、标题栏、导航回调和 IPC/装配；独立 worker 实现资料域及存储全链；
  renderer worker 实现设置和资料 UI；新独立 Astra/xhigh Reviewer 审持久化/隐私/并发及必要反例。
  调度实际型号未回显时如实记不可验证。版本候选0.1.5，适用验收通过后更新output并完整保留0.1.4。
- TEST / ACCEPTANCE：聚焦状态/数据反例、重启持久化、v2往返/v1兼容、维护/清除/退出竞态、IPC拒绝；
  typecheck/lint/format/build及受影响集成回归。真实 Electron 检查两主题三尺寸、窗口按钮/拖动、设置与网页互切、
  历史/书签完整用户路径、无 Store 恢复入口；不调用真实 Provider、不重开未变资源长测。
  包静态绑定、受影响验证、独审通过后本地可回退更新及双远程收尾；打包启动是否实测单独报告。
- STOP / REPLAN：相同路线两次无新增证据即换路；不得为新库跳过旧数据完整性门或降低原阈值。
  新数据/权限取舍先集中裁决，工程文件范围可按完整目标扩展，不重复审批已授权工作。
- DELIVERY ENGINEERING：旧output选择脚本把0.1.4版本、历史EPERM补验和固定测试数量写入代码；
  本轮改用`tools/browser-library-runtime/select-output.ps1`消费独立审核绑定的本轮证据清单。
  等价性是仍逐文件核验发行清单、干净源码HEAD、审核证据摘要，先完整复制校验再切换，
  保留旧output全部字节并提供失败回退；不以固定历史数量替代本轮功能/数据/退出验收。
  包启动是否实测继续独立记PASS或NOTRUN，同机本地选择不扩大到独立机器/公开发行承诺。
- WINDOW ORACLE REPLAN：原生输入首次未产生移动，补充精确 HWND/PID/DPI/前台校验后，Windows
  连续拒绝前台资格，未发送鼠标输入；停止相同物理输入路线并保留四场失败原件。
  本轮改以真实 Window Controls Overlay 几何、CSS drag/no-drag、原生窗口移动/最小化/最大化/恢复
  和正常 close→退出→重新启动验证承载与生命周期。物理拖动及三键点击明确 NOTRUN，不把 API 调用
  等同于鼠标交互；该限制随内部候选交付，不授独立机器窗口交互通过。

### 0.1.5 实现与当前证据

- 独立持久化/安全审核发现并关闭三项问题：无主库的孤立附属文件必须保留并拒绝打开；原生恢复确认
  明示历史/书签覆盖范围；SQLite NUL 截断不能绕过 ID/时间字节包络。最终117项独立断言PASS，
  见`log/browser-library-independent-review-20261012/review.json`及addendum；原红态保留。
- 首全量7020PASS/45FAIL/3SKIP原件保留；旧三库/四成员夹具已按新四库/五成员扩展原语义。
  未修改凭据预算测试一次rename EPERM的实际占用者unknown，独立原16项单次复验PASS；
  不用单次复验声称历史根因已知。新全量与包绑定结果在交付收尾补记。
- GUI最终`log/browser-settings-20261012/20261012T105058895Z-9cf1447b039748a5aec4c83c5255ed7a/result.json`
  为102场、0失败；真实资料操作/搜索/编辑/删除/清空与页面互切通过。两主题×三尺寸的六个浏览器基线
  检查WCO、顶部位置、drag/no-drag，默认chrome80px；不称102场都重复原生标题栏断言。
- runtime最终`log/browser-settings-20261012/runtime-684353e8-e945-4318-9cf0-7e3a494162bb/`两阶段
  write/reopen均passed/willQuit，真实访问/后退后3条历史与1条书签、URL/标题在完整退出后保留；
  清空历史不影响书签。API移动、最小化/恢复、最大化/还原状态与几何通过，物理输入NOTRUN。
  原01位移未改变、02子进程退出原因未知、03/04前台资格拒绝均保留，均未进入reopen；
  原工具固定phases=2不能解释成完成两阶段，最终已分planned/attempted/completed。
- 本轮真实Bing→bilibili`log/browser-ux-20261012/electron-fb391135-d73a-4a40-80dc-bf7eed15d032/result.json`
  一查询/一结果点击PASS，受控新Tab打开，Provider0。无需重复十款界面调研，沿用下节实际图像证据。
- typecheck/lint/format/build的`quality-final-02`均exit0。新output选择器作者37断言及独立6断言PASS，
  含两处真实子进程中断、回退幂等和损坏拒绝；真实output尚未切换。资料/UI/工具验证不等于打包启动。

## 浏览器空间与网页链接修复合同（2026-10-12）

- TASK / BASELINE：用户要求收紧常驻 UI、实际查看至少十款同类浏览器界面，并修复 Bing 搜索结果无法打开；
  基线 `e32ea88a942dc3766ae793f3985a760e3cda7aca`，接管工作区干净。
- GOAL / SCOPE：浏览器顶部收敛为标签与地址导航两行，默认快照调试区零占位，AI 入口保持直接可达；
  低频设置按需展开。普通网页链接、目标新标签及工作区返回浏览路径正常可用。
  范围为 renderer 浏览器布局、主窗口菜单、BrowserController/TabManager 导航与对应测试/工具。
- INVARIANTS：保留原生窗口控制、所有既有功能、本地数据恢复告警、L2 确认可达性及 WebContentsView bounds；
  远程页面无 preload/Node/系统能力。原生 window.open 仍拒绝，只允许受控路由合法普通链接；
  AI 交互不得旁路权限，Research/Watch 任务 Tab 不得产生未归属子 Tab。不得开放任意协议、下载或外部程序。
- PLAN / ORACLE：先记录原版真实 Electron 布局；浏览器调研记录来源与实际看见的界面；链接缺陷先红后绿。
  默认 renderer chrome 高度目标不超过 86 CSS px，底部默认零占位；两种主题及 1280×800、1100×760、
  800×600 受影响布局/边界/入口验证。导航采用真实 Electron 合成链接（同页、新页、后台页、危险协议及任务隔离），
  再对 Bing→bilibili 做一次有界在线复验，不把网站网络失败混同于链接分派失败。
- ACCEPTANCE：适用聚焦/全量、typecheck/lint/format/build、真实 UI/导航验证及新的独立安全审核；
  有效包重新构建与校验后按既有授权更新 output，保留旧包。原始证据留 log，不入 Git。
- STOP / REPLAN：同一路径连续两轮无新增证据则换方案；禁止降低安全边界或以描述冒充实际看图。
  不新增 Stage8 产品能力，不调用真实 Provider，不重开未受影响的资源长测和历史未知根因。

### 十款界面调研与布局依据

已在隔离 Electron 查看器显示公开参考图，并逐张查看实际渲染截图；成功索引为
`log/browser-ux-20261012/references-1791796545252/index.json`。这证明参考图的视觉检查，
不声称安装或交互测试了十个浏览器，也不把截图年代/裁切当成当前全部功能。查看器源码在
`tools/browser-ui-reference/`，Provider 0；失败原件及累计 32 个允许主文档请求、3 个拒绝附属请求保留。

| 产品与来源                                                                                    | 实际看见的布局及本次采用依据                                            |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [Chrome](https://www.google.com/chrome/)                                                      | 标签及窗口按钮一行、地址导航一行，无独立品牌横幅；采用紧凑两层。        |
| [Edge](https://www.microsoft.com/en-us/edge/features/vertical-tabs)                           | 左侧标签明确选中态，地址仍在顶部；保留清楚的标签身份，不新增宽侧栏。    |
| [Firefox](https://support.mozilla.org/en-US/kb/get-started-firefox-overview-main-features)    | 标签与地址两层、可选书签行、低频操作在右端；默认不再重复铺开低频功能。  |
| [Safari](https://www.apple.com/safari/)                                                       | 标签组与页面分层，选中态克制；工作区入口明确但不抢网页。                |
| [Opera](https://www.opera.com/features/opera-ai)                                              | 紧凑顶栏、窄工具轨道与右侧 AI 对话并置；AI 按需打开。                   |
| [Brave](https://support.brave.app/hc/en-us/articles/5181998802061-How-do-I-use-Brave-Sidebar) | 窄单列工具图标、网页保有主要面积；信源/研究/监控采用小入口。            |
| [Vivaldi](https://help.vivaldi.com/desktop-sr/panels-sr/panels/)                              | Workspace 与标签同排，面板通过窄图标栏开合；合并重复全局栏。            |
| [Arc](https://www.appsntips.com/home/arc-browser-review-top-features/)                        | 地址、快捷站点、标签、空间集中一侧；借鉴入口聚合，不照搬横向占位。      |
| [Zen](https://docs.zen-browser.app/user-manual/compact-mode)                                  | 侧栏集成地址与标签，具 Compact 菜单；辅助工具收起，核心导航仍固定可达。 |
| [Floorp](https://docs.floorp.app/docs/features/panel-sidebar/)                                | 顶部两层、右侧窄轨道及可关闭面板；关闭辅助内容后归还网页空间。          |

构建/安装工具链未改变；本轮候选更新采用当前 UI、导航、回归、静态包绑定及独审证据，复用未变封装与
运行时的既有同机证据。旧宿主 profile 路径重定向导致 packaged 启动未执行的事实继续 NOTRUN；
新换包 scope 只替换不相关的旧 Provider 场次检查，保留来源、完整新旧文件树、证据绑定和回退门。
本轮调度请求分别为导航 `gpt-6-astra/xhigh`、实现 `gpt-5.6-sol/high`、调研 `gpt-6-astra/high`。
两次新 Reviewer spawn 均被平台 thread limit 拒绝，因此由未参与产品实现的调研 Agent 独立审查候选代码；
既有 Agent 调度仍为 Astra/high，工具未回显 actual。其外部图像研究经历不替代安全代码核验。

全量回归实际 6970 PASS/1 FAIL/3 SKIP，唯一失败为未修改的会话中断测试发生 index rename EPERM；
原四个断言单独一次 4 PASS，既有 Windows 外部文件锁控制一次 1 PASS。业务产品与测试均未加重试或降低断言。
原场 `afterAll` 删除临时目录、未记录绝对路径，故真实占用者与历史唯一根因仍 unknown，不能声称已恢复现场。
组合 oracle 仅用原四断言补齐缺失的一项，6971 PASS/3 SKIP，另外三项旧 PASS 与既有锁对照不重复计数；
原全量 exit1 保留。新的 UI/键盘/工作区测试另列聚焦结果。此受影响范围证据复用须独审，不能自动判绿。

产品差量及组合证据已获独立 PASS，报告 `log/browser-ux-20261012/product-review.md`；191 独立测试通过。
TabBar 子按钮 Enter/Space 冒泡缺陷红 4 FAIL/2 PASS、修后 6 PASS；App 返回浏览器旧版 10 FAIL，修后 12 PASS。
最终 UI `log/ui-refresh-20261012/20261012T093349920Z-c7dd21f05e4d4252a7cb71c6ff6c19d8/` 的 78 场通过，
与当前 322 产品源码/5 构建产物摘要一致；1280×800 默认 chrome 217.33→79.67 CSS px，网页高度 582.67→720.33。
正常/新页/Ctrl 后台/无手势/危险协议/POST/任务/AI 八场加真实 Bing→bilibili 成功，摘要见本轮 `aggregate.json`；
iframe 物理输入未送达为 NOTRUN，两原场 exit1 保留。打包启动仍 NOTRUN，不将开发 Electron GUI 等同于包启动。

### 0.1.4 交付与闭合证据

- 产品修复提交 `4548933`；验收工具与干净包来源 `ed834c1d50fa01b58be24b03254b7d39dd7e4daa`。
  typecheck/lint/format/build、package:release-installer、verify:release、199 模块源码/ASAR 静态绑定、
  provenance、PE 比较及事实包装全部 exit0，原件位于 `log/browser-ux-20261012/`。
- output-switch 新 scope 最终 54 项合成检查 PASS；独审发现缺少必需 bounds 字段仍可接纳的工具缺陷，
  原红态保留，修后缺字段/总失败/77场/非 bool 可见性四反例准确拒绝。上一轮 54 项完成后的脚本收尾错误
  原件保留，修后完整一次复跑通过；真实 output/profile 未被合成夹具触碰。
- `product-review.md`、`tool-review.md`、`package-review.md` 分别冻结适用批准范围；最终独审
  `PASS_WITH_NOTRUN_PACKAGED_STARTUP` 绑定八项证明，不授 packaged startup 或 iframe 物理输入通过。
  `fact-wrap.json` 明确 Research 返回浏览依据组件测试，Watch 返回浏览与几何依据真实 Electron。
- 实际 CheckOnly/Switch 均 exit0，ID `cd3fc4a8e3664f37a4f8496074b4bfa2`，27 份证明切前重验；
  新 output 为 0.1.4、79 文件/619797056 字节，包含完整程序、EXE/MSI 安装器及构建身份。
  manifest SHA256 `7a99b1db64034a6bd1cd28dc8d8a74680688265b895cc0b4f061a880dc242021`。
  旧 0.1.3 的 79 文件完整保留在本轮 `previous-output-cd3fc4a8e3664f37a4f8496074b4bfa2`；
  `output-switch-cd3fc4a8e3664f37a4f8496074b4bfa2/result.json` 的 passed/originalBytesPreserved 均 true。
- 换包后独立 `output-final-review.md/json` PASS：新旧各 79 文件逐字节/摘要匹配，无额外成员或重解析点；
  27 份证明恒等（历史 previousManifest 按保留后的备份位置核验）、322 产品源码及已审执行器身份不变。
  此后仅两份收尾文档变化，不重建未变产品；本轮完成，不启动 Stage8。

## 新临时 DeepSeek 凭据严格实测合同（2026-10-12）

- TASK / BASELINE：用户明确授权新临时凭据、多场景严格实测和缺陷修复；基线
  `ae9ee07b009c7a82516560d40465407b93a608ba`，工作区干净。替代上一轮停止新增实现状态。
- GOAL / SCOPE：真实生产 Provider、ConversationService、AgentLoop/权限、ResearchRuntime/页面捕获、
  DigestService；优先关闭当前 Digest 与 Research 在线验证缺口。通用工具放 `tools/real-provider/`，
  隔离 profile 与合成业务证据放 `log/real-provider-20261012/`，不读取日常业务记录。
- INVARIANTS：key 仅由随机命名、单次挑战校验的本机管道进入测试进程，使用生产 DPAPI 存储与目标绑定；不进参数、源码、日志、
  报告或模型上下文。网络凭据只发往 `https://api.deepseek.com/chat/completions`，网页限定本轮 loopback。
  页面/Source/模型均保持不可信，权限和严格输出校验不放宽，reasoning 只在内存。
- TEST PLAN：首批总上限 28 次真实 HTTP 请求，单请求 60 秒、整场 15 分钟；先基本流式与 Watch 摘要，
  再共读/切页/多轮/取消/Agent 权限、两显式网址完整研究。每次请求先落用途/计数，结果仅分类和计数。
  DeepSeek 官方现文档模型名按当前接口核对；不照搬旧 profile 或旧已失效 key。修复复验须另列目的和预算，
  保留历史累计与失败，不能反复换提示取绿。
- ACCEPTANCE：HTTP 200 或进程 0 不单独算通过；流式终态、实际服务结果、数据引用/校验、工具审计、
  DOM 行为和任务 Tab 退休分别核验。实际生产模块验收与完整 UI/安装包验收分开报告。
- STOP / REPLAN：鉴权或余额失败立即停止依赖网络场景；两次同路线无新证据换路；模型未选工具记覆盖缺失。
  缺陷先甄别红态再修复，风险相称回归和必要新的独立审核；仅当前电脑接电，不重开旧资源长测或 Stage8。
  有产品修改则重新构建适用内部交付物并按既有本地更新授权收尾，未通过的包不得覆盖选定 output。
- 注入方法修订：两次零网络准备失败表明当前 Windows GUI Electron 未得到传入 stdin（第二次定位在 input）。
  保留原件，改用上述一次性管道；仅随机通道名/挑战在环境中，key 不进环境或磁盘明文，不改变产品能力。
- 首批实际 26 次请求：基本流式与 Digest 两项通过（2），Conversation/Agent 八场通过（14，含取消），
  Research（10）读取两候选并生成 11 Evidence/5 Claim/3 Conflict，但最终结果未完成；10 次工具预算拒绝后继
  两次 stream，原件保留。工具续轮及跨 run 均未复现 HTTP400，不凭官方文档推断本服务实际已失败。
  第二批仅 Research 诊断至多 16 次：相同目标/模型/生产校验，增加阶段和确定性拒绝理由分类，定位结果门；
  产品 24 轮上限不改。旧预算不足不是产品通过，新场保留所有输出失败且不得只因失败再反复调用。
- 第二批实际 15 次，累计 41：完整 Research 通过，但首次最终表格因非法字段拒绝，收到确定性反馈后恢复。
  已定位 synthesis system 未提供五种 block 的完整闭合结构；修复只补生产输出协议，不放宽校验。
  修复后最后一次研究复验至多 16 次；仅该 prompt 差量和校验器回归、全量集成与独审，不重放已通过共读矩阵。
  模型重试机制仍保留，不能保证所有模型输出首次合法。原先规划/选择提示复用的潜在矛盾记录为观察项，
  本场已正确选两目标，不凭静态风险声称当前已失败，不扩大本次产品修改。
- 最终真实研究11次首轮综合校验通过，累计52次后结束网络测试并清除临时凭据。随后新的独立审查
  发现旧cards条目只计字段数，缺subtitle可被未知字段替代。独立30项原态1FAIL/29PASS后最小收紧
  精确字段白名单及subtitle的null/string类型，其后以31项独立反例和相关验证/存储回归关闭。
  已保存真实结果可只读回投验证兼容，但原始模型输出零落盘，不能声称恢复原始输出或用离线投影冒充
  新校验器真实请求。换包证据须逐摘要绑定此唯一后继差量及新独审，不扩大为任意源码例外。

### 新凭据实测结果及本地交付证据合同

- 累计真实请求固定为52（2+10+14+15+11），不再调用该临时key。两个注入准备失败均为零网络，
  与Research预算失败、首次表格schema拒绝一并保留。共读八场中取消产生13个done和1个aborted；
  HTTP200、场景检查、终态、排水、进程exit0和credentialsDeleted须共同成立。
- Provider四项甄别修复、Research五种block协议和cards精确字段校验共六项问题已处理；
  独审发现cards反例后先保留1FAIL/29PASS，再追加显式undefined反例，最终相关3文件88PASS。
  只读回投最后真实Research已保存的规范化结果，1任务/1结果/4块/12Evidence/3Claim/2Conflict，
  所有9个结果字段恒等、数据库摘要不变；原始模型输出未保存也未重验。回投工具前两次因独立
  Conflict行按随机ID排序、与原Result顺序不同而失败，原件保留；最终按已保存Result的冲突ID
  恢复顺序，仍验证完整集合、逐字段和整体恒等，不删除冲突或放宽产品校验。
- 首次全量707.92秒，471文件PASS/1FAIL/1SKIP，6923PASS/1FAIL/3SKIP；唯一失败为
  recovery-transfer-runtime旧用例5秒超时。一次有界聚焦仍用原5秒限制，12/12PASS、原用例1227ms，
  无产品或测试修改；FS trace不足以定位历史等待点，根因unknown。最终产品校验差量之后执行
  一次必要全量决定当前状态，不能覆盖首次失败或宣称该超时已修复。
- 后继全量619.69秒，472文件PASS/1FAIL/1SKIP，6954PASS/1FAIL/3SKIP；唯一失败是旧会话上限
  用例第二次index替换返回EPERM，原恢复超时本场通过。既有测试afterAll删除了该场临时目录，
  只剩操作阶段/分类日志，不能恢复历史持锁者或断言其来自外部程序。产品原契约要求IO失败时
  保留旧数据、进入recovery-required并停止后续写入，这次已观察到停止写入，不能将IO拒绝本身
  混同于会话上限逻辑缺陷。先给测试添加透明的一次真实rename元数据与失败保留，再单次复验
  原文件60项及Windows禁止delete共享的受控锁反例；不加重试、不改变50会话断言或产品代码。
- 质量验收据此REPLAN为显式组合证据：若独审确认原60项与锁下完整性/停止写入反例通过，可复用
  当前全量其余472文件的未变通过结果，并补齐唯一失败文件，去重后6955PASS/3SKIP；不进行
  第三次无新增诊断的全量来挑绿。两次full命令均如实exit1，历史原因unknown，组合门必须另标
  full.exitCode=1且不得伪造test.exitCode=0，并绑定全量原件、唯一替代路径、仅留证插桩的差量、补验、锁对照与
  独审结论。等价依据是同一产品源码与全部原断言逐项覆盖，替换的是验收调度方式而不是正确性
  阈值；若原断言再失败、出现新产品差量或无法证明fail-stop/完整性，停止组合路线并重新定位。
- 实际诊断原60项全部通过，另1项真实锁反例通过，旧index恒等/tmp保留/锁释放后仍封存；
  锁工具补上自身就绪/退出期限后唯一补验通过，最后仅清理函数提取按独审等价范围复用，
  不冒称最终工具字节重跑或强制清理分支已验证。独审quality-composite-independent-review.md
  批准上述精确组合范围，历史两次失败与unknown继续保留；最终typecheck/lint/format/build全部0。
  质量v2结构中test没有伪造顶层exitCode0，分别记录full.exitCode1和replacement.exitCode0。
- 0.1.3仅沿用已审的当前电脑本地可回退更新路径：生产Provider/服务真实场景、独立反例、全局质量门，
  配合当前干净源码→bundle→ASAR绑定、完整成员摘要及新旧PE差量；沿用未变的封装/guardian/退出
  实证。原宿主profile隔离失败仍有效，PackageLaunch明确NOTRUN，不授新包实际启动、安装/升级、
  跨机器或长期资源验收。新旧封装差量超出版本、ASAR和其integrity即停止本路径并定位。
- 换包工具新增显式real-provider-20261012证据范围，默认旧门保持。要求新旧manifest、static binding、
  PE对比、Provider独审、五项质量门、三场真实测试各自result/binding/process、旧资格链、新包独审
  以及唯一validator后继补证逐摘要绑定；新的包来源必须与当前干净HEAD完全一致。补证只许可
  已审result-validator.ts精确before/after摘要，rawModelOutputRevalidated必须false，离线网络数为0。
  旧output完整保留后才切换；失败不覆盖用户当前选定版本，不删除旧运行证据。

### 新临时凭据实测交付结果

- 产品修复提交04cd9cc（Provider四项）和50a7f65（Research协议/卡片校验）；通用真实场景与
  留证工具bda1c1a。最终干净候选e16cf4664e1ea620ef96b6972b6ff2a4d7450335，版本0.1.3。
  换包工具43项实施与新独审均通过，质量v2和所有实际证明经新的独立审核逐摘要绑定，
  结论仅为PASS_WITH_NOTRUN_PACKAGED_STARTUP；详见本轮package-review.md及其JSON。
- package:release-installer、verify:release、源码/ASAR静态绑定、build-provenance和新旧PE对比均exit0。
  75载荷成员中73个逐字节相同；PE14非资源段及extra相同，54资源仅版本和ASAR integrity改变。
  新包candidateEligible=true；旧release完整80文件已归档，历史字节未覆盖。
- CheckOnly与Switch实际均exit0，切换ID534575150ef347da9f3c81540cbc802d。
  output现为0.1.3完整79文件/619787616字节，含程序、EXE/MSI安装器和构建身份文件。
  旧0.1.2全部79文件/619783005字节保留于本轮previous-output-534575150ef347da9f3c81540cbc802d，
  result.originalBytesPreserved=true。plan/result和343份切前复核证明索引保存在
  output-switch-534575150ef347da9f3c81540cbc802d，result SHA256
  fa4c77231e7189227aa5d9dae00d163568a0b2f4998605ba1845d3e296a82a05。
- 换包后新的独立只读复核再次核对新旧各79文件及全部343个绑定事实，PASS；旧output的manifest
  正确映射到完整backup，未实际运行Rollback或产品。报告output-switch-final-independent-review.md，
  机器结果output-switch-final-independent.json，SHA256
  82f98f9ac0c7370fe13dbdcb4ed73e66f8d23a451d351f171e8ddcdeeedb81a1。
- 当前manifest SHA256 b99ce0f588b7674c5ff76dd6e33cb0a336dc471083fbfe4fe65a8550aa468008；
  主程序SHA256 8439b2e15338bd6c700282d963fe7983058234f61280edf452e89a38e9f980d9。
  真实key调用已经结束且隔离凭据已删除。两次全量失败/历史unknown、原始模型输出未重验、
  包启动NOTRUN、旧资源增长及旧fatal unknown保持，未开始Stage8、公开发行或自动更新。

## 用户裁决后的产品修复与本地更新合同（2026-10-12）

- TASK / BASELINE：用户逐项授权修复退出快照、Digest 输出协议、Research 目标网址入口及无协议 IDN；
  baseline `829b7a164019af7e5825fce8cbbb34d199790c29`，接管工作区干净。
- GOAL / ACCEPTANCE：四项按实际行为通过甄别测试、相关回归、真实 Electron 与必要独立审核；
  修复完成后立即将完整程序、安装器和来源身份更新到本地 output，不再另询问已获授权的更新。
- FIXED DECISIONS：退出有在途快照时由可信主进程原生界面提供“停止快照并退出 / 继续等待”；
  未确认不得强制停止。批准只中断只读网页快照，仍等待业务操作结束、持久化资源和 guardian 正常退休，
  不用 app.exit 或伪造原生 Promise fulfilled 绕过数据库关闭。具体取消/实体退休手段按工程调查修订。
- INVARIANTS：不降低现有 JSON/引用/数据预算，不扩大网页/模型系统能力，不把目标网址写成永久信源，
  保持 URL 和 Source 分享/blocked 语义；用户文本不能改写系统提示。保留当前品牌深浅模式及旧 Watch
  页面归属修复，不改真实用户记录或删除旧错误事件。
- NON-GOALS：用户明确暂留资源增长；旧 fatal 历史原因保留 unknown，不新增长测或重开调查。
  仅当前电脑接电，不测断电或其它电脑，不启动 Stage8，不公开发布或自动更新。
- IMPLEMENTATION：Digest/IDN 与 Research 独立文件边界并行，主协调实现退出并管理版本/打包。
  先更新受影响正式设计；行为反例红→绿；原始记录存 log/legacy-followup-20261012，通用工具受控。
- VERIFICATION：相关单元/集成、全局 typecheck/lint/format/build；退出等待/拒绝/批准及迟到结果、
  安全 URL/候选去重/分享规则、Digest 真实 Provider 至多 2 次合成调用（本轮账本独立、保留前轮累计8）。
  真实 Electron 串行；新的独立并发/安全 Reviewer；最终校验实际包及来源绑定，隔离 profile 启动
  在当前宿主失败后按下述已审工程 REPLAN 验收本地换包，不冒称实际封装运行或安装验收通过。
- STOP / REPLAN：同路线两轮无新证据即换路；物理条件、产品取舍或安全/数据完整性不能保持时明确报告。
  工程取消路径需有真实生命周期证据，不把“用户同意”泛化为允许丢弃业务写入。失败和旧产物完整保留。
- DELIVERABLE：Windows x64 未签名内部候选、手动升级；通过后本地保存并正常双远程同步（GitHub先核代理），
  旧 output 在项目受控历史目录保留再切换，新版本来源清楚且可回退。实际结果写本节与 progress。

### 本轮工程验收修订

- 全量首轮保留 `log/legacy-followup-20261012/full-tests-001.log`（实际目录以最终索引为准）：
  471 文件中 462 PASS / 8 FAIL / 1 SKIP，6,899 项中 6,868 PASS / 29 FAIL / 2 SKIP；
  测试启动时安全修复仍在产生红态，另有旧工具夹具接线和历史机器证据缺失；不把该场称为冻结候选通过。
  后续冻结后只再执行一次完整回归，失败先定位再决定受影响验证。
- 旧 snapshot 测试改为观察生产 `AbortSignal.any` 的实际信号，继续验证监听器从 1 归零、取消、
  双读者隔离和迟到结果；main-failure 测试接入生产 NormalQuit 构造器及当前退出回调；两个旧数据库
  测试只补 `mkdtemp` 父目录创建；保存框合成 UIA 类型改用独立 namespace，避免误载系统同名类型。
  上述均不修改产品或缩小行为断言，独立复核 5 文件 55 项通过。集中本地开发环境后，ESLint 把
  `.local-dev/temp` 的合成非法 JS/TS 当作源码，产生 46 项错误；将本已 gitignored 的 `.local-dev`
  和 `output` 加入与 out/log 同类的生成目录排除，不关闭源码检查规则。
- H3a 单元截止测试采用受控单调时钟，在真实 transport close 门将时钟推进至原 100ms deadline，
  调用未改生产判定，仍断言唯一首轮请求、替补未尝试、未闭合请求及同一截止。生产阈值和真实采集
  预算均未变化；旧普通 Error 的精确历史抛点无栈，不能宣称已恢复唯一原因。独审后另一旧冻结身份
  用例出现 EVIDENCE_WRITE_FAILED（19 PASS / 1 FAIL，原件 reviewer-h3a-clock-green.txt 文件名虽
  含 green 但实际是 FAIL），新增透明文件操作诊断与失败留证，避免不明原因重复运行。
- 四份已清理的历史 physical-full-transfer `fixture-proof.json` 是固定场次机器证据，不能伪造为可移植夹具。
  对其原字节/摘要的检查改为显式历史审计：设置 `AIBROWSE_VERIFY_HISTORICAL_PROOFS=1` 后执行该测试文件；
  原 65,536 字节上限和固定 SHA256 断言完整保留，启用后缺失仍失败。默认记录该项 NOT RUN，
  其余四项纯校验器反例照常运行。这是验收类别修订，不是等价替代丢失原件，更不重新授予历史物理场 PASS。
- 实际发行包采用窄 PackageSmoke：临时同父目录 rename 隔离 profile，记录原目录 FileID/SDDL，
  在 finally 中按原实体恢复；不复制替代真实数据。可信 UI 就绪后一次普通关窗，分别验证精确 main/guardian
  原生句柄正常 exit 0、同会话 writer 双 null、外层 Job 自然归零，以及前后包摘要不变。
  工作总期限 120 秒、正常关窗 20 秒、失败收口至多 30 秒；强制收口只记 FAIL。18 项恢复/身份/账本
  合成测试通过后独审工具，实际运行须绑定干净提交与新包来源清单；这不替代长期资源验收。
- 实际 PackageSmoke 的隔离前置失败后，停止该宿主路径，不追加外部会话、注册表或其它隔离方案。
  新建 synthetic 的句柄实际落在 Codex 包的 `D:/WpSystem/.../LocalCache/Roaming`，与请求的
  `C:/Users/30910/AppData/Roaming` 同父条件不符，原校验正确拒绝；相同卷编号不等于同父。
  原 profile/父目录 FileID、SDDL、卷和实际路径均与 manifest 一致，backup/retired 均不存在；
  未读取业务正文，不宣称逐文件字节审计。失败 journal 只到 manifest/synthetic-created，未保护、
  激活或启动产品，完整保留在 `package/journal-7cacd772d0ee46baa72771a6e63377bd`。
- 本地更新的替代证据：旧 FIRST 与新包的 75 载荷成员中 73 个逐字节恒等，仅 AIbrowse.exe 和
  app.asar 不同；guardian、工具链、构建配置、安装器编译工具不变，安装器源码仅 package 版本输入
  变化。主程序 PE 的 14 个非资源段及额外数据恒等，54 个资源仅 ASAR integrity 和版本两项变化。
  新包安全策略与严格 ASAR→构建→当前源码校验通过，新增行为又在完整 production 中实际
  覆盖挂起、确认、排水、writer 退休及 guardian 闭合。独立 Reviewer 核验差量后可批准**本地可回退
  内部更新**；实际新封装启动仍为 NOT RUN，不授新的完整发行、安装/升级或真实用户数据运行验收。
  这是利用未受影响封装证据和当前实证替代失效采集方法，不把失败改记成功、不接纳重定向测试目录。
- 换包工具增加显式 EquivalentEvidence 入口，要求固定独审记录与新旧包、完整 production 终态、
  静态校验和原 profile 身份证据逐摘要绑定；保留默认 PackageSmoke 门。包仍绑定已构建的干净
  `5c7f487b1ab9e1cd7dc4225505823f6616f03476`，后继 HEAD 只允许本文、progress 及 output-switch
  脚本/合成测试四条路径差量，且实际工作区必须干净；产品、依赖、构建输入有任何差量即拒绝。
  不因仅文档/换包工具变化重建相同产品，切换前后核全成员摘要，完整保留旧 output 与失败原件。

### 当前修复结果与证据边界

- 退出：新增主进程 NormalQuitCoordinator，正常关窗与 app.quit 共用一次 drain；可信原生弹窗默认和 ESC
  均为继续等待，再次关窗可重新选择。批准停止才停止新快照并取消精确请求；已派发原生请求只在对应
  WebContents 确认销毁后退休应用侧等待，原生 Promise 仍 pending 时如实记录。正常写入/usage/workspace
  继续等待，main failure 保留独立接管，guardian 门不跳过。旧实际竞态的触发机制已证，旧 d79 场唯一
  触发者仍 unknown，不把新成功倒推为历史唯一根因。
- 摘要：把闭合 sections/eventIds/explanation JSON 结构、字段顺序、引用范围和原长度预算加入生产
  system prompt；校验器保持严格。上一轮同请求只补 schema 的真实 Provider 对照支持根因，本轮生产
  prompt 真实复验 `log/legacy-diagnosis-20261012/models/repair-live-001` 仅 1 次请求，返回 HTTP 401
  invalid-key，未得到输出，不能记当前在线生成通过。配置/凭据/Local State 原摘要不变，不重复调用
  无效凭据；前轮 8 次请求与本轮 1 次均保留，离线协议和校验器回归通过。
- Research：目标中的显式 HTTP(S) 网址进入有界候选，去重后优先保留；已有信源的 disabled/blocked、
  分享及 trust 规则仍生效，并在读取前复验；无存量信源的网址不自动收藏或获得可信标记。纯内存/SQLite
  反例覆盖禁止规则、IDN、query/fragment 去重与 transfer 冷读；零 Sources/Search 的真实 Electron
  捕获产生 1 candidate / 1 capture / 1 evidence / 1 claim。该场模型为 FakeProvider，只证明入口、
  真实页面采集和持久化联通，不冒充当前真实模型成功。
- 地址栏：支持无协议 Unicode 域名和 Unicode 点号，经 WHATWG 规范化为 punycode；保留搜索词语义。
  独审发现的 user:password@authority 搜索泄露反例已修复，含凭据的地址先安全拒绝，不导航/搜索，
  不再把原地址或 tabId 写入无效输入日志；普通邮箱和路径中的 @ 保持原语义。原始隐私红态与最终
  56 项地址/安全回归及独立 81 项结果全部保留。
- 真实 Electron 9 场：`shutdown/matrix-acb9dec9753b439f8d3594541de48552`，4,800.9894ms、
  exit 0 / Job 0、completed true。原脚本同 tick / setImmediate 销毁竞态均先观察到 pending，再经
  明确批准闭合；系统按钮由固定 PID 的测试自动化点击（先等待、再次关闭后停止），不声称真人点击。
  其余含活页面和写入阻塞的受控 Promise 场为补充反例；整个矩阵使用实际相关产品模块，未执行完整
  index/guardian，因此完整 production 和新发行包另验。独审后继逐摘要复核 99 个绑定源码：98 个
  恒等，唯一变化 url.ts 的地址栏解析/凭据拒绝未进入该场 bundle；实际打入的 URL 日志脱敏函数未改，
  因此限定复用这九场，index 的退出整合和日志修复另由完整场覆盖。completed.json SHA256 为
  `7712fe8359147c2f71254b547d7d6f51e915373dc48ad6223ff6355dee03f7ae`。
- 独立安全/并发审查已对产品差量给出限定 PASS，原件 `independent-review.md`；后继工具准入与
  最终包运行分开判断。先前 UI 深浅双模式、Watch locator 和 reasoning 修复继续包含在交付范围。
  用户明确暂留资源增长；旧 60.9178/h 超限及分配根因 unknown 不关闭，不新增长时资源测试。
- 最终全量 `full-tests-final.log`：470 文件 PASS / 1 SKIP，6,896 项 PASS / 3 SKIP，550.23 秒、exit 0。
  三个 skip 含原有条件项与本轮显式历史 proof 审计，不代表这些场景已实测。H3a 证据写入失败未再现，
  透明文件诊断保留，旧精确 errno 仍 unknown。该场启动后 20 秒，仅 H3a 测试诊断的路径参数筛选
  做了隐私修正（不改产品/断言），在进入该文件前冻结；最终文件 SHA256 为
  `6bfce13a8b3487974ae07047cd373523caa521909fb650cf88310599bec1f855`，时序原件
  `full-test-diagnostic-revision.json`。全局 typecheck/lint/format 最终 `*-final-002.log` 均 exit 0，
  普通 build `build-ordinary.log` exit 0。
- 完整 production 唯一场 `log/stage7-e2/default-smoke-production-891cae9aa1d94418845b3dfeef3eda83`：
  407.764 秒，应用/外层 exit 0，result/completion passed true，prepare/application/readback 三个
  Job 实际归零、ledgerRetired true，源码/运行时/制品绑定未变。候选为干净 `4524529e57ceeaa1012a54fd3c97c40c60e17ab9`。
  本场再次出现真实 previewContext=1 在途等待，新的可信原生弹窗确实保持等待；隔离测试在
  14:02:50.878 明确选择“停止快照并退出”，14:02:50.992 应用记录正常退出并完成独立账本读回。
  该选择是固定 PID/创建时间/窗口归属的测试自动化 BM_CLICK，不是真人决定，也不是 kill/app.exit；
  不能将 407 秒含人工排查/选择等待的墙钟视为正常关闭耗时，亦不称为全自动无交互退出。
  初次只查顶层窗口未见嵌套弹窗；首次按钮守卫预期 Button、实际 UIA class 为 CCPushButton，故
  动作前拒绝且零点击。按实际子窗口身份核准后只投递一次停止按钮。观察/动作原件位于本轮目录
  `production-dialog-*.json`，报告 SHA256 `1489444426887ce8d23b56d61cb263ab95326f99a44430f395e22c1f138f6d1e`。
  新包构建和静态绑定随后通过，实际发行包零快照普通关闭因上述隔离前置失败为 NOT RUN；
  旧 d79 精确触发者继续 unknown。
- 本地更新已经执行：独审最终工具 `output-switch.ps1` SHA256
  `47f6855bd54dea9c279094fb800ca1e6a9b3792e8bd2d9c4b87c3918243b1b9b`，独立 11 项合成检查
  `output-switch-fixture-265b0960b8fd4a388db767c0e5982b83/result.json` 全部通过。实际工具来源为干净
  `e6ce91a436f3ccc96b9ea73591426aa85b2d1e18`；CheckOnly / Switch 均 exit 0，显式
  EquivalentEvidence，packageLaunchTested=false、packageLaunchStatus=NOTRUN。
  当前 `output/` 为 0.1.2 的 79 文件 / 619,783,005 字节，包含完整程序、EXE/MSI 安装器和身份文件；
  包源为干净 `5c7f487b1ab9e1cd7dc4225505823f6616f03476`，后继仅合同允许的文档/换包工具差量。
  manifest SHA256 `a903cea5d1ab6d5683f8456ffc96ac8d91f1d61391ae47cb3c8613b5fd504b9b`，
  程序 SHA256 `754b10c8aabcc0c89ff01fb868e3593e5eb322b9189325039edb06d3c199a504`。
  旧 0.1.1 的 80 文件 / 619,715,306 字节逐摘要恒等保留于本轮目录
  `previous-output-c54e75b394b0408890ebe06a99b82a06`；无需删除旧版完成更新。
  切换计划与回执在 `output-switch-c54e75b394b0408890ebe06a99b82a06`，result passed=true、
  originalBytesPreserved=true，result SHA256
  `339a44794a9287b69962c1567723978ae33a42c0369d4268368c81d0cbc78425`；plan SHA256
  `b06d8d2e701f6b5db8b8c5e019996c631662c3feeba8d541c9e7b6184c6f58e9`。
  最后独立只读复核新旧全部文件与 14 份绑定证据通过；旧 manifest 按 plan 映射至旧树保留位置。
  `reviewer-output-final.json` SHA256 `3b507cb0293e324715309fc93db2dbcf39d54c8af079dd361d443cff6543c322`；
  最终 `independent-review.md` SHA256 `d75289cab97de1bcb12dc306cb197a6c5c43f27ee7d563ab648645cb095748fa`。
  回退入口为 `pwsh -NoProfile -File tools/legacy-followup/output-switch.ps1 -Action Rollback -SwitchId c54e75b394b0408890ebe06a99b82a06`，
  实际回退未执行；工具会先要求应用/guardian 退出并核对固定计划和完整旧树，再保全新树和恢复旧树。
  本轮到此停止新增产品实现，资源旧超限与 fatal 历史 unknown、当前真实 Provider 401 和实际新包
  直接启动未测边界继续保留；不把本机内部可回退更新外推为完整发行验收。

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

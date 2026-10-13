# 遗留问题修复与严格诊断（2026-10-12）

## 自定义主题色（2026-10-13）

- TASK / BASELINE：用户在手动IDM收尾时新增主题色需求，提供Chrome配色截图。先完成旧任务0.1.11交付
  与双远程同步，干净baseline `035e504b1313c2fb3065c81c2d592f791adea68e`。
- GOAL / SCOPE：外观页增加预设色卡、自定义选色/HEX、恢复默认及持久化；浅深系统模式独立；应用外壳与
  原生标题栏同源配色。正式契约 `doc/design/theme-colors.md`。不涉及截图中其它Chrome设置、网页主题注入、
  壁纸或远程主题包，不恢复已撤销IDM自动接管。
- PLAN / INVARIANTS：共享纯调色算法；renderer专用色键/UI；闭合IPC与原生标题栏并行实现。保存失败诚实
  反馈；既有mode、用户脚本、任务隔离、语义色/分组色保持。无新网络或系统通用能力。
- TEST / ACCEPTANCE：先建立新色输入与安全/持久化反例；预设和极端色对比度、键盘/选中、模式独立及
  重启验证；受影响typecheck/lint/test/build、真实隔离UI和独立审核后更新内部程序/安装器并双远程同步。
- STOP / EVIDENCE：不降低可读性门；最多两轮同假设无新证据即调整工程方案。新证据
  `log/theme-colors-20261013/`，旧0.1.11仍为output选定版，新候选验证前不替换。
- 聚焦实现：配色59项、renderer46项、main/preload30项及独立12文件121项通过；root集成12文件142项
  通过，计数重叠不相加。独立色彩oracle覆盖729种RGB×浅深两模式；严格HEX/IPC、两键独立、保存失败
  保旧均有反例。全局typecheck/lint/format与普通build通过。默认浅色次级文字和AI按钮背景已有甄别红态。
- 首轮原生UI `runtime-b9974cb8-bed4-4c0b-a885-12a0a6d9256a` 实际FAIL：AI按钮浅色悬停被更高优先级
  的全局button规则覆盖，白字对比仅1.281。0网络/Provider/IDM，源码与构建前后恒等，失败原件保留；
  当前代码审核结论收窄为纯逻辑/IPC/持久化PASS，产品待CSS级联修复与原生复验，不能以纯算法通过代替。
- CSS修复改为优先级明确的AI专属选择器，真实源规则级联反例红→绿，renderer48项及独立13项通过；
  普通build-02通过，首轮构建完整归档至`out-before-hover-repair`。第二轮`runtime-f2591376`已通过所有
  主题切换/HEX/键盘/窄窗/原生同步/悬停及旧功能门，但最终保存样本等待全document无限spinner，180秒
  超时FAIL，8次本地请求、0Provider/IDM。这是采样等待范围错误；工具限定为所测控件的有限动画并记录
  忽略项，保持实际computed style对比、原生参数和重启门不变。产品和普通构建无需修改，旧失败均保留。
- 最终原生UI `runtime-833f8981-426e-421e-b7ce-6c7847d96ba0` 双进程PASS，before/after恒等；当轮9/20
  本地请求，三轮累计17，Provider/IDM/Cookie/CDP/产品请求头监听均0。紫色浅深normal/hover对比分别
  5.84566/8.10066；实际native overlay与DOM逐样本匹配，键盘focus-visible、600px布局、HEX拒绝及
  大写归一化、取色input事件、恢复默认保mode、system当时系统选择、自选dark/#245f94重开均通过。
  原分组/下载拒绝/脚本及任务隔离相关门保持。主协调复看浅色全窗、深色600px和自选色重启截图。
  仅忽略了1个transform-only的`.spinner`无限动画，进一步确认旧等待阻塞原因；其他无限动画受控拒绝。
  未改变OS主题；物理输入、系统取色对话框操作、真实profile及发行包/安装器启动NOTRUN。

## 内置脚本交付与恢复手动 IDM（2026-10-13）

- TASK / BASELINE：接管 `7bf5f38080c9713010a362e6a1c093aef356efe9`，用户告知 IDM 修复完成；
  一次本地 COM 探针与一次官方小文件对照均返回成功但未观察到确认窗口。用户随后确认仍提示损坏，
  明确改回原有手动填写 URL。诊断工具变化单独保留于 `2069ab2`，失败原件不改判。
- GOAL / FIXED DECISIONS：保留两个内置指定脚本、外观与标签分组；IDM 仅受信 UI 手动发送 URL，
  撤除网页点击自动接管、Cookie/来源/UA 交接、COM helper 及相应构建资源。不再诊断或启动本机 IDM。
  手动入口只表示请求已发送，IDM 安装存在不等于健康；本机损坏仍可能阻止下载，不声称已经修复。
- SCOPE / PLAN：恢复原浏览器下载拒绝与手动服务装配，保留脚本内置初始化、ASAR 校验、状态保持和
  跨 await UI 许可修复。撤销的工程源码留在 Git 历史，专用工具移出当前构建图，所有日志保留。
- TEST / ACCEPTANCE：撤除能力的甄别反例、原手动服务与严格 IPC、浏览器 popup/任务隔离、内置脚本
  持久化反例及原生 UI/本地真实下载拒绝；受影响 typecheck/lint/format/build 与独立审核。
  新包须无 COM/helper/自动 Cookie 读取模块，7 内置资源及27资产恒等；独审后更新 output 与双远程。
  真实 IDM 窗口不再是新范围完成条件，既有失败保持失败；不执行安装器、不启动真实 profile。
- STOP / EVIDENCE：不作进一步真实 IDM 调用；发现脚本或既有手动入口退化即修复。复用未受影响旧证据，
  新证据在 `log/manual-idm-return-20261013/`；旧自动下载候选仅为历史，不可作为当前选定交付。
- 诊断事实：本地 `idm-real-e51a5f38-a88a-4454-8fa4-945633643fd9/result.json`、官方固定 ZIP 对照
  `idm-real-23fd7649-4933-4ba5-a9c2-eb3ddb7c084c/result.json` 均位于旧 builtin-tools 证据根，均 COM
  成功但 observer 未找到窗口；本地请求0，官方实际请求数不可观察。没有点开始或关闭其它窗口。
  窄范围进程/注册表事实只输出布尔与程序身份；官方对照的事前计划在会话消息，不能把后补工具 plan
  输出代码当作该次已有事前文件。用户确认损坏后没有继续调用或修改 IDM。
- 当前修订：浏览器生产代码与手动版基线恒等，新增“输入也无自动下载入口”反例红→绿，4文件86项通过；
  手动服务29项通过，root集成11文件126项通过（计数有重叠，不相加）。typecheck/lint/format/build均0。
  原自动 out 的40文件及 release 的81文件完整移至本轮 `previous-auto-out` / `previous-auto-release`，
  原件未删，output旧0.1.10 manifest恒等。
- 新原生 UI/拒下载：`runtime-9bdeb799-06bf-4fa8-ba70-c26966867181` 两阶段一次 PASS，9/20 localhost，
  源码/工具/构建前后恒等；真实 trusted click 对应唯一有 userGesture 的 will-download，产品自行取消。
  产品请求头监听、Cookie读取/CDP及 IDM 尝试均0，旧外观/分组/两内置脚本/持久化门保持；Provider0。
  主协调复看深色手动 URL 界面和浅色两脚本开关截图，文案/控件可读；物理输入、打包启动 NOTRUN。
  工具新 oracle 红1→7PASS 保留。独立复跑17文件188PASS，产品/工具独审 `independent-review.json` PASS，
  绑定新手动源码候选 `667b480ff541586f4587dd3e6d4a6dd686bdfc81`。
- 发行/选择：该干净候选构建0.1.11程序与EXE/MSI，package/verify/static/provenance/compare均0；
  `review-package-final.json` 独审PASS，225源码模块、16构建件、63ASAR、75程序文件、7资源文件27资产，
  无自动下载模块/COM helper/对应manifest。独审只读比较的排序/Windows ASAR路径适配失败保留，
  修正工具后数量/字节/摘要原门不减；未把同manifest比较称作可复现构建。
  来源manifest为`e52de0c3cabab84edcf0f1f2f6196091954f7cd2592707f954ffcf90dce1586d`，独审选择记录冻结22证明。
- output CheckOnly/Switch均0，ID`d74b1d9d80c6420e8258c25ed7ac43cb`；新0.1.11为79文件624807330字节。
  旧0.1.10完整79文件621055447字节保留于本轮 `previous-output-d74b1d9d80c6420e8258c25ed7ac43cb`。
  `output-switch-review.json`最终独审PASS：新旧各79文件及23证明与plan字节闭合，旧版完整保留。
  切后collector原目录预算不适用于含安装器根目录的失败原件保留，按75程序+4根文件逐项复核原门通过。
  包/安装器启动仍NOTRUN，真实IDM停止验证且不声称健康；本任务完成，仅文档收尾正常同步双远程。

## 浏览器内置脚本与点击下载接管（2026-10-13）

- TASK / BASELINE：用户要求阅读插件与脚本代码直接集成到浏览器，IDM 保留点击下载链接后解析并弹出
  下载窗口的交互。干净 baseline `853ea389aba842b5feb7820f787bc4a24b02fbb5`，当前 output 0.1.10。
  这是对上一轮手动脚本安装与粘贴链接路线的替换授权；不恢复已取消的沉浸式翻译和原版扩展装载。
- GOAL：两个指定脚本随程序提供、无需联网下载安装或挑选本地包；提供明确的启停入口，保留设置和现有
  功能。普通浏览中用户点击下载链接，浏览器识别实际下载及重定向地址，打开 IDM 原生下载确认窗口。
- INVARIANTS：保留研究/监控任务页隔离；AI 操作、无用户输入的自动下载、隐藏/失效页面不得自行启动 IDM；下载确认
  留在 IDM，浏览器不静默写入下载文件、不增加模型工具。原稿身份、来源、许可与改动如实保留；禁用讯飞
  翻译、普通用户脚本导入和现有脚本设置不退化。不会把 URL 交接称作视频抓取或全协议下载兼容。
- PLAN / SCOPE：并行调查官方 IDM 扩展代码/公开接口、本机安装与两个原稿/依赖许可；采用原生下载事件、
  可验证用户输入和文档归属建立有界接管路径；脚本复用已有隔离世界和有界能力接口，换成内置资源供应。
  工程选择依最小真实可行性结果确定后同步正式设计；新增外部凭据转交等产品取舍须明确裁决。
- 用户已裁决支持登录下载，批准只向本机 IDM 转交该次下载需要的 Cookie 与来源信息。工程采用原生
  优先匹配 onSendHeaders 的实际请求头，不枚举完整 Cookie 库；固定 COM helper 使用 stdin 五字段有界协议，
  flags=0，保留 IDM 确认。正式设计已同步 `doc/design/qualified-scripts-idm.md`。
- 原生输入的诚实边界：点击后网站可以通过 JavaScript 决定实际下载地址；Chromium 的短暂用户激活并非
  链接内容意图证明。实际观测到无关点击后约100ms脚本触发仍带 userGesture，因此不承诺禁止一切脚本
  下载。每次操作仍最多一次 IDM 确认，任务/子帧/AI/无输入/过期许可拒绝，不自动开始下载。
- TEST / ACCEPTANCE：先建立旧版无内置脚本/点击接管的甄别性检查；覆盖重定向、下载元数据、一次点击
  一次交接、AI/任务页/子帧/伪造输入/过期文档拒绝、导航并发和清理；原生 Electron 验证实际点击到下载
  事件，再验证受控 IDM 窗口（若本机程序存在）或明确标记未运行。内置资产在普通与发行包均可用，设置
  跨重启保持；关键能力与持久化经新独立审核，完成受影响回归和包身份验证后更新 output 并双远程同步。
- STOP / EVIDENCE：先验证平台事件能证明用户输入与下载归属，不把不可靠标记假设成事实；同路线连续
  两轮无新增证据即换路。第三方原件、失败和请求计数在 `log/builtin-tools-20261013/`，通用工具入 Git；
  不降低验收门，不以额外调查掩盖影响用户体验的未解决限制。
- 当前验证：内置27资产的原稿受控效果与重开已通过 `builtin-actual-002`，真实ASAR虚拟读取通过
  `asar-resource-001`；首次工具时序失败保留。全量 `full-test-01.txt` 实际7607PASS/1FAIL/3SKIP、exit1，
  原因是普通popup回调新增undefined第四参数；保持旧三参数语义后原独审与浏览器104项通过。
- 下载采集REPLAN：真实Electron普通、重定向及新标签请求头完整；`download-product-10`证明download属性
  请求实际携Cookie/UA/Referer，但onSendHeaders为空；11的beforeSendHeaders亦为空。`cdp-download-02`
  又证明页面CDP无该下载请求事件。禁止把缺失头当匿名成功；原工程单一onSendHeaders方案须更换。
  精确Electron43.7.7源码的cookies.get(url)包含所有分区且剥离分区标识，故不能直接用它代替实际请求Cookie。
- 替代资格 `cookie-scope-01` 首场4次localhost请求PASS：精确URL的固定CDP getCookies使用当前主frame的
  隔离键，只返回本顶级站点分区及未分区Cookie；排除其它路径/顶级分区，HttpOnly/Strict和实际请求匹配。
  来源原生字段正确执行origin与no-referrer，UA匹配；未启用Network事件、未采集正文、0IDM。
  仅严格同源完整链的空头GET/other路径采用该读取，能力和失败边界见正式设计。新增reader16项通过，
  独审另发现blob页面origin相同与不可序列化分区字段两反例，修后独审6项及相关27项通过，失败原件保留。
- 当前独审 `independent-review.json` 为REPAIR：三项同URL头关联、两项异步脚本开关反例已关闭；跨手势
  在途旧请求不得因10秒过期就遗忘关联，需要真实终结证据或等价请求身份边界。敏感头仍及时清理。
- 真实IDM一次调用返回S_OK，但既有IDM提示主程序损坏，未出现目标确认框；原始诊断保留。
  用户选择自行处理IDM后继续验证；没有点击其现有继续下载按钮、修复软件或把COM成功当作窗口验收。
- 当前代码审核：`independent-review.json`最终代码安全/持久化/并发PASS，13文件236项；旧REPAIR完整留为
  `independent-review-interim-01.json`。五个旧缺陷和两项reader反例均关闭，原件保留，不扩张到真实IDM/发行包。
- 最终原生产品：`download-product-final-01`，29localhost/0IDM，六种普通/属性/重定向/新标签路径传递的
  Cookie集合、UA、来源均与服务器一致，AI/任务/iframe/无输入零service；旧A/新B逆序只交接B。
  最后reader计时器const整理与UI“所需登录信息”文字不改变授权或时序语义，独审确认等价复用，22reader项再绿。
- UI双进程：`log/browser-groups-userscripts-20261013/runtime-7452024f-6668-43da-add1-ca2068688c19/`
  PASS，外观/分组/内置启用开关/脚本持久化与原桥接门通过，7/20localhost、0Provider/0IDM，源码产物前后绑定。
  主协调复看深色外观与下载脚本设置截图，选项和两个开关可见。打包启动/物理输入仍NOTRUN。
- 回归：`integration-final-01` 19文件350项PASS；`typecheck-final-02`、`lint-final-02`、`format-final-02`
  均exit0。首轮缺statusLine测试夹具、reader prefer-const失败原件保留，修复不更改权限门。
  普通build-final-01成功；最终发行构建仍需绑定下面的干净候选提交。旧release原目录已完整移到
  `log/builtin-tools-20261013/previous-release`，旧manifest摘要见`release-archive.json`；output不变。
- 候选与静态包审核：干净源码`14e9302929fec66dc4eee9209d7f643553f547c8`构建0.1.11，`package-final-01`
  与包校验/静态绑定/provenance/比较均exit0；最后报告`review-package-final.json`PASS，独立核对
  229源码模块/17构建件/64ASAR/76程序文件、7资源文件中的27脚本资产、12安装器源码及MSI只读表。
  新helper为8704字节，SHA256 `869c611c9c3ac0dd5c3d3a16a2f54ff86fb1a3dbf4fa264b5fd36e21f221bf81`，
  源码/编译脚本、两Roslyn与三Framework引用、out与包内外身份完整匹配；编译证据为`idm-compiler-final.json`。
  发行manifest SHA256 `ae322762048f919669d1356a70b6f362bb1bee06813c0e377bd954ef4e085e30`。
- 当前交付边界：候选程序和EXE/MSI位于`release/`，output仍0.1.10且manifest恒等旧值；没有切换或运行
  安装器、没有启动真实用户profile。静态包PASS不替代IDM确认窗口或实际下载验收。
  用户选择先修复本机IDM，故保留此唯一外部待验；只读/关闭精确探针对话框的工具已收紧为可见#32770、
  唯一token和开始/取消按钮，纯分类测试PASS。已构建`idm-native-ready.mjs`及输入身份（executed=false），
  收到修复完成消息后校验身份再执行，随后按真实结果决定output选择；不擅自点击用户现有继续下载窗口。

## IDM 工具与指定油猴脚本（2026-10-13）

- TASK / BASELINE：用户进一步收缩需求：去掉沉浸式翻译，只保留 IDM 工具与油猴脚本，翻译交由现有
  AI 共读。baseline 仍为 `73c378329c755fff2ea1555b4e461348923f1fcd`，已有未提交差量仅为上一节
  原版扩展调查文档与受控探针；全部保留，不能将其记为安装成功。接管时 output 0.1.9。
- GOAL / FIXED DECISIONS：沿用原有标签与登录会话，不新增独立插件区，不装原版 Chrome 扩展。
  IDM 通过显式用户操作发送 HTTP(S) 下载链接到本机已安装程序；不自动接管下载、不捕获媒体或转移 Cookie。
  用户指定 GreasyFork 14178 AC-baidu 与 435208 GitHub 中文化；先下载原版静态资格，按实际依赖判定兼容。
  原有限 DOM/样式脚本支持继续可用，不把现有子集或自制示例冒充这两个脚本运行通过。
- INVARIANTS / NON-GOALS：研究/监控任务 Tab 不注入脚本、不发送 IDM；网页/模型不能调用 IDM 或安装脚本。
  原 Session 下载拒绝保留；不向模型增加 shell/JS/通用网络/文件能力，不修改真实 profile/安装软件。
  普通页脚本可能改变 AI 共读看到的 DOM 及共享网站状态，此诚实边界已向用户说明，不能承诺绝无间接影响。
- PLAN / SCOPE：并行 IDM 主进程服务与两真实脚本静态资格；root 完成受信 UI/IPC/装配与正式设计。
  主进程固定检测标准 IDM 安装路径，spawn shell=false、固定 `/d` 参数与校验 URL，零任意参数/路径接口。
  未检测到程序、失败/忙碌/关闭如实返回；成功只表示请求发出，实际下载确认与进度由 IDM 负责。
  脚本需要扩大安全/隐私承诺时先给出具体影响；不为显示“已安装”删掉原版依赖或静默降低功能。
- VALIDATION / ACCEPTANCE：严格 IPC 与 URL/参数注入反例、真实进程参数传递的受控替身、UI 提交与错误反馈，
  旧任务页与下载拒绝回归；指定脚本必须有原版字节/来源和实际功能证据才能报兼容。
  真实 IDM 默认不执行无人值守下载，受控替身只证明交接机制；未知/未运行保留。安全接口独立审核后交付。
  原件在 `log/idm-tool-20261013/`，通用工具纳入 Git；两轮无新证据即换路，产品取舍才请求裁决。
- 用户已明确批准两脚本所需存储、跨网站请求及 AC 网页 JavaScript 交互，仅普通用户标签；
  禁用 GitHub 附带讯飞翻译，翻译交由 AI 共读。正式差量为 `doc/design/qualified-scripts-idm.md`。
  工程采用根源码与依赖全哈希固定的两资格档、普通 Tab 专用隔离世界 preload、主进程受限能力代理；
  通用手动导入脚本仍保持原能力子集，任务页不配置专用 preload。用户确认已满足，不再等待重复裁决。
- 实现与修复：IDM 固定路径 `/d URL`、受信 UI/IPC、脚本固定目录/原子存储/公网客户端/专用 preload
  已接通。独审反例关闭外部 bundle 删除/修改后错误启用、数组 getter、GitHub 讯飞入口；红态原件保留。
  AC 原稿裸 `Reg_Get` 的作用域错误在精确版本内存副本修正，原资产不改；实际验证两重定向路径通过。
- 原生脚本：`qualified-actual-3/result.json` PASS，GitHub/Gist 本地汉化与无讯飞入口、AC 两重定向路径、
  菜单/写后 reload/存储重开、三设置域窄桥与拒绝伪造、同 Session 任务页不注入均通过。
  三场累计20内存页面+5broker替身，外网0/Provider0；首场 oracle 布尔误判与真实原版回退缺陷、
  第二场入口红态及侵入调试超时原件不改判，不将离线代表 DOM 扩张为线上所有站点完整兼容。
- 交付路径：真实在线安装首场两 root 各1次均10秒超时，完整失败在 `install-network-01/`。
  新增有界 JSON 本地包安装，复用固定目录逐资产摘要和原子提交，不放宽网络。两个包共27资产已组装至
  `script-packages/`（Git 忽略），本机 SHA 与 `local-packages-01/packages.json` 一致；
  `install-local-02/` 两完整包安装及重开 PASS、0网络；`idm-argv-03/` 实际服务+真实子进程 argv PASS，
  未执行真实 IDM 下载。两个探针均有当前源码/工具绑定。
- 审核：新的独立 Astra/xhigh 安全/持久化/并发审核 PASS，最终15文件258项通过；原件
  `independent-security-review-final.json`。范围不包含发行包身份、线上完整兼容或真实 IDM 下载。
- 完整 UI 冒烟：`log/browser-groups-userscripts-20261013/runtime-a63e5cc8-44af-40b7-b666-cbf1bd219c5e/`
  双进程 PASS，工具直达/两固定标识/IDM非法URL拒绝/深浅600px/旧分组与脚本持久化全部通过，
  7/20本地请求、0Provider、0IDM启动、源码工具产物前后绑定一致。
  先前 ef884、8e283 两场启动失败保留，已定位为新验收工具误拦产品必要 guardian 子进程；
  修正仅拒 IDM 后默认 GPU 正常，不改变 UI 验收阈值。此场版本元数据为0.1.9；随后仅升版本0.1.10。
- 全量实际520文件：7550 PASS / 2 FAIL / 3 SKIP，627.11秒、exit1，`full-test-01.txt` 保留。
  两失败均为旧验收依赖适配：启动 AST 夹具缺新工厂、SRT-12 字符串扫描把脚本 runtime.prepare 误归 SQL。
  前者补齐隔离工厂，仍断言到达原业务 Store 时准入关闭；后者仅给精确文件中的精确语句增加非 SQL
  分类，异路径/追加SQL负例继续拒绝。修后两文件39项通过；组合7553 PASS/3 SKIP，不改判原全量命令。
  最终 typecheck-04/lint-all-03/format-all-02 均 exit0，lint旧未使用表达式失败及修复原件保留。
  首个0.1.10发行构建成功绑定99cab0b，验收工具修复后重新干净构建，避免包身份混用。
- 最终交付：干净源码 `ae4acd2d3870565055845e3f0480fc64c35b493d` 构建0.1.10，包验证、静态绑定、
  来源清单及PE比较均0，源码/包新独审PASS（225模块、16构建件、56ASAR成员、75程序文件）。
  manifest SHA256 `083e703df2617ceca4987f75d34f8a1a99843ef660e44b4418b560ee8ac8a8f2`；
  程序和EXE安装器实际均NotSigned。CheckOnly/Switch均0，切换ID `4c12eb1cd62f4ad2a45929bb94aabb1c`。
  `output/` 已为0.1.10（79文件、621055447字节），旧0.1.9的79文件完整保留于本轮
  `previous-output-4c12eb1cd62f4ad2a45929bb94aabb1c/`；独立 `output-switch-review.json` 逐项复核新旧全树PASS。
  发行程序启动/安装器执行、真实IDM下载及线上全部脚本站点兼容仍NOTRUN；不把普通原生UI、
  受控原稿代表DOM、实际argv替身及静态包身份扩张为这些证据。本任务完成，后续仅文档和正常双远程收尾。

## 油猴、IDM 与沉浸式翻译接入（2026-10-13）

- TASK / BASELINE：用户现要求添加三个指定插件：Tampermonkey、IDM 下载助手、沉浸式翻译。
  干净 baseline `73c378329c755fff2ea1555b4e461348923f1fcd`，当前交付仍为 0.1.9。
- GOAL / SCOPE：先核对官方插件包实际依赖与 Electron 43.7.7 运行能力，再实施可证明工作的接入；
  不能把内建脚本子集或第三方自制替身称作原版插件。新请求授权本轮接入，覆盖上一任务的暂缓边界。
- INVARIANTS / SOURCES：仍保持用户此前要求的 Research/Watch 任务页隔离、共享登录既有承诺和宿主权限边界。
  官方 Electron 扩展文档、插件发行方文档/包、当前源码与实际隔离探针共同确定工程事实。
- PLAN / VALIDATION：并行只读调查两种扩展/IDM 本机安装/Session 隔离；接口资格探针只运行合成扩展，
  独立 profile/session、网络拒绝、单场 30 秒，不运行真实插件或安装器、不触真实浏览器 profile。
  工具放 `tools/extensions-qualification/`，原件在 `log/extensions-three-20261013/`。
- ACCEPTANCE / STOP：安装须以指定插件的实际功能、持久化与隔离验收为准，不能仅凭 loadExtension 成功。
  若关键原生 API 缺失，或接入必须改变共享登录/任务隔离/浏览器交互，先形成具体替代方案与影响，
  请求必要的产品裁决；不以无限兼容层、宽泛宿主权限或无诊断重试规避。当前没有宣称三插件可用。
- 当前资格证据：`capabilities-82f351a8-31dd-4c47-bb41-8465aa8d61e0/result.json` 为真实
  Electron 43.7.7 / Chromium 150 的合成 MV3 扩展页与后台 Service Worker 观察，两处结果一致；
  单场正常退出、未超时、0 网络请求、0 Provider。`tabs.create`、`windows.create/getCurrent`、
  `contextMenus.create`、`downloads.download`、`cookies.getAll`、`permissions.contains/request`、
  `webNavigation.onCommitted`、`proxy.settings.get` 均 undefined；下载、菜单、Cookie、导航、代理权限
  另有原生 unknown 警告。`runtime.connectNative/sendNativeMessage`、offscreen、scripting、DNR、
  storage.sync 有函数入口，但未调用业务操作，不能据此宣称宿主连接或这些能力可用。
  `userScripts` 亦 undefined；Chrome 的扩展用户脚本开关可能影响可见性，尚不能仅凭此判定内核未实现。
  工具 SHA256 `b1322b0ff029615f0ea6855571dafb0efa474e623e573b9ddfa74e1fb0c5ec26`，
  工具格式/lint 通过；第三方真实包均未执行，不把静态依赖分析或合成装载等同插件业务验收。
- 官方包静态取样：Tampermonkey 5.5.1 / MV3 实际依赖 userScripts、Cookie、创建标签等；
  沉浸式翻译 1.33.3 / MV3 设置/关于/打开链接/PDF 路径实际调用缺失的 tabs.create，
  菜单存在性有保护，不据此断言基础网页翻译必定失败。翻译官方 ZIP CDN 直连与代理均 403 原件保留，
  单次改用官方商店对应 Google CRX 端点成功；包、manifest 与摘要在 `official-static/`。
  本机 IDM 存在，IDMGCExt.crx 为 6.43.1 / MV3，原版使用上述部分缺失接口；nativeMessaging
  入口存在而宿主握手 NOTRUN。`idm/static-inspection.json` 保存安装版本、宿主允许扩展 ID 和包摘要；
  未改注册表/宿主允许列表、未执行 IDM、未接触浏览器真实 profile。
- 隔离方案调查：现有用户/Research/Watch Tab 使用同一 `persist:aibrowse`，taskOwned 只是应用字段；
  Electron Session 级原版扩展不识别它，公开接口未提供逐 WebContents 禁用扩展的承诺。
  候选方案保留原会话，新增有标识的持久插件区，Cookie/网站存储独立，不自动复制登录数据；
  可保持相同窗口和标签操作，但需要在插件区单独登录。此为产品体验取舍，已向用户解释并请求选择，
  当前尚未接受；独立区本身不消除 Chrome API 兼容缺口。
  后续有界核查覆盖现成扩展兼容库及 userScripts 开关；未安装新依赖、未实施插件区或修改产品源码。
- 后续源码资格：精确 Electron v43.7.7 的
  [ElectronMessagingDelegate](https://raw.githubusercontent.com/electron/electron/v43.7.7/shell/browser/extensions/electron_messaging_delegate.cc)
  将 native host 固定判为 DISALLOW，接收器返回 nullptr；因此原生方法存在仍不能直接连接 IDM，
  这补充解释了前述探针的观测边界，未执行真实宿主握手。
  已静态核查上游 electron-browser-shell 提交 `354b0b8192e8c2d960e50cf108b5dbbb70448fec`：
  electron-chrome-extensions 可补部分 tabs/windows/menu/cookies/navigation，但 downloads 全为 noop、
  无 userScripts；权限撤销占位、Cookie 权限/来源绑定不完整，native 消息存在 UTF-8 长度与分帧缺口。
  不作为可直接采用的兼容方案。npm 4.9.0 与该最新源码不能视为同一候选；原件在 `official-static/ece-*`。
  未增加依赖或运行该库，普通网页/SW 可否到达其 IPC 仍须反例验证，不把静态疑点写成已证实攻击。
- userScripts 源码边界：Electron 创建 Chromium UserScriptManager，每扩展偏好
  `user_scripts_enabled` 默认 false；但公开 Extensions API 未发现开关，且
  `dynamic_user_scripts_store()` 返回 nullptr，不能推定注册/跨重启兼容。
  若继续此路线，先核实内部偏好层级，再用全新临时 profile 固定 ID 合成扩展做一次 false/true 对照，
  验证真实注册、执行、撤销及任务 Session 无注入；不猜键或枚举开关，不触真实用户偏好。
  此内部格式路线仍仅为候选，探针 NOTRUN；原生方法缺省不可见不能扩大成内核绝对不可实现。

## 外观、标签分组与脚本插件（2026-10-13）

- TASK / BASELINE：用户截图指出外观选项不可读，并要求标签分组、插件及油猴脚本；随后明确
  “两者都需要，先完成油猴脚本支持”。接管干净 `6ccbef2216977b78affdd76695654b557280a5ff`，output 为 0.1.8。
- GOAL / SOURCES：修复主题选择可读性，交付完整的会话内标签分组和有明确兼容范围的用户脚本管理；
  用户进一步裁决保持研究/监控隔离、先交付脚本，Chrome 扩展另做隔离方案，不在本轮安装执行。
  需求、设计与安全差量见 `doc/design/browser-groups-userscripts.md`。
- INVARIANTS / NON-GOALS：保持既有主题、任务 Tab 所有权、安全隔离、数据语义、权限与工具数量；
  不自动恢复标签、不自动下载脚本、不触真实 profile/凭据，不公开发布或自动更新。
- PLAN / SCOPE：并行修复外观、实现分组核心、核查脚本能力；主协调负责 UI/IPC 装配与合同。
  脚本安全/持久化独立审核。先聚焦反例及真实 Electron，再集成质量与包验证，审核后正常提交/双远程同步。
- ACCEPTANCE / STOP：分组操作可用、深浅主题可读、脚本真实运行且越权路径拒绝，兼容限制可见；
  新独审通过后更新本地 output 并保留旧包。两轮无新增证据即换路，影响产品承诺的兼容取舍需集中裁决。
  原件统一 `log/browser-groups-userscripts-20261013/`，不改写旧失败、unknown 或 NOTRUN。
- 实现与聚焦证据：外观原生下拉已替换为三项应用内单选卡片；标签分组完成会话内创建、重命名、六色、
  加入/移出、折叠/展开及取消，任务 Tab 不可编辑，旧状态缺字段时退化为原标签顺序；用户脚本按正式
  白名单完成导入确认、存储、启停/删除、匹配与隔离执行。集成首轮发现 IPC 闭合校验接纳 symbol 字段，
  修复后 4 文件 16 项通过；renderer 分组/竞态/UI 回归 5 文件 60 项、脚本异步 UI 5 项通过。
- 独立安全复核新增四个反例并保留红态：同 URL 新旧 document 的迟到 prepare 会占用新文档执行机会；
  用户合法 strict 源码声明 `GM`、`GM_info` 或 `GM_addStyle` 会与包装器绑定冲突。前者增加文档 epoch
  与 token 校验，较新批次可替换未执行的旧准备状态，迟到旧批次不能覆盖；后者改为外层闭包参数注入、
  内层保留用户声明及 strict 指令；修后脚本专项 4 文件 82 项、分组与 IPC 专项 8 文件 78 项通过。
  这些聚焦绿态不代替真实运行、全量或最终独审。
- 真实运行第一轮 `runtime-35856117-4cd7-4ea9-88a4-76c13727f456` 已通过分组编辑、折叠活动页、
  UI 重载保留与取消分组不关页，随后在浅色外观说明文字对比门失败并正常退出，报告未产生具体对比数值。
  旧 CSS 的独立复算值为 4.372，已调整说明文字颜色；该复算不是原运行报告数值，也不把第一轮改判通过。
- 第二轮 `runtime-5d76a190-846a-4104-9a71-ab008c8defa8` 再次通过分组，并通过浅色、深色、跟随系统三主题
  的选中数、几何与对比检查；脚本导航被验收工具 resolver 错误拦截本地 `127.0.0.1`，Chromium 返回
  `ERR_NAME_NOT_RESOLVED (-105)`，最终 marker 超时。工具随后修复该本地解析分支；不能据此
  宣称脚本真实执行或整场 PASS。两轮均使用隔离 profile、Provider 零调用，原 FAIL 全部保留。
- 运行工具首帧曾看到会话保存失败提示；核对为既有主进程 service 尚未组装时 renderer 请求命中 fallback，
  当时没有会话写入。新运行准备改为等待 store ready 且该提示消失后再继续；这不是数据损坏证据，也不记为
  产品缺陷已修复。
- 全量 `full-tests-01.txt` 实际 7356 PASS / 4 FAIL / 3 SKIP、exit1，保留原件。其中 3 项为两个既有
  存储文件的 5 秒超时，原因 unknown；原断言/原默认时限单独复验两个完整文件 50 项通过，原全量不改判。
  第四项为 SQL 静态扫描把两处正则 `.exec` 误归 SQL；改为同一无 g 正则的字符串 `.match`，不增加扫描豁免，
  元数据与扫描器 64 项通过。主矩阵去重组合 7360 PASS / 3 SKIP，并非全量命令通过。
- 独审另发现非发行 SMOKE_MODE 原会读取正式脚本根，已建立真实装配四组合反例并改用隔离 SMOKE_AI_DATA_DIR；
  红态 19 PASS / 1 FAIL，修后 20 PASS，新增 4 项不混入上述原主矩阵计数。正常与发行数据根不变，
  AI 初始化不清理脚本目录，冒烟退出在浏览器关闭后清理。独立增量复验 5 文件 90 PASS。
- 第三轮 `runtime-710f185e-86e2-4259-8332-b9e18658770e` 本地页面请求成功，但脚本 marker 未执行，整场 FAIL。
  为识别真实 API 时序，增加只读原生事件与执行结果观察，诊断第四轮
  `runtime-8e0cd110-37a7-48af-b957-f2b7477c765a` 精确记录 `did-finish-load` 时 loadingMainFrame=true，
  随后 `did-stop-loading` 时为 false，且没有隔离执行调用；定位为产品提前锁定文档批次后被 loading 门跳过。
  两场各 1 次本地请求、0 Provider，源码/工具/构建绑定不变，原 FAIL 保留；不是无诊断重跑。
- typecheck/lint/format/普通 build 最终组合当时均 exit0（`quality-final.json`）；上述新发现需受影响回归与重建。
- 加载时序修复保持同文档 finish 与停止加载双条件，红 15 PASS / 2 FAIL，修后 runtime 17 项加独审 4 项
  共 21 PASS；typecheck、增量 lint、普通 build 再次 exit0（`quality-final-02.json`），独立复跑 21 项 PASS。
  最终 `runtime-978af2ff-4c2d-4146-b283-34c108836aa4` 两进程均 exit0/自然退出，真实分组、UI 重载、三主题、
  脚本匹配/排除、启停/删除、网页全局与宿主能力隔离、不支持权限拒绝、重启后启停状态与执行均 PASS。
  源码/工具/构建绑定一致，7/20 次本地请求、0 Provider/外网；8 张写入期与1张重启截图保留。
  原生文件选择/确认由受控替身驱动；物理输入、打包启动、安装器执行 NOTRUN，任务 Tab 隔离由核心测试覆盖。
  Chrome 扩展按用户裁决另做任务页隔离方案，本轮不安装 Tampermonkey 本体或开放 Chrome 扩展。
- 独立产品审核 PASS：`review-final.json`，SHA256 `dfd6c62731ac584c66370ad76c5b58c72dc64e436b8fb68c8998464e1d8e887f`。
  独立核验 718 个运行绑定文件、9 张截图，当前范围无未关闭产品缺陷；旧 FAIL 不改判，既有启动期状态提示
  仍保留观察边界。浏览数据 toast 对应原有 service 尚未组装时的 unavailable fallback（相关路径相对 baseline
  零差量），本场未独立记录该 status 的完整时序，不据此声称数据失败或已修复。主窗口截图不证明子网页画布
  已呈现，脚本执行事实来自生产原生隔离调用结果与远程 WebContents 的实际 DOM 读取。
- 产品提交 `9c807663c41c2f9c4a95868586981619fd0a845b` 干净构建 0.1.9；普通程序、EXE/MSI 安装器、
  静态安全/源码绑定校验与独立包身份审核 PASS。`package-review.json` SHA256
  `1de766e51fe03984204b335b9fb2ac2697dd2f9189a986afefaa69144813267f`；包清单初次仅排序比较失败，
  已保留并定位 ASCII 与 localeCompare(en) 差异，按唯一 path 全记录比较一致，不是产物差异。
  本轮普通运行不代替打包启动、安装器执行或物理输入，三者保持 NOTRUN。
- 选择清单 SHA256 `466108129b3d17861eb439045e60fbaa18da5a57d8a187aae4226b859cc82224`；
  CheckOnly/Switch 及最终全字节复核 PASS，新旧均 79 文件，选定 `output/` 为 0.1.9，source 绑定上述产品提交。
  旧 0.1.8 全字节保存在 `log/browser-groups-userscripts-20261013/previous-output-32ff43813ad447948faea81d841b5824/`。
  旧 release 中间目录另外保留 80 文件。最终仅同步本节、progress 与正式工程诊断契约，不改变已审产品或包字节；
  后续按已授权流程正常双远程同步，不公开发布，不启动 Chrome 扩展实现。

## 应用图标调研、设计与更新（2026-10-13）

- TASK / BASELINE：用户要求先了解至少20款同类应用logo，再设计并更新AIbrowse图标；接管干净
  `28ab54cb07acc8960c3a7ff9772f10fd770263d3`，output为0.1.7。
- GOAL / SCOPE：调研浏览器、AI信息检索与阅读整理应用的官方标识，记录视觉来源及可借鉴原则；
  设计原创图标并更新受控资产、图标构建工具及Windows应用/托盘/安装器共用入口，交付0.1.8。
  正式设计与来源在`doc/design/icon-study-20261013.md`；第三方logo仅作研究，不进入产品资产。
- INVARIANTS / NON-GOALS：不改变浏览器、Watch或托盘运行语义、权限、持久化、用户数据、安装升级策略；
  不新增自启、网络能力或Stage8功能。生成图保留项目内母版，ICO只做确定性缩放和格式封装，保持透明背景。
- PLAN / VALIDATION：先完成至少20款视觉调研，再生成并检查原创标识；检查16/20/24/32/48/64/128/256尺寸
  在浅深背景的辨识度、透明通道、ICO结构与可复现转换。复用未变功能的既有验证，聚焦构建/包白名单/图标加载
  和实际PE/ASAR/安装器资源。仅隔离探针，不触真实profile、不执行安装器；未实测项目如实保留NOTRUN。
- ACCEPTANCE / STOP：调研数量/来源可核、新图标实际进入各交付入口、必要检查和包独审通过后可回退更新output；
  原0.1.7全部字节保留。生成最多三次有明确目的的候选/修正；两轮无改善即调整设计方向，不反复无界生成。
  运行原件在`log/icon-design-20261013/`，工具源码纳入Git；审核后正常提交及双远程推送，不公开发布。
- 设计与首轮检查：22款资料交叉核对完成，研究方法及未直接目视第三方像素的边界见正式设计。
  三次内置image_gen生成中，首轮b因品牌近似放弃，第二轮A形态保留，第三轮清理底板残影后选定。
  8档实际ICO在浅深底的1:1预览及独立视觉审核通过，母版保持原始PNG字节。
- 构建修复：首次Replace/Check均0，但独立Check及根后续Check失败，原件保留。独立逐像素比较确认
  8帧RGBA全部相同，差异仅pHYs密度144/96dpi及CRC，共64字节；System.Drawing默认DPI受宿主影响。
  修订转换约定为显式96dpi，新增固定密度检查；不修改母版、不改变图案、不以视觉相同掩盖原确定性FAIL。
  发行构建增加`verify:icon`以拒绝母版与派生ICO脱节；未变产品运行测试复用上一轮适用证据。
- DPI修复结果：源/目标位图显式96dpi且源复制使用像素单位；23项工具检查通过，包含同像素96/144dpi母版
  得到相同ICO和8帧固定pHYs3779。两个隔离进程及根重建得到同一`3385472596f1d14cb8345208d6d4837f4cf3fe9864aab3ab6e90871a1ab91ecb`，
  实际`-Check`通过，修后`preview-02`保留；原母版SHA`1421abd6914eb1afb380a3c4e272036f4108c60026017bc836ae050e29e77c01`不变。
- 候选资格：独立重跑23项及真实母版Check通过，额外8项ICO解析反例拒绝；视觉/转换和包图标工具分别
  见`review-asset-02.json`、`review-package-tools.json` PASS。发行相关3文件30测试、typecheck/lint/format均0。
  旧0.1.7可行性检查中NSIS重编码部分图标帧，静态报告中的renderValidationRequired必须由同组文件摘要的native逐帧像素相等关闭，
  不把静态passed单独当最终通过；MSI只读检查完整Icon流、ARP及两快捷方式引用。产品源码未改，不重复上一轮功能全量。
  旧release完整80文件/619978775字节已按固定路径归档，manifest仍绑定已知0.1.7。
- 发行候选：干净提交`eaab1057904b573539d4f8d78b3d9d2fe6f05f97`，产品源码零改动。0.1.8安装器构建、
  verify:release、静态绑定、图标资源检查、provenance及PE比较均0；PE仅资源段及预期图标/版本/ASAR完整性资源变化。
  EXE/NSIS各8帧均与本轮ICO原字节一致；ASAR图标、MSI完整Icon流、ARP和桌面/开始菜单快捷方式引用通过。
  隔离Electron探针验证ASAR实际解码与EXE/NSIS各8帧像素相等，未调用产品入口或安装器。
  独审重跑209模块/15产物静态绑定、图标检查及native探针exit0，`review-package.json` PASS。
  审核首轮静态工具参数顺序错误及直接启动Electron导致管道提前关闭的失败均保留；参数修正和
  Start-Process隐藏等待启动各有一次成功复验，不将工具调用失误误报为产品失败。
- 本地交付：121份证明形成`selection-review.json`，既有选择工具CheckOnly/Switch均0，
  切换ID`e3c3864124b04283ab64848e8e28c09f`。output为0.1.8、79文件/620805410字节，
  manifest SHA256 `71c5fdb1dfae8032863ca3d6009457bc7c8a4ea70390590b4aae219d5e8f1156`。
  旧0.1.7的79文件/619976007字节完整保存在本轮log同ID的previous-output目录。
  切后`review-output-final.json`独审新旧全树、122份冻结证明（含selection记录）、12源码候选文件及干净HEAD PASS。
  未签名内部候选边界不变；打包产品启动、安装器执行、物理托盘/系统图标缓存观察NOTRUN，未触真实profile。
  本任务完成；后续两份收尾文档不改变eaab105源码包绑定，正常双远程同步，不启动额外产品实现。

## 设置托盘运行与关闭窗口后监控（2026-10-12）

- TASK / BASELINE：用户明确要求设置新增可开启的托盘运行，关闭主窗口后继续监控；接管干净
  `70f2d04f318ae4a930db861440741bd522bd69f2`，接管时选定 output 0.1.6。
- GOAL / NON-GOALS：设置“常规”页增加默认关闭的托盘运行开关；开启后关闭窗口只隐藏，
  托盘可重新打开或显式退出。保留同一窗口、Tab、登录 Session、Watch/Digest 调度实例；
  不新增系统服务、开机自启、退出后运行、自动更新或 Stage8 产品功能。
- SOURCES / INVARIANTS：本条为用户新增产品范围，补充 Stage6 的应用进程存活边界与 Stage7
  生命周期契约；隐藏不触发 shutdown、准入关闭、数据库关闭、Session 授权清除或任务重建。
  显式退出、重启请求及异常退出仍经过既有 stop-admission/abort/drain/guardian 链；退出时不得被托盘拦截。
- DESIGN / SCOPE：主进程独立偏好文件 `app-preferences.json` 只保存 version/runInTray，默认 false，
  有界闭合读取及原子保存，损坏/未来版本保留原件并显示失败。托盘创建成功才允许开启；保存失败
  回滚有效状态；隐藏时关闭功能先恢复窗口，避免失去入口。偏好为机器界面设置，不加入业务备份恢复集合。
  preload 仅暴露 get/setRunInTray，受当前可信主 UI 文档、严格布尔形状和准入约束；网页和模型无新工具。
- PLAN / TEST：模块/持久化/IPC/UI 聚焦反例→类型/lint/格式/build→隔离真实 Electron。
  真实运行每阶段最多180秒、至多一次有诊断修复后的重试，Provider零请求；合成页面请求有界，验证
  关闭前后窗口身份、隐藏期间生产调度及变化事件、托盘恢复、显式退出与跨进程偏好保持。
  合成到期触发只证明生产调度行为，不冒充15分钟墙钟运行。保护真实profile与历史失败原件。
- ACCEPTANCE / STOP：新独立审核覆盖持久化、关闭/退出竞态和真实结果；托盘不可用不得隐藏窗口，
  不以菜单回调或日志字符串代替真实窗口/进程/事件事实。平台能力不成立或两轮无新证据则停止该路线重定方案。
  最终证据统一留 `log/tray-runtime-20261012/`；历史 unknown/NOTRUN 不因本轮改写。
- DELIVERY：按既有当前程序交付约定，将合格候选重建为 Windows x64 内部版 0.1.7，图标作为固定
  ASAR 成员纳入发行白名单及来源绑定。独审后用既有受控选择工具更新 output 并保留完整旧包；
  不执行安装器，不触碰真实数据或凭据，打包启动是否实测单独记载。
- 2026-10-13 验证 REPLAN：两个完整运行均停止且保留 FAIL。首场在初始可见前置条件超时，
  零网络且正常退出，原因 unknown；第二场显式建立可见夹具，已通过设置开启/真实托盘/隐藏及首周期。
  其后工具错误要求两个独立 Event；实际数据库已有两次 finished scheduled、event-created 后
  event-coalesced、同一事件两项 Evidence、Baseline v3，符合 Stage6 §9/§10 的既有去抖语义。
  不进行第三次整场网络试跑；改为只读离线复核已保存的 A→B→C 证据和运行终态，原 FAIL 不改写。
  单独补未执行的原窗口恢复/菜单退出/跨进程启用和禁用：先在该工具唯一隔离规则建立 paused 前置，
  不修改真实用户数据、不追加采集网络，每个补验进程最多180秒、失败即停。此次替换覆盖同一调度与
  生命周期承诺，保留去抖阈值和全部原断言；新的 oracle 明确接纳并核实 event-coalesced 的 typed Evidence。
  工具补正、来源映射及组合结果须经新的独立 Reviewer 核查，启动可见性/物理点击/打包启动仍不冒称通过。
- 分段补验已零网络暂停规则并正常退出，但工具在新建空白 Tab 后立即按 URL 查原生实例，违反
  `createTabInternal` 异步 startLoad 后返回的现有契约，尚未执行隐藏/恢复。此 FAIL 与原工具快照保留；
  改用现有 `getOwnedWebContentsId(tab.id)` 精确所有权观测，不再把文档完成当作实体存在条件。
  仅新增一次独立 `completion-*` 补验：要求原补验错误精确匹配、exit0、networkZero、规则已暂停且
  run 数仍2；原DB/报告/工具摘要保持可复核。各进程180秒，零追加网络，失败后停止本轮运行。
- 结果：全量 `full-tests-01.txt` 实际7235PASS/3FAIL/3SKIP、exit1；失败仅两处旧AST夹具缺新增
  trayController/installTrayController依赖。保留全部原断言并加强准确失败边界后，两文件22PASS；
  新独审同样22PASS，精确组合7238PASS/3SKIP，不重复计入复跑中的19项旧通过。
  `quality-close.json` 的typecheck/lint/format均0，普通build通过，独立聚焦118项及额外6反例通过。
- 运行组合：`runtime-aa89f645-c9a3-49ff-a564-6b071bcf4f7b/second-cycle-replay.json` 与
  独立 `review-coalescence.json` 核两次scheduled、created/coalesced、两组typed pair及Baseline v3；
  `completion-result.json` 三阶段全部exit0，真实原窗口/controller/用户Tab原生对象保持、托盘菜单
  退出、true跨重启、UI禁用后关闭及false再启动关闭均通过；全部正常排水及托盘销毁。
  累计本地页面请求3、补验各层网络计数0、Provider0；browserLibrary最终available，设置启用/禁用截图
  无布局溢出。原首场、第二场和首补验FAIL及其工具/DB原件全部保留；不是原完整场改判通过。
  本轮不证明自动启动可见性、真实长间隔墙钟、物理点击或打包应用启动，不改历史unknown。
- 最终交付（2026-10-13）：产品实现`ce161d5f95035ba6633b62c41ca86e6af10aaa0a`，工具/夹具与契约
  `46269982b3b0c690b730e03fc963739cc4b7ba20`；独立产品审核PASS及668源码/工具恒等映射见
  `review-product.json`、`review-candidate-binding.json`。按干净46269982构建0.1.7，package、verify、
  static、provenance与PE比较均exit0；独立复跑静态绑定209模块/15产物，完整75程序文件及安装器核对通过。
  Electron43.7.7独立探针直接从最终ASAR读取固定图标，14879字节/256×256与来源及渲染摘要恒等；
  该探针不代表打包产品启动。PE差异限定资源节版本/ASAR完整性资源，未宣称整个PE头恒等。
  manifest SHA256 `da3a45dcaa0d433fd022e426fcf49eac618b9e7992c87a1c02c2a55e78b8bcd8`；
  `review-package.json` PASS，`selection-review.json`冻结139份证明；CheckOnly/Switch均exit0，
  切换ID`6865630414904b308ddad5c73f21654d`。output已选中0.1.7，79文件/619976007字节，
  入口`D:\AIbrowse\output\win-unpacked\AIbrowse.exe`，EXE/MSI及两身份文件齐备。
  旧0.1.6的79文件/619937270字节完整保留在本轮log的同ID previous-output目录；切后独审
  `review-output-final.json`核新旧全树、140证明（含审核记录）、668源码及干净HEAD全部PASS。
  当前产品及两安装器均未签名，packageLaunchStatus/installerExecution仍NOTRUN；不触真实profile。
  本任务完成，后续只提交两份收尾文档并正常同步双远程；包的源码绑定仍为46269982，不启动额外产品实现。

## 独立监控真实 Provider 验证、用户数据清空与重新交付（2026-10-12）

- TASK / BASELINE：用户已正常退出应用，明确授权使用新临时 Key 验证、清除本地数据并重新打包；
  接管干净 `a343e4b21425d4bc422588c947887c82baa3c0f8`。上一轮 0.1.6 包独审已 PASS，但因旧程序运行尚未切换，
  output 仍为 0.1.5；旧失败、210 项绑定证据及 packageLaunchStatus=NOTRUN 保留。
- GOAL / SCOPE：在隔离 profile 中复用生产 Provider 验证基本流式响应与独立监控摘要的显式 AI 授权，
  然后清空当前账户 AIbrowse 的应用数据，重建 Windows x64 未签名内部候选并完成 output 选择。
  不重复未受影响的产品测试，不新增监控产品能力，不执行安装器、公开发行或自动更新。
- INVARIANTS：用户 Key 只在调用者内存、单次挑战管道及测试 profile 的生产 DPAPI 容器内存在；不进入
  命令行、环境变量、源码、日志、报告、模型消息或包。完成后删除临时凭据，原始模型正文与 reasoning 不落盘。
  目标固定为当前已配置的 `https://api.deepseek.com/chat/completions` / `deepseek-flash`，
  接口参考 [DeepSeek 官方文档](https://api-docs.deepseek.com/api/create-chat-completion/)，实际结果以本轮请求为准。
- 凭据输入工程修订：内置 Node REPL 拒绝启动器所需的 `node:process`，普通执行会话的 stdin 已关闭，
  两项均为零网络、零凭据输入的准备失败。改用项目 Node 24.18 的受控终端入口：确认 TTY raw mode 无回显后
  将 Key 送到 Node 内存，再沿已审一次性管道传给 Electron；Key 不作为 shell 文本或命令参数。
  已用非秘密占位输入验证无回显；最终原件、父进程 Node 版本及清理事实分别保留。
- TEST / ACCEPTANCE：首批最多 2 次真实请求（基本流式 1、独立监控摘要 1），单请求 60 秒、整场 3 分钟。
  未开启和其它摘要计划零请求、Source/FTS/usage/journal 恒等、默认目标共享状态不扩大；成功须同时具备
  有效服务结果、流式终态、严格摘要校验、正常退出及凭据清除，HTTP 200 不单独算通过。
  鉴权/余额/限流失败立即停止后继请求；同路线两次无新增证据即换路，追加网络预算须先记录具体诊断目的。
- DATA RESET：用户授权覆盖当前 AIbrowse 会话、Sources、Research、Watch、历史书签、Cookie、缓存、
  Provider 配置及凭据；不清空项目源码、测试证据或其它应用数据。先核逻辑与 native 实体根及各子项映射，
  仅对已确认的绝对应用目录操作，应用/guardian 退出与边界核验均须成立；不依据旧外部 SQLite 错误修库。
  不读取业务正文，不保留未说明的用户数据备份；只留无正文的路径身份、数量与清空结果证据。
- PLAN / COMPLETION：主协调持有临时 Key 并执行请求、清空和交付；Worker 分别维护隔离验证工具和清空工具；
  独立 Reviewer 核安全/隐私与实际证据。清空完成并核空态、临时凭据清除、最终包全树/来源独审通过后更新 output，
  完整保留旧程序文件；正文或凭据不得进入包。产品启动是否实测另记，不把清空或静态绑定冒称运行通过。
- 真实 Provider 已完成：`log/real-provider-20261012/campaign-34e9b1c4-2f58-4b65-acab-1511b90e4b77/`
  精确 2 请求，基础流式与独立 Watch 授权摘要均 200、done、无错误；仅选中事件进入摘要，未开启计划零调用，
  Sources/FTS/usage/journal、事件事实和目标默认共享状态恒等。父子进程均通过且 exit0，整场 4840ms；
  两个凭据路径已不存在，扫描 10 文件/1527819 字节/0 明文命中。源码、bundle、Electron 与实际结果独审 PASS，
  见 `log/watch-live-reset-20261012/provider-result-independent.json`。此次不测试真实 YouTube 或打包程序启动。
- 清空工程修订：首场 `log/authorized-profile-inspect-20261012-04/reset-85c900fb16bb4eb9abe87ca3ef83d397/`
  在逻辑目录删除返回后发现目录身份变化，按门停止；native 视图已不存在，逻辑路径显露其原底层目录，
  剩 101 文件/17878345 字节。旧失败及元数据保留，不声称清空成功。续清仍只覆盖原两个授权绝对根，
  允许重新 Inspect 一个根已不存在的状态；剩余根与全部成员须重新核定身份、最终路径、链接与进程边界。
  新计划之后的身份变化仍拒绝，不放宽旧比较，不以原计划直接重试；不读取正文、不新增备份或清理范围。
- 续清结果：独立复跑 16 项合成测试通过，Inspect05 精确新计划通过独审；实际续清 exit0，
  `log/authorized-profile-inspect-20261012-05/reset-e5e2c5ed6eac4eca8ff29102b72949ff/result.json`
  两个应用根均不存在、文件/目录/字节均为 0；未读取业务正文，未创建用户数据备份。首场部分删除如实保留。
  本轮最终 typecheck、lint、format:check 均 exit0；Provider 工具 13 项与清空工具 16 项独立验证通过。
  工具、合同与实际证据审核后生成干净源码候选，再重建安装器并核完整树；旧 release 80 文件已逐项归档，
  output 旧 0.1.5 尚未替换，最终选择另记录。
- 最终交付：工具与合同提交 `442a59a804f40b723978ea4c65f0d67d2fd687f6`，干净源码重建 0.1.6；
  package、verify、static、provenance 与 PE 比较均 exit0。独立核 207 模块/15 产物、75 个程序文件及完整安装器，
  light 104159.9353ms、makensis 3514.7036ms。相对上一已审 0.1.6 唯一代码字节差异为 BUILD_ID，
  Runtime02 的 358 绑定及真实 Provider 的 121 来源保持恒等，未重开未受影响测试。
  manifest SHA256 `46aba55416de2aad1d114ba226572162731864669876e89a3b641572bc095346`，
  新包独审 PASS 及 307 条冻结证明见 `log/watch-live-reset-20261012/selection-review.json`。
  CheckOnly 与 Switch 均 exit0，切换 ID `12fcae9557a04e23b5d47f6f7d163aa9`；output 已选中 0.1.6，
  共 79 文件/619937270 字节，入口 `D:\AIbrowse\output\win-unpacked\AIbrowse.exe`，EXE/MSI 安装器及身份文件齐备。
  原 0.1.5 的完整 79 文件保留在本轮 log 的同 ID `previous-output` 目录，不包含被清空的用户数据备份。
  本轮不执行安装器、打包启动或真实 YouTube 场景，packageLaunchStatus=NOTRUN，应用数据保持空态。
  切后独立复核新旧各 79 文件、308 项证明（含审核记录）、manifest 与两个 profile 空态通过；
  最后工作区检查发生在收尾文档编辑期间，仅两份任务文档改变，不影响构建时干净源码绑定，原检查记录保留。
  本任务完成，仅以文档收尾提交同步双远程，不启动额外产品工作。

## 独立监控目标与采集提示修复合同（2026-10-12）

- TASK / BASELINE：用户先要求定位监控预览失败和采集红字，后明确监控不得依赖标记信源、默认不影响 AI 搜寻，
  并授权继续实现、验证、更新本地程序。接管 HEAD `838478046c406ba92a6d01d3978c4f5bcb70cce1`，工作区干净；
  现有 0.1.5 包绑定 `d37e6276645b7064d6e8b744890ad931a5ab6dac`，其后只有文档差量。
- GOAL：新监控直接接受 URL 或当前页；从信源进入时只复制定位信息，不自动新增或修改信源、不写 AI 选源/检索/usage。
  含 iframe 的主文档可在完整采集证据成立时监控；采集边界、上下文裁剪和实际失败分级显示；错误提供具体可操作原因。
- FIXED PRODUCT：新监控目标独立保存在 watch.db，默认不向模型共享内容，AI 解释仍须明确开启并通过共享门。
  独立摘要显式开启 AI 时只授权该计划的有界 Event 投影，不改变目标的默认共享标志或其它计划，不改变 AI 搜寻。
  旧 Source 绑定规则、计划、暂停原因和历史 Event/Evidence 保持原语义，不自动脱钩、复活或扩大共享。
  不扩充 17 个 Agent 工具；AI 可说明监控工作区入口，不得把自身无工具说成应用无监控。
- ENGINEERING：watch schema v6 增加独立目标及 typed binding；保留旧 source_id/版本/指纹字段作为兼容 owner 字段，
  用明确 bindingKind 区分真实 Source 与 Watch target，禁止按 UUID 在两个库依次猜测归属。
  预览目标只在有界内存中存在，确认创建时 target/rule/baseline 同事务；恢复校验、生命周期、采集前后 CAS、
  Digest、删除与预算均按绑定类型分流。新目标不作为隐藏 Source 存储。
- SNAPSHOT：保留现有整体 L1 语义，新增由主进程 normalize 派生的主文档完整性标记，页面直接提交同名字段不可信。
  iframe 只说明范围不含子文档，不自动判主文档失败；未完成、丢弃/截断、未知 partial、L2/L3 继续拒绝可信监控投影。
  ContextSource 的展示降级标志表示主文档不完整，普通范围与上下文预算提示保留且不统一使用危险色。
- RED LINES：Public DNS/robots/TLS/重定向、Session 明确授权与精确 locator/世代、任务 Tab 所有权、预算、正文零落盘、
  确定性 Diff/Event 及旧隐私门不变；不因输入体验绕过 IPC 校验，不把未知错误统称安全攻击。
- PLAN / SCOPE：主协调负责正式合同、IPC/UI/装配与交付；两个独立 worker 负责目标存储/生命周期和采集/提示；
  新独立 Reviewer 审查持久化、安全、恢复、共享与并发。按工程规则调度，actual 型号未回显记不可验证。
- TEST / ACCEPTANCE：先保存现实现的甄别红态；覆盖独立目标零 Source 写、重启/旧库迁移/备份恢复、碰撞与跨目标拒绝、
  默认零模型共享、同页面授权、iframe-only 成功及截断/未完成失败；再做 typecheck/lint/format、受影响回归、完整构建
  与隔离真实 Electron 操作。候选 0.1.6 经独审与包身份验证后可回退更新 output，完整保留原 0.1.5。
- STOP / REPLAN：不操作正在运行的真实 profile、不把外部路径视图异常当作产品库损坏；同路线两轮无新增证据即换路。
  新安全/隐私或数据语义取舍集中裁决；本轮不启动其他 Stage8 能力。诊断原件保留在
  `log/watch-diagnosis-20261012-001/`，实现验证在 `log/watch-repair-20261012/`。
- 实现验证：网址 IPC 红态 3 FAIL/10 PASS，补齐独立 page/feed/rule 与严格输入门后含消费绑定回归 20 PASS。
  Snapshot 红态分别 22 FAIL/113 PASS 与脚本 8 FAIL/1 PASS，修后独审 11 文件 315 PASS、独立内存探针 33 断言 PASS；
  探针首轮阈值误设原件保留，生产预算未变。独立目标域已完成原子创建、typed 生命周期/CAS、摘要计划权限与调度同步。
  审查发现 Feed discovery 丢失 owner 和重新预览误用 HTML URL 两项缺陷，修后服务完整链验证通过。
  Watch 全域第二轮 1502 PASS/1 FAIL 是新增测试误把旧硬删 expired 期望为 user-deleted，保持产品旧语义修正后聚焦 94 PASS。
  首轮集成 storage/migration 为 664 PASS/12 FAIL：5 项旧 current schema 夹具已适配 v6，7 项未改文件在并发 I/O 下超时；
  当时负载是观察，不能据此确定历史唯一原因。失败原件 `root-migration-storage-01.txt` 保留，正在独占全量复验，不提高阈值。
- 当前运行证据：`ordinary-build-02` 为普通开发构建；Runtime `runtime-d71ba0e1-e5b9-45d0-8365-16fbf18314c5`
  两进程正常退出，9 次本地请求/0 拒绝/Provider 0，scheduled 自动产生 A→B typed Evidence、manual unchanged 无重复事件，
  复启保留规则/事件/基线；Sources、FTS、usage、change journal 内容摘要恒等，quickAdd 0。
  这是程序化真实 DOM/Session 验证，不代表物理点击、打包启动、真实 YouTube、Public 网络或 15 分钟实等。
  独立换包工具 42+4 项通过，显式任务范围/版本参数保留旧默认与完整新旧树、证明复核、幂等回退门；未因此授实际包通过。
- 最终实现证据：完整运行 `full-tests-01` 实际 7095 PASS/38 FAIL/15 SKIP、exit1；14 失败文件全部来自旧 schema/工具
  夹具或已改名的 UI mock。修复后精确同一 14 文件 `full-failures-repaired` 为 108 PASS/exit0，包含原初始化失败的
  测试及新增断言。原失败保留，不表述为全量命令通过；未受影响通过项复用，经独立 `combined-independent-check.json` 核对无漏项。
  原 7 项存储超时本轮同阈值全部通过，历史唯一原因仍 unknown。新授权/预览风险分别独立 70 与 86 项通过，含重叠不加总。
  v6 每语句迁移失败回滚及旧行默认 Source 绑定通过；Session grant 显式加入主进程 bindingKind，同 ID 跨类型复用拒绝并消耗。
- 工具契约校准：历史 `expected.ts` 哈希原封保留；先验证新表为空及三个 discriminator 列均为 source，再对历史列投影比对。
  A/B/H v5 物理 942553 字节证据保留，v6 精确 950745 字节均已生成确认；逐列反例由 700 增至 708，完整扫描覆盖 16 表。
  runtime 资格的 current schema 改为 1/1/6，历史迁移矩阵由 13 增至 15；容量/时间上限不变，未重跑正式大容量与长时场。
  独立数据工具 37 项与最终失败集合核对 PASS；独立域 282 项及内存 13 反例 PASS，报告在本轮 log。
- 最终普通构建与 Runtime02：`quality-final-exits.json` typecheck/lint/format/build 全 0；
  `runtime-7a9723fe-f90b-4cd8-97d8-94ddb36c8514` 两进程正常退出、14 写入事实/3 复启事实 PASS、源与产物绑定保持，
  两主题顶部误导降级提示消失，iframe 范围说明保留，向导步骤间距可读；四图已视觉复核。
  两轮累计 18 本地请求、4 个自有 Electron 进程、8 截图，Provider 0，真实用户 profile 未操作。
  实现及所需独审已 PASS，下一步只做干净源码发行构建、身份复核及可回退 output 选择。
- 安装器工程差量：源码提交 `d0b95efd388f74f0f52971931ef4ab986af95116` 后首场目录打包通过，
  WiX light 在 120.022 秒被固定超时终止；失败原件 `package-build.txt` 与 scope
  `log/stage7-e5/msi-build-5973f97d42904481b6973bd86ba3fc8f` 及原临时 CAB 保留。
  历史五场成功 light 约 92–110 秒，本场第 58 秒已有 CAB 压缩进展；其后等待原因 unknown。
  仅 light 编译预算改为有界 600 秒，其他命令仍 120 秒，新增每步成功/失败耗时证据；压缩、ICE、
  组件与产品验收门不变。这是构建工程预算调整，不改变用户产品、包内容约束或安全阈值。
  独审后单次复验安装器；已有 payload 按完整树字节复用，产品源与配置未变，运行证据不重写。
  若再次超时，停止同路线重跑并依据 CPU/IO 采样换路，不追加无界时限。

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
  第二次冻结全量7074PASS/1FAIL/3SKIP，488文件为486PASS/1FAIL/1SKIP，622.40秒；
  唯一失败仍是未改凭据预算用例初始化rename EPERM，首轮p37/本轮p14，实际占用者unknown。
  独立原16项单次复验PASS，只将精确同名的1项补齐，其余15项不重复计数，显式组合7075PASS/3SKIP；
  独审批准此适用范围。两次全量仍exit1，不用复验声称历史根因已知，原afterEach删除临时目录的缺口保留。
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
  含两处真实子进程中断、回退幂等和损坏拒绝。资料/UI/工具验证不等于打包启动。

### 0.1.5 交付闭合

- 产品、工具及合同提交`d37e6276645b7064d6e8b744890ad931a5ab6dac`是干净包来源。
  首次安装器命令在已有`installer-build.json`处EEXIST，失败原件保留；将release旧4文件及首轮新2安装器
  按SHA归档到`log/browser-settings-20261012/release-files-before-rebuild-02`后，仅重跑安装器及生成provenance成功。
  未重复已成功的Electron目录构建，也不改写首场失败。verify、206模块/15产物ASAR静态绑定均0。
- 独立复核75个payload文件、安装器和身份文件，PE只有.rsrc中的version/ASAR integrity资源变化；
  不声称所有PE头完全相同。审核`log/browser-library-independent-review-20261012/final-review.md/json`限定PASS。
  PackageSmoke首尝试相对路径被入口拒绝，第二次绝对路径仍在隔离身份校验拒绝，未到产品Runner；
  新journal `log/legacy-followup-20261012/package/journal-9362a7afbf7a4185a8d581a4a0372c08`保留。
  前后原profile FileID/ACL/卷/路径一致，未读原内容；新包启动和安装器执行仍NOTRUN。
- 严格六字段`selection-review.json`绑定347份证明，SHA256
  `15b52fdf148dbb0efeb4f6a30a502927b0b39acffb544da5f0c89ff6c7587984`；独立CheckOnly exit0。
  实际Switch exit0，ID`5869ed9547dd4d89bc8cd031e9385dcc`，348证明（含审核record）切前重验，
  output为0.1.5、79文件/619872825字节，完整程序、EXE/MSI及身份文件齐备。
  manifest SHA256 `c205e19a9e0fc445ac6aac40ce33986bd206edb24da5212e88dffbca85c27e13`。
  旧0.1.4的79文件/619797056字节完整保存在本轮`previous-output-5869ed9547dd4d89bc8cd031e9385dcc`。
- 切后独立`final-output-review.json/md`PASS：完整新旧成员/bytes/hash、347证明与record、已审源码及工具均未变；
  `originalBytesPreserved/passed`均true。最终仅这两份收尾文档变化，不重建未变产品；本轮完成，不启动Stage8。

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

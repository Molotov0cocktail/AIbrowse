# UI 视觉迭代：品牌精修与浅深主题

## 1. 授权与差量实施合同

### TASK / BASELINE / GOAL / NON-GOALS

- TASK：按本次用户要求，先搜索并实际查看至少十款商业软件的真实产品界面，再迭代 AIbrowse 的界面风格；保留现有品牌，提升精致度，同时提供浅色与深色模式。
- BASELINE：`main / fb8d1ab0a1581be5917204088999256b98a233f1`。接管时工作区干净；最近提交为交付目录迁移及日志退役收尾。本轮修改相对于此 SHA 审核，候选与最终提交由实际 Git 记录补充。
- GOAL：在现有灰蓝品牌基础上，以雾灰、白、深石墨色面及蓝色强调建立一致主题；优化浏览器工具栏分组、品牌行、文字层级、控件状态及各应用工作区视觉，使浏览内容保持主位、辅助操作易于识别。
- NON-GOALS：不启动 Stage8，不新增研究/监测能力、模型能力或数据工作流；不改变现有业务 handlers、权限、采集、引用或持久化语义；不引入依赖、外部字体、假数据、默认网络请求或外部宣传图片资产；不公开发布或增加自动更新。
- 已知问题承接：`progress.md` 中固定 FIRST 的 P1 Session Watch Baseline 归属问题及其 REPAIR 结论保持。本次视觉验证不构成该问题修复，不将阶段历史 GO/PASS 扩大为当前产品无缺陷。

### AUTHORITATIVE SOURCES / CURRENT VERIFIED STATE

- 用户本次视觉迭代及浅深模式补充指令为本任务产品授权；`AGENTS.md`、`.agents/skills/project-rules/PROJECT_RULES.md`、`.agents/skills/vibe-coding-workflow/SKILL.md` 为工程规则。
- 能力与安全边界继续引用 `doc/stage7/detailed-design.md`、`doc/stage7/threat-model.md`；各业务工作区继续遵守对应 Stage 正式设计。本文件只记录视觉差量，不复制或替代各业务契约。
- 当前短期状态仍以 `doc/tasks/progress.md` 为唯一入口；实现事实以 Git、代码与机器证据为准。
- 已读 `src/renderer/src/App.tsx`、内容测量及相关样式入口：应用原生网页由 WebContentsView 承载，`useContentBounds` 的 ResizeObserver 上报内容矩形；AI/Sources/Research/诊断侧栏采用 380px 既有模式，结果画布与浏览内容有既有可见性切换。
- 本轮已搜索十款产品，并实际查看十份本地图片；来源、图像性质、五维分析与本地索引见第 2 节。图片视觉观察不等于当前产品版本功能核验，也不据图片反推精确 CSS 字号。
- 已核分支与远程配置：Gitee 与 GitHub 双远程仍为项目正式地址；本合同编写阶段没有进行远程网络操作。

### FIXED DECISIONS / INVARIANTS / RED LINES

产品不变量：

1. 保留 AIbrowse 名称和灰蓝品牌识别，形成浅色、深色两套一致的应用界面；主题不修改远程网页内容、不注入网页样式。
2. 保留浏览器、AI、Sources、Research、Watch、诊断和本地数据入口、现有交互动作、业务校验及信息含义；不以美化隐藏错误、引用、授权提示、运行状态或危险操作区别。
3. 主内容布局仍经现有真实容器测量路径驱动原生视图，380px 右侧宽度保持；打开、关闭面板及改变窗口尺寸后，不发生网页覆盖控件、内容错位或不可达的确认操作。
4. Renderer/网页/模型不新增底层能力；preload、IPC、BrowserController、数据与凭据隔离保持。不得为截图方便放松安全配置。
5. 中文界面与现有语义保持；键盘焦点、选中、禁用、错误、警告和主要动作在两种主题中均可识别，不只靠颜色表达重要状态。

本轮工程选择及等价性：

- 实现 `system / light / dark` 三种主题选择，`system` 跟随系统浅深偏好。三模式是实现双主题和用户偏好控制的工程方案，不引入业务数据模型或新的远程能力。
- 使用统一色彩、边界、文字、间距、圆角和状态变量覆盖应用工作区；浅色以雾灰外壳与白色内容分层，深色以深石墨层次区分面板，蓝色用于主动作与活动态。
- 通过工具栏分组、轻边界和文字层级降低视觉拥挤；不更换 handlers、不改变 380px 及内容测量，因此可以改善视觉同时保持业务与原生浏览能力契约。
- 字体使用本地系统字体栈，保持中文可读性；不加载外部字体、图片或样式。参考产品图片只作研究证据，不进入产品包。
- 主题状态只处理 UI 偏好，本地仅保存白名单外观值 `aibrowse.appearance`；读取或写入失败回退系统。系统外观由 CSS `color-scheme: light dark` 响应，无须新增 JavaScript 系统事件监听，不扩展主进程通用接口。
- 工程方案若不能覆盖双主题、真实原生内容布局或键盘可用性，应修订本合同并更换实现；不得通过放宽现有宽度约定、掩盖溢出或取消关键状态来迁就样式。

### EXPECTED SCOPE / IMPLEMENTATION PLAN

1. 调研十款真实界面，提炼适合当前浏览器、来源管理与研究工作区的视觉语言；不照搬其它产品未授权的功能。
2. 在 renderer 建立主题选择、系统偏好响应及应用级主题变量；调整 App、浏览器工具栏/标签栏/品牌行和相应样式。
3. 统一 AI、Sources、Research、Watch、诊断、本地数据与对话框/表格的浅深状态，保持既有滚动、宽度、可见性和操作链。
4. 对确实新增的主题状态逻辑进行聚焦验证；对样式、内容矩形和工作区切换进行真实 Electron 视觉/交互检查，不为纯颜色映射机械增加镜像测试。
5. 受影响代码范围以 `src/renderer/` 为主；需要的通用截图/验收工具须置于受控 `tools/`。日志、隔离 profile、截图和原始结果留 `log/ui-refresh-20261012/`，不进 Git。超出该范围的必要修改须说明原因及受影响边界。
6. 完成适用复核后由主协调者更新最终证据与进度、执行收尾。当前交付包仍以其构建身份为准，不把源码修改自动声明已进入 `output/`。

### TEST PLAN / ACCEPTANCE

| 验证层       | 计划与判据                                                                                                               | 证据边界                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 静态与构建   | typecheck、lint、变更文件格式检查、renderer 聚焦测试、build；检查差量及敏感信息                                          | 逐项记录实际命令、退出码、范围，不以文档计划代替结果                              |
| 主题状态     | 检查 system/light/dark 选择、系统偏好变化响应、显式模式优先级和既定偏好回退                                              | 只证明 UI 偏好；不扩展为业务持久化或数据恢复结论                                  |
| 真实视觉     | 使用隔离 profile 启动真实 Electron 应用，在 1100px、1280px 窗口宽度下取得浅/深截图；逐图检查布局、文字、留白、边界及状态 | 应用窗口与 renderer-only 图片须区分；未取得原生网页画面不能冒称完整浏览器视觉验收 |
| 壳与主控流程 | 检查工具栏、标签、侧栏开关、主题切换、关键工作区入口、结果/浏览可见性与真实内容矩形；确认主要操作和确认入口仍可达        | 聚焦本轮影响，不声明未执行的 Provider、Watch 采集或全阶段回归通过                 |
| 样式覆盖     | 检查 AI、Sources、Research、Watch、诊断、本地数据及弹层的双主题状态；关注 380px 面板内长中文、空态、表格与焦点           | 空态截图不能证明有数据/错误/在途状态，覆盖差异须明确                              |

完成条件：十产品看图与来源可查；品牌与双主题目标落实；适用静态、聚焦、构建及真实视觉/交互门有证据；不存在本次引入且未处理的遮挡、不可达控件、主题失效或语义变化；复核范围、未执行项与旧缺陷如实保留。

每个新开发 PowerShell 执行安装、测试、构建或启动前，先点调用 `tools/maintenance/enter-project-environment.ps1`；不得借本轮恢复环境修改真实用户 profile 或读取凭据。

### STOP OR REPLAN CONDITIONS

- 内置 Browser bootstrap 已遇到 `node:process` 被禁止，当前无法用于应用检查；不重复碰运气。改用工程自带 Electron 和隔离 profile 获取真实窗口截图及布局观测。该替换覆盖同一实际 UI/原生内容矩形目标，但不能把未执行的 Browser 工具检查写为 PASS。
- 截图路线先取得一份真实应用窗口并核对内容身份，再展开宽度/主题矩阵；若连续两轮无新增证据、原生视图不可观测或截图来源身份不清，停止同路线重试并修订采集方案，保留失败。
- 出现内容矩形错误、确认不可达、状态对比不足或新增主题行为缺陷时，先建立能区分错误实现的反例，再修复与复验受影响范围。
- 若需要改变能力隔离、业务语义、实质性能承诺、固定面板产品行为或接受用户可见风险，暂停相关依赖工作并集中请求产品裁决；继续不依赖裁决的事项。
- 不以当前 P1 的历史存在跳过本轮回归，也不通过本轮视觉成功关闭该 P1；不重开未受影响的高成本阶段矩阵。

## 2. 十款商业软件的真实界面调研

全部图片来自网络图片搜索并已由 `view_image` 实际阅读。下表是视觉观察与设计推论；字号为相对层级，非 CSS 测量。截图年代、宣传背景和标注均单独说明，不宣称每图代表当前最新版。

| 产品            | 配色                                                     | 字号层级                                               | 留白                                           | 组件                                                       | 布局与适用建议                                                                                               |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Arc             | 柔淡蓝紫外壳、低饱和背景，内容面更浅                     | 侧栏文字紧凑，活动项略强化，图标与文字不争主位         | 导航分组留白明显，主画布完整宽阔               | 地址输入、固定站点、纵向标签、底部空间控件、轻圆角         | 窄侧栏与大画布边界清楚；借鉴外壳克制和组间留白，保留 AIbrowse 现有顶部标签与测量路径                         |
| Comet           | 炭黑面、稍亮输入面与细灰边界，青蓝只点亮少数动作         | 助手标题较粗，地址和辅助文字弱化，输入提示较大         | 助手内容区保持开阔，底部输入固定               | 常规浏览器栏、助手标题行、底部 composer、紧凑图标按钮      | 主页面与右助手仅用细线分开；借鉴深色层次及底部输入锚点，不复制低对比文字；图中红框是教程标注                 |
| Microsoft Edge  | 灰白浏览器壳、白助手面板、蓝色活动分段，灰边建议卡       | 助手名称突出，建议与说明较小，顶栏紧凑                 | 主网页最大化，助手区内分组清楚                 | 助手模式标签、分段按钮、建议卡、底部输入、侧边入口         | 网页与助手并列；借鉴右侧辅助层级和输入位置，不把网页背景壁纸当作应用视觉方案                                 |
| Brave           | 灰色浏览器壳、白侧栏、少量紫色 AI 标记                   | AI 标题与图标明确；建议和输入字号接近，辅助工具更弱    | 主内容充分展开，建议胶囊规则排列，底部输入宽松 | 侧栏标题动作、胶囊建议、底部 composer、导航工具栏          | 内容优先且侧栏边界明确；借鉴一致的标题行与动作分组，保持 AIbrowse 的既有功能入口；红箭头/圈为教程标注        |
| Vivaldi         | 红色品牌顶条、深灰工具外壳、白内容面                     | 工具文字很紧凑，内容标题与统计按层级排列               | 主区留白大，工具面板相对密集                   | 窄全局图标栏、工具面板、浏览器标签、主网页                 | 展示窄全局栏＋工具面板＋主区关系；只借鉴主次层次，不复制红色品牌或旧版密度；2016 年历史截图                  |
| Feedly          | 白与深浅灰为底，绿色仅用于主题与信息；外围亮绿是宣传背景 | 页面标题显著加粗，文章标题次级加粗，来源/时间/摘要较弱 | 标题区与文章组之间宽松，文章内部紧凑           | 下划线标签、图文行、浅灰标签、Ask AI、上下文菜单           | 内容列表与 AI 面板并列；适合共读场景的上下文可见性和面板边界，不把外部宣传渐变植入产品                       |
| Inoreader       | 深蓝全局栏、白色内容、蓝活动态与浅灰边                   | 卡片标题粗体，来源/时间较小，工具栏紧凑                | 卡片规则间距，图片占主要面积，目录树紧凑       | 全局图标栏、文件夹树、未读分段、搜索、卡片操作             | 全局导航＋来源树＋主区清晰；借鉴 Sources 分层，研究证据与监测记录继续保持适当文字密度                        |
| Readwise Reader | 深蓝黑底、灰蓝选中行、亮蓝细线和低饱和标签               | 标题最强，摘要次之，作者/时间/日期更弱，侧栏小分组标题 | 主列表横向展开，属性组间留白明显               | Inbox/Later/Archive、选中行、进度细线、Info/Notebook/Links | 列表＋右侧属性检查适合 Sources 与引用详情；借鉴明确选中状态，提高弱文字对比；2021 年官方历史图，带移动端叠图 |
| Notion          | 暖灰导航、白画布、近黑文字，柔和状态色与蓝主按钮         | 大标题建立页面身份，导航/卡片正文统一，分组名弱化      | 标题留白明显，侧栏分组明确，卡片内部宽松       | 顶栏、分组侧栏、视图标签、状态胶囊、轻边卡片、工具栏       | 借鉴中性色底层、轻边界、一致状态样式；不新增看板或过度扩大标题空白                                           |
| Elicit          | 白与极浅灰为主，深青灰文字，淡青来源状态条               | 主要通过粗体/颜色区分，文字总体偏小且密集              | 单元格随内容增高，横向间距节制，聊天分组更宽松 | 可配置列、行选择、来源状态、排序/过滤、引用、聊天输入      | 证据表与解释面板并列适合 Research；保留可辨引用和数据边界，中文正文需更清楚，不能照搬微小字密度              |

综合选择：使用 Notion 的中性底层与轻边界、Arc 的外壳留白、Comet 的深色层次、Edge/Brave/Feedly 的右侧助手组织、Readwise 的列表检查方式、Inoreader 的信息层级及 Elicit 的证据结构。它们指导统一视觉；不移植产品运行时功能或扩大本次范围。

### 2.1 来源与本地证据索引

本地参考目录：`D:/AIbrowse/log/ui-refresh-20261012/references/`。原图片只留本地、排除 Git；以下来源 URL 为公开研究索引。

1. **Arc**
   - 来源：[Arc Browser review](https://www.appsntips.com/home/arc-browser-review-top-features/)。
   - 原图：[profiles and spaces](https://storage.ghost.io/c/79/45/794539e9-2a02-4255-8c35-d208fe7cbac5/content/images/2023/03/arc-brower-profiles-and-spaces.jpg)。
   - 本地：`log/ui-refresh-20261012/references/arc.jpg`。
2. **Comet**
   - 来源：[Comet 设置与使用指南](https://aitoolsclub.com/how-to-set-up-and-use-perplexity-comet-ai-browser-step-by-step-guide/)。
   - 原图：[Comet 助手界面](https://storage.ghost.io/c/71/a2/71a292cc-6628-490c-8b4c-3e5a55b86af8/content/images/2025/09/data-src-image-95bb8cfa-309a-4029-b40c-05ca9a729b4d.png)。
   - 本地：`log/ui-refresh-20261012/references/comet.png`。原先另一 analytics 图片返回 HTTP 410，未纳入十图计数，不把失效链接计作已看图。
3. **Microsoft Edge**
   - 来源：[Microsoft 官方 Copilot in Edge 文档](https://learn.microsoft.com/en-us/copilot/edge)。
   - 原图：[Copilot Edge sidebar](https://learn.microsoft.com/en-us/copilot/media/copilot/copilot-edge-sidebar-800x472.png)。
   - 本地：`log/ui-refresh-20261012/references/edge.png`。
4. **Brave**
   - 来源：[Brave 官方 AI Browsing 帮助](https://support.brave.app/hc/ja/articles/41240379376909-How-do-I-use-AI-Browsing-in-Brave)。
   - 原图：[AI Browsing 侧栏](https://support.brave.app/hc/article_attachments/41964865234317)。
   - 本地：`log/ui-refresh-20261012/references/brave.png`。
5. **Vivaldi**
   - 来源：[Vivaldi 官方 Web Panels 文章](https://vivaldi.com/blog/using-web-panels-for-social-media/)。
   - 原图：[Instagram Web Panel](https://vivaldi.com/wp-content/uploads/2016/11/Insta_Web-Panel.png)。
   - 本地：`log/ui-refresh-20261012/references/vivaldi.png`。
6. **Feedly**
   - 来源：[Feedly 官方 Changelog](https://feedly.com/changelog)。
   - 原图：[AI Feed 与 Ask AI](https://cms-cdn.feedly.com/images/gw4l4nkb/production/1dbd0fc95aee205600d1c354154b34462682634f-2000x1250.png?auto=format&fit=max&w=3840)。
   - 本地：`log/ui-refresh-20261012/references/feedly.png`。
7. **Inoreader**
   - 来源：[Inoreader 官方产品页](https://www.inoreader.com/zh-hans/)。
   - 原图：[桌面 Feeds 视图](https://www.inoreader.com/images/landing/v4/hero/hero-desktop-1x.webp)。
   - 本地：`log/ui-refresh-20261012/references/inoreader.webp`。
8. **Readwise Reader**
   - 来源：[Readwise 官方 reading app 介绍](https://blog.readwise.io/readwise-reading-app/)。
   - 原图：[Reader Inbox](https://s3.amazonaws.com/readwiseio/2021/09/readwise-reading-app-inbox-1-1.png)。
   - 本地：`log/ui-refresh-20261012/references/readwise-reader.png`。
9. **Notion**
   - 来源：[Notion 官方桌面产品页](https://www.notion.com/it/desktop)。
   - 原图：[Ramp HQ 桌面界面](https://www.notion.com/front-static/pages/download/notion/desktop.jpg)。
   - 本地：`log/ui-refresh-20261012/references/notion.jpg`。
10. **Elicit**
    - 来源：[Elicit 官方 Find Papers 界面发布](https://x.com/elicitorg/status/1978446795295555832)。
    - 原图：[研究证据表与总结](https://pbs.twimg.com/media/G3Ta3obbYAAU9re.jpg)。
    - 本地：`log/ui-refresh-20261012/references/elicit.jpg`。

## 3. 应用到 AIbrowse 的视觉规范

| 用途              | 浅色                  | 深色                  |
| ----------------- | --------------------- | --------------------- |
| 应用外壳/页面底色 | `#f4f5f8`             | `#171a20`             |
| 内容面/卡片       | `#ffffff`             | `#20242c`             |
| 抬高层/悬浮内容   | `#ffffff`             | `#282d37`             |
| 主文字            | `#222b3d`             | `#e7ebf2`             |
| 次要文字          | `#647086`             | `#a4afc2`             |
| 品牌文字与焦点    | `#3d5faa`             | `#a9c1ff`             |
| 主按钮/按钮文字   | `#3d5faa` / `#ffffff` | `#86a6f1` / `#111b32` |
| 选中浅底          | `#eaf0fd`             | `#2b3854`             |
| 细边框            | `#e0e4eb`             | `#353c48`             |
| 错误文字          | `#b73540`             | `#ff9ca5`             |
| 警告文字          | `#855911`             | `#edc478`             |
| 成功文字          | `#27734c`             | `#8dd8af`             |

- 字体：本地 Segoe UI Variable / Segoe UI / Microsoft YaHei 系统栈。页面标题 24–28px，指标 32px；面板标题 16px，引导标题 19px，正文 13–14px，元信息 11–12px。正文行高 1.55–1.8，标题以 600/650 字重建立层级，不给每个字段加粗。
- 留白：以 4px 为基础，控件间 8/12px，面板内边距 16px，独立块 20/24px，监控画布 24/32px；密集元信息保持 6px 小间距。可滚内容区保留 min-height/min-width 边界。
- 组件：18px/1.7 描边本地图标；按钮 6–8px 圆角、输入与条目 8–12px、对话框 16px；普通卡片只使用极浅阴影和一条细边。危险操作继续使用明确文案和语义色，L2“拒绝”仍为默认焦点和强调按钮。
- 布局：品牌与外观设置位于顶行；网页导航、地址、页面操作、业务入口分组；标签单独一行。内容为主、380px 辅助面板停靠；AI 模式独立一行，Source 标题与操作分层；Watch 标题/视图导航/指标/引导分块，1100px 时指标转两列。研究证据表和结果卡片仍在主画布。
- 长内容：L2 确认框限制为视口减 48px，正文独立滚动，标题和操作行不压缩；数据风险说明、URL、引用和错误文案不因美化删除。主题不改变远程网页。

## 4. FINAL EVIDENCE

- 实现范围：`src/renderer/src/` 应用壳、Toolbar、本地图标/外观选择、AI 空态、Research 引导/结果、Watch 概览/向导及跨模块主题。主进程、preload、业务协议、采集/数据库和确认处理函数未修改；仅新增外观偏好存储。
- 构建与静态：锁文件恢复依赖，Node 24.18.0；`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build` 均 exit 0。首次全量 lint 报新增工具的 CJS 声明及 unused 问题；修复限于工具导入和作用域声明，未关闭产品检查，后续全量通过。格式原件 `log/ui-refresh-20261012/format-check.txt`。
- 聚焦测试：`npx vitest run src/renderer --maxWorkers=1`，17 文件/214 项通过，包含 5 项新增主题解析、专键与存储容错测试。未将纯 CSS 属性写成镜像单元测试。
- 工程截图工具：`tools/ui-visual/` 隔离 profile/session、真实普通构建与原生 WebContentsView，受控原生 select 操作；应用退出与 JSON status 双判定。截图按实际 DPI 保留逻辑尺寸，不能把 150% DPI 的物理像素宽度当作 CSS 宽度失败。
- 正式 UI 运行：`log/ui-refresh-20261012/20261011T184508233Z-2d53c4626102431a9def6a71ed008100/result.json`，SHA256 `c2c244af0a18d0ce7b01decc442fa56e0c4d9ccb0f8efb7906899d01443adbd5`。44 PNG + 44 同名 JSON，0 failure、正常 `app.quit`；40 个真实应用空态/设置/监控/本地数据场景，另 4 个明确标识的合成长 L2 布局压力场景。
- 覆盖浅深 × 1280×800/1100×760、AI/Sources/Research 380px、原生网页矩形匹配、文档整体无双轴溢出、展开本地数据、主题重载保持；`nativeTheme` 切换确认系统外观响应和显式模式优先，结束恢复 `system`。对比度检查是正文样本，不宣称完整 WCAG 审计。
- 长 L2 红→绿：红态原件 `20261011T184204761Z-8b86c9a791004e509beef6c7fd2a566d`，40 常规场景通过但 4 个长确认框失败：框高约 2097px，操作按钮出窗且无滚动。修复后框体距视口上下各 24px，正文滚动高度 2028px、可视 623/583px，拒绝/批准均可见，拒绝默认焦点保持。合成场景只证明样式和可达性，不冒充真实工具执行。
- 图片均经实际检查；新的独立 `gpt-6-astra/high` Reviewer 对产品差量、真实截图及红绿确认框给出限定 PASS，实际模型工具未回显，记不可验证。Reviewer 未复跑测试/构建；独核不覆盖未执行的发行、Provider 或 P1 修复。
- 验收准备失败保留：Browser 技能 bootstrap 因禁止导入 `node:process` 不可用；Electron 初始工具入口/环境、进程等待和 stdout `EPIPE` 导致启动失败，均保留原运行目录。最终通过等待 GUI 进程完成及工具应用身份修正，不修改产品启动/安全逻辑。先前“启动路径不匹配”的线索不当作最后异常根因；实际退场异常为工具管道提前关闭。
- 既有默认 production 冒烟：`pwsh -NoProfile -File tools/data-qualification/default-smoke/run.ps1 -Variant production`，实际外层 exit 0、116.604s；`log/stage7-e2/default-smoke-production-fc449c9e89aa4cd5b51c0fc29824dac4/` 中 result/completion 均 passed=true、firstError=null，应用 exit 0，准备/应用/读回 Job 实际归零，ledgerRetired=true。result SHA256 `e0fab716ade1102247d9e184d61f06e9b4d1f385f7b405c16285c9a5a565c19d`。源码、工具与制品绑定终检通过；后续仅将 UI 截图工具的辅助进程窗口设为隐藏，不改变产品或默认冒烟实现，独立复验该工具差量。
- 启动窗口差量复验：`Start-Process -WindowStyle Hidden` 保留 `-Wait`；`log/ui-refresh-20261012/20261011T185246742Z-ce450e5ed85d41bc828a966e88639202/result.json` SHA256 `ff8a79b5047b112e8a70683b9a2d9daab16ef06e12c502bc2a9be92246af1d8f`，脚本 exit 0、44 场景/0 failure、持久化及三项系统主题检查通过，恢复 system 并正常退出。未重新构建，产品与前一通过轮一致。最初错误 appPath 下 `tools/ui-visual/log/aibrowse-2026-10-12.log` 为 190 字节启动短日志，保留且排除 Git。
- NOT RUN：真实 Provider、多网站/长时 Watch、新安装器与安装升级矩阵、阶段重审。本轮不改这些边界；已知 P1 Session Baseline 归属问题仍为 REPAIR。`output/` 的 FIRST 程序与安装器未替换，仍绑定旧源码 `207cdde3cb05550679c612e6e3561aac7a2bf248`；新 UI 已进入本轮普通 `out/` 开发构建，发行身份不能混称当前 Git HEAD。

# 翻译集成：完整功能盘点与替代技术路线

## 1. 本轮合同与证据边界

- 日期：2026-11-07。TASK：实施前完整调查沉浸式翻译，并为未开放的能力准备可行技术路径。
- BASELINE：`7a1afd1261332c7cab7219a0f3cbae552832761e`，接管时工作区干净。
- GOAL：覆盖插件全部可枚举功能域、设置路由、菜单、命令、媒体与在线入口；说明本地/远端依赖、
  替代组件、产品差异、最小验证及停止条件。用户已接受开源模型与自有 API，并要求保留高级体验。
- NON-GOALS：本轮不实现产品、不安装/执行第三方扩展、不调用翻译/会员接口、不读取真实 profile、
  不启动 Stage8、不更换 `output/`。分析工具只处理静态文件，不证明插件兼容或安全审核通过。
- 权威输入：本轮用户指令与五张 1.34.4 设置截图、精确发行包、官方功能文档、现有 AIbrowse 代码。
  旧“取消沉浸式翻译”的决议作为历史保留；本轮重新授权调查，并未恢复原版扩展装载方案。
- 完成条件：功能→证据→依赖→替代路线可追溯；未公开部分明确标记；不以菜单存在或静态字符串证明效果。
  产品实施需沿用本文范围继续形成详细接口和验收合同，不能把高级功能悄悄缩减为普通 API 翻译。

### 1.1 固定审查对象

官方 [v1.34.4 发行包](https://github.com/immersive-translate/immersive-translate/releases/tag/v1.34.4)，
发布于 2026-10-23。调查固定该包，官网是 2026-11-07 的补充参考，不能把后续网页能力算进旧包。

- 包：`log/translation-feasibility-20261107/chrome-immersive-translate-1.34.4.zip`，13,719,303 字节。
- SHA256：`939ab79a01c136c12426eba29fcfd93149bc0bbfad79280554a7e5bd4e25c604`。
- 125 条目＝35 目录＋90 文件；文件为66文本＋24二进制，展开总量44,228,869字节；没有 `.map`。
- 完整逐文件大小/摘要、全部文本原字节、中文文案与格式化配置：
  `log/translation-feasibility-20261107/full-static-final/`，入口 `inventory.json`。
- 受控采集器：`tools/extensions-qualification/inspect-package.ps1`；反例检查见同目录
  `inspect-package.test.ps1`。不加载扩展、不求值 JS/WASM；目录、二进制全部登记，文本全部导出。
- 本文“完整”指客户端所有已发现功能域的覆盖盘点，不是逐行安全证明、WASM 反编译、付费端到端试用、
  后台源码恢复或宣称隐藏/动态功能零遗漏。截图与静态文案也不能确定每个账号的即时权益。

### 1.2 证据索引

下列缩写均指上述固定包内文件，可在静态目录按精确键搜索；压缩文件使用文件＋符号/配置键定位，
不伪造源码行号。所有文件均有 inventory 摘要绑定。

| 索引 | 资源                                                           | 主要覆盖                                       |
| ---- | -------------------------------------------------------------- | ---------------------------------------------- |
| M    | `manifest.json`、`request_modifier_rule.json`                  | 权限、内容注入、命令、后台、网络规则           |
| D    | `default_config.json`、`default_config.content.json`           | 默认行为、服务目录、规则、功能开关、站点清单   |
| L    | `locales.json` 的 `zh-CN`；22种界面语言资源                    | 菜单、子项、提示、条件性权益文案；不是运行证明 |
| O    | `options.js`、`options.html`                                   | 设置路由、配置处理、账户、导入导出、开发者入口 |
| C    | `content_main.js`、`content_guard.js`                          | 网页解析、翻译回填、交互、任务和页面生命周期   |
| B    | `background.js`、`browser-bridge/inject.js`                    | 请求桥接、认证、配置/跨标签消息、宿主适配      |
| P    | `popup.js`、`popup-layout-bootstrap.js`、`side-panel.js`及HTML | 弹窗、侧栏、快捷入口、消息与引导               |
| V    | `video-subtitle/inject.js`及 C 的字幕模块                      | 字幕采集、播放器适配、cue、AI字幕任务          |
| I    | `image/inject.js`、`offscreen.js`、`tesseract/`、`wasm/`       | 图片、后台OCR、下载模型和推理运行时            |
| F    | `pdf/index.html`、`pdf/extension-entry.js`                     | PDF在线页面入口及文件Blob传递                  |
| S    | `aifw/`                                                        | 本地隐私处理 JS/WASM；不是完整语义匿名化证明   |
| W    | 本文文末官方文档                                               | 在线文档、外部服务等包外能力补证               |

设置路由：`#general`、`#services`、`#ai`、`#terms`、`#terms/:id`、`#writing`、`#subtitle`、
`#manga`、`#input`、`#selection_translation`、`#mouse_hover`、`#floating`、`#shortcuts`、
`#advanced`、`#import_export`、`#about`、`#developer`、`#contact`、`#download_config`。
部分路由/导航受平台、地区、配置和账号条件控制，不表示所有用户同时可见。

## 2. 功能清单

依赖用“本地／混合／远端／入口”表示。混合指客户端产品逻辑存在，但计算、目录或账户可来自服务；
“入口”表示能确认链接/桥接，尚未取得完整应用实现。Pro 标记只在已见门控/文案处注明，
没有标记不等于保证免费。路线 R01–R15 见第3节；每条是候选方案，不是已实现状态。

### 2.1 网页、模型、上下文与术语

| ID  | 功能及子能力                                                   | 证据、依赖与限制                                                                                                                            | 路线    |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| T01 | 主内容/全文翻译、原位双语、仅译文、还原；译文前后位置          | D `translationMode/translationPosition`、C；混合                                                                                            | R01     |
| T02 | 按可视区渐进翻译、立即翻译、翻译至页尾、动态新增内容           | D `translationStartMode/immediateTranslationTextCount/visibleObserverScreens/mutationConfig`；C；混合                                       | R01     |
| T03 | 页面/段落语种检测、同语言处理、源语言→目标语言映射             | D `translationLanguagePairs/sameLangCheck/detectParagraphLanguage`；混合                                                                    | R01/R03 |
| T04 | 自动翻译语言/网站、永不翻译/禁用网站、临时站内自动翻译         | D `translationLanguagePattern/userBlockUrls/tempTranslateDomainMinutes`；O/C；本地规则                                                      | R01     |
| T05 | 网站正文/排除区域、标题/导航处理、iframe/Shadow DOM与SPA规则   | D `selectors/excludeSelectors/shadowRootSelectors/useIframePostMessage/observeUrlChange/isTranslateTitle`；仅存在适配路径，不能保证任意页面 | R01     |
| T06 | 富文本、占位符、段落识别、长段换行、代码等原文保留             | D `purifyRichHtml/placeholderDelimiters/lineBreakMaxTextCount/stayOriginalTags`；混合                                                       | R01/R03 |
| T07 | 译文样式、字体、透明度、尺寸、间距、圆角、下划线/高亮/遮罩学习 | L `translationTheme.*/customThemeLabel.*`，D `translationFonts`；本地；包括同语言样式                                                       | R01     |
| T08 | 缓存清除、缓存有效期、恢复默认、单项偏好持久化                 | O `xw/kNe`，D `cache/cacheMaxAgeDay`；本地/同步另列                                                                                         | R14     |
| T09 | 机器翻译服务目录、默认服务、启停与连接验证                     | D `translationServices`，O `#services`；含Google/Bing/DeepL/腾讯/百度/阿里/有道/彩云/Yandex/Papago等；配置不是当前可用性保证                | R03     |
| T10 | AI、聚合、自带密钥、本地模型与官方免费/Pro/Max服务             | D 含OpenAI-compatible、Claude/Gemini/DeepSeek/Qwen/Ollama/OpenRouter等及`*-pro/*-max`；外部服务资格逐项另验                                 | R03     |
| T11 | 自定义API/AI名称、URL、模型、Key、请求体JSON、语言/领域参数    | D `custom/custom-ai/userTranslationServices`，L `field.bodyConfigs/domain/scene`；混合，不能向网页开放通用请求                              | R03     |
| T12 | 每分钟/秒限流、单次字符/段数、批量模式、超时、服务重置         | L `field.limitPerMinute/maxTextLengthPerRequest/aiBatchMaxItems`，D `requestTimeout`；本地调度                                              | R02/R03 |
| T13 | 单段/批量/字幕Prompt、自定义变量、富文本模式                   | L/D `systemPrompt/multiplePrompt/subtitlePrompt/aiBatchTaskSystemPrompt`；混合；不照搬任意system prompt权限                                 | R02/R03 |
| T14 | AI专家目录、安装/卸载、版本兼容、详情和提示词查看              | O `#ai`，L `aiAssistant.*`；官方目录远端，已装逻辑混合                                                                                      | R02     |
| T15 | 专家自动选择、网站规则、兜底专家、自定义领域/风格              | L `matchesTitle/fallbackAssistant/customAiAssistant`；混合                                                                                  | R02     |
| T16 | 专家“非仅翻译”、段落总结/英文简化等模式、HTML渲染选项          | L `onlyTranslation/renderHtmlTag`；存在选项，AIbrowse必须净化或以受限结构展示                                                               | R02     |
| T17 | AI精翻/上下文分析、优化前后对照、定位原文与朗读                | D `enableAIContext`，L `contextDiffPreview/powerUser.longReading.*`；会员/模型条件；额外Token文案不是成本保证                               | R02     |
| T18 | 自定义术语库、词条检索/增删、目标语言、可选译法、语境标签      | O `#terms/#terms/:id`，L `terms.*`；本地＋可选同步                                                                                          | R02/R14 |
| T19 | 术语按网站匹配、名称作为领域、人工优先级和选择保存             | L `terms.matchesTitle/useNameAsDomain`、`articleTerminology.chooseTerms`；混合                                                              | R02     |
| T20 | AI自动提取文章术语、后续批次复用、查看提取和实际应用结果       | C `translations/newTerms`，D `ai_batch_terminology_enabled_prompt`；会员、增强批量路径；模型仅提建议                                        | R02     |
| T21 | 术语高亮、定位、划选添加、立即修正当前译文、撤销和显示控制     | C/L `articleTerminology.manual/translationUpdated/undoAdd/highlightTerms`；混合                                                             | R02     |
| T22 | 机器翻译术语占位符路径                                         | D `enableMachineTranslateTerms=false`，C存在分支；不能依据旧“仅AI”文案否定，也不能说默认可用                                                | R02/R03 |
| T23 | CSV术语导入、术语随配置导出、空库创建                          | L `terms.importCsvButton/includeTermsInExport`；本地                                                                                        | R14     |
| T24 | 术语云历史、预览/恢复、恢复前副本、冲突与未知结果处理          | O `fse({id,revision,expectedHash})`，L `terms.revisions*/articleTerminology.history*`；官方账号/Pro/云同步                                  | R14     |

### 2.2 写作、选区、输入、悬停与入口

| ID  | 功能及子能力                                                        | 证据、依赖与限制                                                                                                      | 路线    |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------- |
| T25 | AI Write：Gmail/GitHub写作/回复入口、独立面板、禁用网站             | O `#writing`，D `generalRule.aiWriting`；条件显示，混合                                                               | R04     |
| T26 | 写作摘要、回复建议、润色/生成、持续改写对话                         | D `summaryPrompt/suggestionPrompt/polishReplyPrompt/generalSystemPrompt`；混合                                        | R04     |
| T27 | 写作长度、正式程度、语气、角色与自定义风格                          | D/L `aiWriting.promptStyle`；混合                                                                                     | R04     |
| T28 | 写作极简/专业、停止/重生成、翻译/重翻、插入输入框                   | L `simpleMode/professionalMode/stop/regenerate/insert`，C写回处理；不等于获准自动发送                                 | R04     |
| T29 | 输入框整框/局部翻译、语言码、连击触发字符/次数/间隔                 | D `inputStartingTriggerKey/inputTrailingTriggerKey/inputLanguageCodeAlias`；混合                                      | R04     |
| T30 | 输入独立模型/目标语言、按页面/站点推断、目标语言栏                  | D `inputTranslationService/inputConfig.autoLanguage*/enableTargetLanguageBar`；部分为配置能力                         | R04     |
| T31 | 输入长文确认、站点排除、翻译点、写回失败复制降级                    | D `confirmLongTextLength/inputTranslationBlockUrls`，L `webViewInputDot.writebackFallback`；混合                      | R04     |
| T32 | 划词直接翻译/图标/圆点、同语言策略、禁站、临时停用                  | O `#selection_translation`，D `selectionTranslation`；本地＋模型                                                      | R01/R02 |
| T33 | 划词词典、音标、词性、例句、上下文释义、双语/仅译文、复制/展开      | D对应结构化Prompt，L `selectionTranslation*`；模型质量未验                                                            | R02     |
| T34 | 划词自动朗读、手动朗读、译文朗读                                    | L `enableSelectionTranslationAutoReadTitle`等；语音来源/语言覆盖需资格验证                                            | R13     |
| T35 | 划词Pro模型结果对比/试用入口与服务限制                              | L `powerUser.selectionCompare.*`；账号权益远端；原版划词并非任意服务都支持                                            | R02/R03 |
| T36 | Pro圈选：按住快捷键、截图裁剪、识别不可选文本/图像及结构            | O `UOe`、C `ohe`，D `selectionTranslation.screenshotArea`；视觉请求含`image_url`，不是只凭Tesseract                   | R09     |
| T37 | 鼠标悬停翻译、自动悬停、长按、快捷键、临时启停、独立模型            | D `mouseHoverHoldKey/mousePressHoldTranslateDelay`，O `mouseHoverTranslationService`；混合                            | R01     |
| T38 | 悬浮球翻译/还原/面板、位置/透明/小尺寸、禁站、延迟、侧栏固定        | D `pcFloatBall/monkeyH5FloatBall`；本地；移动端差异单列                                                               | R01     |
| T39 | 悬浮球侧栏、设置、反馈、关闭；收藏字段与旧分享配置                  | C `Elt/Klt`有活动按钮；`favorite/enableFloatShare/shareToDraft`只有字段/文案，未发现活动消费者，不能当已实现收藏/分享 | R01/R15 |
| T40 | 快捷键：页面/全文/主区/页尾、原文、遮罩、输入、侧栏、写作、指定服务 | D `shortcuts`、M `commands`；含`legacyShortcut`历史项，不全视为活跃菜单                                               | R01     |
| T41 | 触屏多指/滑动/连击等手势、移动浮球                                  | D `touchShortcuts*`；平台差异，未自动扩大Windows x64交付范围                                                          | R15     |

### 2.3 视频、图片与文档

| ID  | 功能及子能力                                                                             | 证据、依赖与限制                                                                                                                                                          | 路线        |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| T42 | 视频双语总开关、网站自动开关、播放器快捷按钮                                             | D `enableSubtitle/subtitleRule`，V/C；混合                                                                                                                                | R05         |
| T43 | YouTube字幕轨道选择、人工/AI优先、平台译文复用、预翻译、环境声过滤、独立翻译/回退模型    | V/C `humanPreferred/preTranslation/requestHumanSubtitle/requestYoutubeTranslateSubtitle`；必须核对轨道实际可访问                                                          | R05         |
| T44 | 字幕双语/仅译文、上下位置、字体/字号/字重/颜色、背景透明度/描边/阴影、重置、阅读速度整理 | C `VTTCue/youtubeSubtitleReadingSpeed`，D字幕规则；样式仅部分网站支持                                                                                                     | R05         |
| T45 | 基础合句、AI智能断句、上下文字幕翻译                                                     | C `requestServerMerge`访问`subtitles/yt-asr-subs`并发送字幕；认证远端合句＋本地整理                                                                                       | R05         |
| T46 | 无字幕AI转写、任务创建、进度/错误、结果轮询和重生成                                      | C `createNormalTask/pollTaskStatus`→`asr-audio/v2/*`，检查用户token；远端ASR，不是包内离线模型                                                                            | R06         |
| T47 | 字幕下载/文件翻译、原文/译文/双语结果                                                    | C `t1e`写状态后打开APP `/download-subtitle/`；W有SRT/ASS；最终编码器不在包内，不能把下载按钮当完整离线导出                                                                | R05/R12     |
| T48 | 会议字幕翻译、直播字幕、试用计时与服务选择                                               | D `liveSubtitleRule.isMeeting/proLiveSubtitleTranslateService/allowFreeUserLive`；Meet/Zoom/Teams消费网页已有转写，不证明直接录音；部分YouTube规则允许免费，不能一律标Pro | R05/R06/R15 |
| T49 | 视频站点适配与异常提示                                                                   | D含214展示链接、801条全局规则、192条含`subtitleRule.add`的顶层规则；数量不是独立域名/已测站点                                                                             | R05         |
| T50 | 图片悬停按钮/延迟、快捷键、右键、恢复原图                                                | D `imageRule`、I/C；本地交互＋识别/翻译                                                                                                                                   | R07         |
| T51 | 客户端图片检测与OCR、颜色/文字覆盖排版                                                   | I `offscreen`加载`preprocess-yolo/best` ONNX后调用Tesseract，C `Qme`做canvas排版；两个ONNX及traineddata不在包内，需资源下载；不是ASR                                      | R07         |
| T52 | 会员多语言图片识别、翻译与框定位                                                         | I/C、L服务选择；远端能力与本地链不同，不能把所有图片功能说成本地                                                                                                          | R07/R09     |
| T53 | 漫画整页/图片队列、气泡译文、成图与原图切换                                              | C `img-upload-url`→预签名上传→`comics/trigger/task-state`；官方远端处理链                                                                                                 | R08         |
| T54 | 漫画站点适配、图片定位、加载失败/目标未发现提示                                          | D `supportedMangaSites`含238展示链接，`imageRule`；网站与图像算法分别验证                                                                                                 | R08         |
| T55 | 普通PDF入口、本地/在线PDF、文件传递                                                      | F嵌入`app.immersivetranslate.com/pdf`并传Blob；没有完整离线文档应用                                                                                                       | R10         |
| T56 | PDF Pro、扫描/复杂版面、公式/多栏与BabelDOC                                              | D/C在线`pdf-pro/`入口，W功能文档；完整网页/后台未包含在包内                                                                                                               | R10/R11     |
| T57 | EPUB双语阅读/制作/导出，MOBI阅读入口                                                     | W和D/C电子书链接、`isEbook`；不要把入口证明写成MOBI全格式可逆导出                                                                                                         | R12         |
| T58 | HTML/TXT/Markdown文件翻译与双语输出                                                      | L文件格式列表、W文档帮助、C入口；包外文档应用，导出语义待独立实现                                                                                                         | R12         |
| T59 | DOCX文档翻译、样式保留                                                                   | W文档帮助；扩展包中未取得完整DOCX处理实现                                                                                                                                 | R12         |
| T60 | 文档/字幕结果编辑、批处理与进度/导出                                                     | W/L/D入口；部分在线专属，格式、额度、并发不能从入口推断                                                                                                                   | R10/R12     |
| T61 | 图片/视频在线工具、Zotero/Google Docs及移动App入口                                       | W导航、P链接；分别是在线产品/外部插件，不是此Chrome ZIP包含全部实现                                                                                                       | R15         |

### 2.4 隐私、配置、云端和外围能力

| ID  | 功能及子能力                                                          | 证据、依赖与限制                                                                                                         | 路线        |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------- |
| T62 | 本地/自部署隐私处理、发送前替换与结果还原                             | D `sensitiveConfig`，O inner/custom，C encode，S；默认`close`，中英网页等条件限制                                        | R09/R14     |
| T63 | 电话/邮箱/支付/密码等掩码开关、自定义服务host/key                     | D `mask*`；模型规则不能保证识别所有敏感内容，掩码true不表示全功能已启用                                                  | R09/R14     |
| T64 | 本地配置导入导出、手动备份、选择含术语/敏感设置、冲突提示             | O `#import_export`，L `configConflict.*`；本地／同步另列                                                                 | R14         |
| T65 | 官方账号同步、自动/手动、可选同步API Key/Token                        | O `enableAutoSyncAPIKey`，L `syncToAccount`；云依赖，AIbrowse现有密钥不出主进程的承诺优先                                | R14         |
| T66 | Google Drive授权、appDataFolder备份、列表/恢复/删除/撤销授权          | O Drive OAuth与文件操作；外部账户权限，不因本轮调查自动获授权                                                            | R14         |
| T67 | 官方配置/站点规则更新、在线设置、服务目录更新                         | D `useOnlineOptions/rules`，O同步规则；远端配置，不复制任意执行通道                                                      | R01/R14     |
| T68 | 开发者规则JSON、全量配置、注入CSS、最终配置/storage查看、Beta专家YAML | O `#developer`、L/D；需转为闭合声明式能力，不能照搬通用权限                                                              | R01/R02/R14 |
| T69 | 简洁/完整模式、模块启停、界面语言、主题                               | P/C `simpleModeDisabledFeatures`实际门控划词/写作/悬停/输入/字幕；默认简洁禁前四项，不只是换皮；圈选随划词域             | R01/R15     |
| T70 | 账号登录/退出、订阅/试用/额度/付费模型与管理入口                      | O/P/B，L `powerUser.*`；官方商业服务，本地重建不获得其额度                                                               | R03/R15     |
| T71 | 消息中心分页/刷新/未读/全部已读/清理、点击动作、版本更新提示          | P `v1/targeted-messages`及`read-all/clear-read/click`；按accountKey本地状态、pending侧栏目标与mock侧栏；需官方登录       | R15         |
| T72 | 教程、反馈客服、价格、关于、版本说明、下载App                         | O/P/D外链或条件UI；完整盘点保留，是否复制是产品范围问题                                                                  | R15         |
| T73 | 遥测开关、翻译性能/错误/主机/站点/功能使用、营销/登录统计             | O `toggle-telemetry`；B/C报告代码有device_id/可选user_id；不能仅凭“匿名”文案断言匿名；撤销门存在不等于安全验证通过       | R14/R15     |
| T74 | 请求修正规则、storage/后台/offscreen/截图/侧栏及网页消息桥            | M/B/I使用`runtime.getContexts/offscreen.createDocument/tabs.captureVisibleTab/sidePanel.*`与DNR；不对AI/网页开放通用能力 | R01/R03/R07 |
| T75 | 双语帖子分享卡：X/Twitter提取作者/正文/译文/媒体、预览与PNG保存       | C `b8/Wmt/zT/T8/z$e`、D `shareCardRule`；需原译文且无错误；默认关闭/站点规则控制；系统分享限宿主条件                     | R01/R15     |
| T76 | 安装/页面新手引导、箭头/次数/关闭、功能专属提示                       | B `runtime.onInstalled/qE`打开官方引导；C `enableShowFloatingBallGuide/installedAt`及远程素材；未证明存在独立更新器      | R15         |
| T77 | 奖励中心任务、解锁/领取、Token/PDF页数/视频次数奖励                   | P/O `v1/novice-tasks/*`、`reward_center_data_v1`；官方权益后台，规则可能禁用/隐藏，不属于可复制算力                      | R15         |
| T78 | 配置下载兼容页、自动JSON下载/重试、可附术语                           | O `#download_config/$F/withTerms`；是导出流程子项，不能当新管理系统                                                      | R14         |
| T79 | 搜索增强配置残留                                                      | D有四组金融站点`searchEnhancementConfig`，默认关闭；全包JS未发现该字段消费者，不列活动搜索能力                           | R15         |

视频适配可见种类包括YouTube JSON、Netflix XML、VTT/m3u8片段、iframe播放器及会议DOM字幕。
展示链接涉及流媒体、社交、课程、新闻和会议，不把某一解析器通过推广为全部网站通过。
图片侧有免费额度/账号/Pro/流量包多条路径；本轮不复制包内额度文案为当前收费规则。
Tesseract语言数据有默认jsDelivr来源；离线交付必须连权重/语言包一起固定、校验，不能只打包WASM。

后端可按用途分为：`api2/aigw1/ai`翻译与授权/任务，`lang-detect`检测，`app`在线工具，
`browser/dash/config`桥接/账号/配置，`assets/s/worker/onboarding`资源及运营；域名按地区和环境解析。
这些是原版依赖分类，不是AIbrowse可直接获得权限的接口清单。普通翻译也可能走自带Key直连第三方。

补充独审发现的独立交互：

| ID  | 功能及子能力         | 证据、依赖与限制                                                                                                                                    | 路线 |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| T80 | 临时编辑当前网页译文 | C `a9e/memory.enableEditTranslation`为`[data-imt-p]`切换contenteditable，C/P更多菜单有`tempEditTranslation`；不同于术语纠正，未证明持久化或跨页保留 | R01  |

服务清单、快捷键全部键、801条规则及每个站点展示链接保留在静态目录的格式化 D/M 中。
`.add_v.*`/`.remove_v.*`属于迁移或版本覆盖字段，不能算成额外服务/额外用户功能。

## 3. 未公开能力与可行技术路径

以下选择是工程候选，可按验证结果替换；不会因原版标 Pro 就删除对应体验。每条都必须实现客户端
任务、取消、失败展示和预算，不能以“有开源仓库”代替 Windows 集成证据。最低验证目前均 NOT RUN。

| 路线                        | 主方案与备用路径                                                                                                                 | 最小可行性验证                                                                                                       | 停止/换路条件与差异                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| R01 网页/交互               | 自建固定隔离脚本：稳定段落ID、DOM解析、渐进批量、原位回填/恢复、动态观察、闭合站点规则；UI实现浮球/侧栏/快捷键                   | 静态长文、SPA、iframe、Shadow DOM、富文本、编辑区、导航/关闭取消、恢复前后DOM比较                                    | 重复翻译、串页、正文损坏即停止该策略；不可读区域明确说明，不能回退为仅快照摘要并称等价                    |
| R02 智能翻译层              | 自有文字Provider＋有界上下文摘要、领域专家、结构化术语提议、确定性校验、版本/优先级/冲突和对照；术语手工修正可撤销               | 同词多义/人名/专业词/跨段指代；对照同模型裸API；检查术语采用、漏译/重译、并发和撤销                                  | 输出缺段/改ID/未采用指定术语则限次修复或明示失败；不强制错误术语、不让自动提议静默改永久库                |
| R03 模型适配                | 复用安全凭据与文本流，新增类型化TranslationProvider能力；自带Key/授权本地endpoint；厂商专用能力单独适配                          | 每种协议验证文本/批量/取消/超时/错误；端点授权、重定向/凭据、限额；结构化结果反例                                    | 模型不支持所需结构或语言则禁该能力/换模型；官方免费/Pro额度不可复制，不采集其账号token冒充自有API         |
| R04 写作/输入               | 用户选择语境→生成/润色→差异预览→确认回填；领域/语气模板；输入触发、独立模型与可见语言栏                                          | Gmail/GitHub及标准input/contentEditable合成样例，输入值变化、IME、光标、撤销、导航                                   | 回填前元素/文档/原值不符即拒绝；不自动提交，不把页面全部私信作为默认上下文                                |
| R05 已有字幕/断句           | 站点适配＋SRT/VTT/ASS解析，固定cue ID；上下文批量翻译；模型只建议语义分组，程序做时间对齐/覆盖检查                               | 有重叠/噪声/短cue/长句/双说话人样例；播放、暂停、seek、倍速、全屏、SPA切视频                                         | 丢cue/时间倒置/漂移/错绑视频即拒绝更新；没有可用字幕则用户导入或R06，不声称全站通用                       |
| R06 无字幕/直播ASR          | whisper.cpp独立工作进程、受控音频源、分块转写/时间对齐；备用自有Speech API                                                       | 授权短片含静音/噪声/口音/混语，测CER/WER、时间误差、实时系数、RSS/取消；离线与实时分开                               | 设备达不到时延/资源预算时讨论分段或云端；词级时间戳实验性；不得绕过DRM，不能保证任意受保护网页可抓音轨    |
| R07 图片OCR                 | PaddleOCR检测/识别→框与阅读顺序→自有翻译→覆盖排版；备用视觉API；语言模型包显式选择                                               | 中英日等选定语种、旋转/小字/无字/混排，框坐标、DPI/缩放、原图恢复、译文溢出                                          | 错框/低置信度时保留原图并允许纠正；不能将旁注悄悄作为无痕覆盖的等价交付                                   |
| R08 漫画成图                | 检测/气泡顺序＋manga-ocr/PaddleOCR＋翻译＋遮罩/inpainting＋排版；manga-image-translator作为隔离实验候选                          | 竖排/振假名/气泡外拟声/彩底/网点/空白气泡/长译文；分别评OCR、去字残留、背景损坏、排版                                | 背景破坏/幻觉识字/顺序错即禁止自动成图；备用保留原图＋覆盖/旁注必须说明体验差异，不宣称高级漫画等价       |
| R09 圈选/隐私               | 当前页显式圈选→主进程受限截图→裁剪→本地OCR或自有视觉API→结构化结果；隐私处理用本地规则/NER＋可逆占位映射                         | 跨DPI/缩放/滚动/导航、菜单/表格/布局；验证只发送选择区域；敏感实体漏检与映射碰撞                                     | 文档世代/坐标不确定即丢弃；脱敏失败不得默默发送原文；无法保证语义匿名化，用户可预览/选择全本地            |
| R10 文本型PDF               | PDFMathTranslate-next/BabelDOC隔离任务；备用自有文档API，PDF.js＋双栏阅读为有差异备用                                            | 双栏/脚注/链接/旋转/嵌入字体/表格公式小语料，逐页比对内容完整性、顺序、溢出和导出回开                                | 保版失败不可改称PASS；AGPL/依赖/Windows包装未闭合则替换；双栏阅读不冒充保版导出                           |
| R11 扫描/复杂PDF            | OCR/PP-StructureV3区块→翻译→受控页面覆盖；公式默认保留，表格固定cell ID；备用专业文档API                                         | 黑白/彩底/倾斜/混合扫描/空白页、合并单元格/跨页表/行内公式；数值/公式/关系不得损失                                   | 低质量OCR、串cell、公式改动阻止导出；BabelDOC OCR workaround只适合有限黑字白底，不承诺通吃复杂扫描        |
| R12 EPUB/DOCX/文本/字幕文件 | EPUB有界ZIP/XML按spine处理并保留资源；DOCX保留OOXML结构/run/关系，必要python-docx辅助；TXT/Markdown/HTML/SRT/VTT/ASS独立解析导出 | 目录/脚注/ruby/RTL、DOCX域/修订/文本框/超链接、编码/字幕样式；Markdown代码/链接/数学块保护；恶意归档、外链、格式回开 | 不支持结构/DRM明确拒绝，不能丢失后假成功；Mammoth仅语义预览不能证明保版；MOBI需独立格式资格               |
| R13 朗读                    | 受限Windows语音或可选Kokoro等本地TTS；备用自有云TTS                                                                              | 语言/声线/长段切片、暂停取消/释放、切页、离线；逐词高亮单独验证                                                      | 缺少时间事件只能段级，不伪造逐词同步；所需语言达不到须换模型/服务                                         |
| R14 数据/配置/历史          | 本地有版本术语/设置库、原子导入/备份、Undo/冲突检测；缓存键含模型/Prompt/术语版本；云同步另做授权适配                            | 损坏/中断/只读/并发/迁移/恢复反例；账号变化和未知请求结果；Key不入导出/日志                                          | 不默认复制官方Key云同步、Drive权限或云保存正文；远端历史服务不可从ZIP恢复，可本地重建历史但须标跨设备差异 |
| R15 外围/生态               | 侧栏导航/教程/反馈/公告可本地设计；外部产品保留为已识别入口；订阅/奖励/营销不等价翻译能力                                        | 链接来源、开窗/导航权限、隐藏条件、离线状态；逐项决定是否需要原版生态体验                                            | 不自动建设账号/云同步/手机App/Zotero/Google Docs插件；不将这些漏掉，也不因盘点即视为产品实现授权          |

### 3.1 组件、许可与 Windows 部署依据

| 候选                                                                                                                                                                                                                                                                                                          | 核实依据                                                 | 集成约束                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [BabelDOC](https://github.com/funstory-ai/BabelDOC)、[PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)                                                                                                                                                                       | PDF双语/保版、自部署；AGPL；next有Windows分发与程序接口  | BabelDOC内部API不应当作稳定公共契约；锁定版本并经next受控接口或CLI适配。Python/模型/缓存/字体均需打包资格，Key不进命令行 |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)                                                                                                                                                                                                                                                        | Apache-2.0、多语言检测/识别；官方PP-OCRv5 C++支持Windows | 不能推导所有VL/结构分析组合都有相同Windows成熟度；代码、模型、运行库与字体许可分别核验                                   |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp)                                                                                                                                                                                                                                                        | MIT、Windows、CPU/GPU路径；词时间戳标实验性              | 权重单独固定；实时能力取决于模型和机器，ASR与翻译是两步，静音幻觉/语言识别需真值验证                                     |
| [manga-ocr](https://github.com/kha-white/manga-ocr)                                                                                                                                                                                                                                                           | Apache-2.0、日文竖排等；首次模型约400MB                  | 官方提示无字图也可能输出文字，先检测再识别；不当作通用多语言OCR                                                          |
| [manga-image-translator](https://github.com/zyddnys/manga-image-translator)                                                                                                                                                                                                                                   | GPL-3.0；检测/识别/去字/排版候选                         | 官方Docker约15GB仅表示该镜像，不是Windows成品大小；各模型许可/显存/残字需验证，不能直接塞进默认程序                      |
| [epub.js](https://github.com/futurepress/epub.js)、[python-docx](https://github.com/python-openxml/python-docx)                                                                                                                                                                                               | 分别BSD、MIT；阅读/OOXML辅助                             | 禁脚本不等于全部净化；保持zip/xml预算、外链和字段约束。EbookLib是AGPL，不随意替换                                        |
| [Mammoth](https://github.com/mwilliamson/mammoth.js)、[PDF.js](https://github.com/mozilla/pdf.js)                                                                                                                                                                                                             | 文档预览/阅读组件；Mammoth不净化输入                     | 这些组件本身不提供完整保版翻译；样式、安全和输出完整性另做                                                               |
| [Kokoro](https://github.com/hexgrad/kokoro)与[权重](https://huggingface.co/hexgrad/Kokoro-82M)                                                                                                                                                                                                                | 开源TTS候选，权重Apache-2.0；Windows依赖espeak-ng        | 全部依赖和声线许可另查；[Piper活跃仓库](https://github.com/OHF-Voice/piper1-gpl)为GPL，不能笼统写MIT                     |
| [DeepL文档API](https://developers.deepl.com/api-reference/document/upload-and-translate-a-document)、[Azure ASR](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text)、[Azure TTS](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech) | 自有账号的正式接口备选                                   | 外发文档/音频、计费和留存须在UI明确；云端不是全本地，不能静默切换                                                        |

独立进程解决生命周期和资源隔离，不自动构成安全沙箱，也不自动免除GPL/AGPL义务。
包内闭源JS可分析不等于可直接复制分发；工程路线优先独立实现与许可明确的组件。
第一轮不安装所有模型/运行时，先按任务固定候选与预算；需可复现、模型摘要、离线资产和手动升级。

## 4. AIbrowse 集成边界

现有 BrowserController/TabManager 的标签所有权与文档世代、PageReader 固定隔离脚本、
LLMProvider文字流、DPAPI凭据和严格IPC可复用。现有快照是有界共读文本，不能直接承担全文回填；
消息内容目前是字符串，不能称已有视觉/音频/文档接口。

建议依赖方向：

```text
受信翻译UI → TranslationService（任务、术语、预算、取消）
  → 页面分段/回填、字幕采集/同步、圈选/图片、文件阅读与导出
  → 类型化 Text / Vision / OCR / ASR / TTS / Document Adapter
  → 主进程授权Provider或固定版本受控Worker
```

- 不改AgentLoop工具数，不赋予模型脚本、shell、通用文件/网络/IPC能力；模型只返回翻译/术语/分组建议。
- 普通用户Tab与Research/Watch任务页继续隔离；翻译UI节点必须可标识并从可信采集排除，不能让
  页面译文悄悄成为原文Evidence。普通页DOM/网站状态的间接影响仍须诚实说明。
- 页面/选区/视频/输入回填绑定tabId、documentId、元素/媒体身份及原值；导航/关闭/取消后结果失效。
- 密钥仅主进程DPAPI；文本、图片、音频、文档适配各有闭合schema、端点授权和尺寸/时长预算。
  本地模型端点是用户授权的窄例外，不扩大全局公共网络规则为任意私网代理。
- 文档Worker按用户选择的文件获得有限任务路径；拒路径穿越/压缩炸弹/外部关系，输出路径由宿主分配。
  Worker的日志/缓存/调试图不能成为未经授权的正文持久化；用户输出与临时中间件要区分。
- 原版PDF桥接可见通配targetOrigin和未见来源验证的消息处理；独立实现必须验证确切origin、frame、
  文档与任务token，不复制该消息模式。原版DNR图片站请求头兼容也不能变为通用改头代理。
- 自定义专家作为用户配置放入受控层，网页/Source/模型不能改system规则；不直接渲染模型HTML。
- 本地术语和设置可持久化；页面全文、语音、截图、翻译记忆和云同步的留存需正式契约，不能沿用
  插件默认。上下文摘要也可能含敏感信息。脱敏功能不能宣传语义层完全免疫。
- 云端模型、可选本地模型包与处理引擎分别展示成本/能力；接受开源/API不等于授权无限费用或全盘读取。

## 5. 验证计划与决策条件

### 5.1 实施前可行性验证顺序

以下为下一阶段的候选验证计划，本轮未执行，预算和阈值应先写入实施任务，再运行。

1. **文本与术语**：固定代表页面/术语冲突集；同一Provider/模型下比较裸API与上下文＋术语方案，
   人工校验语义、程序校验段落/术语/占位符。模型字符串出现不能算已采用术语或翻译正确。
2. **页面/圈选/字幕**：先本地固定夹具，后有界真实站点。包括导航、SPA、iframe、缩放、全屏、seek、
   倍速和取消；必须看实际DOM/像素/时间对应，不能仅日志PASS。
3. **OCR/ASR/文档**：每条路线先固定小语料及真值，测准确度、视觉损坏、时延、RSS、包体、取消清理；
   按所选机器/语种设置阈值。不能引用上游benchmark代替本机结果。
4. **持久化/安全**：术语历史、导入、缓存版本、迁移/损坏/磁盘失败、并发、权限撤销和输出净化反例；
   新独立审核覆盖关键持久化/隐私/并发边界。
5. **最终体验**：以用户认可的代表网页、视频、图片和文档逐项验收。没有官方Pro对照样例时只能报告
   本方案与裸API对比，不能声称已超过原版Pro。各批完成不自动意味着完整范围完成。

每种未知路线最多两轮有诊断的尝试；无新证据时换路，不无界调Prompt/模型刷绿。失败与原件保留。
所有fallback显式描述效果差异；影响用户体验/隐私/数据完整性/实质性能的替换须集中裁决。

### 5.2 需要实施时确定的产品参数

这些不阻塞当前完整调查，也不应在本轮反复要求用户审批工程手段：

- 支持矩阵：首批必须覆盖的网站、源/目标语种、文档格式、代表漫画/PDF；不推定214个展示链接全部支持。
- 无字幕视频：实时还是先处理后看；直播/会议音频、DRM受保护内容分别处理，不默认全覆盖。
- 本地模型与API：允许外发的数据类型/提供方、成本上限、可选模型包和资源预算；不能默认为无限调用。
- 文档输出：保版PDF/可编辑DOCX/双语阅读器的优先级；有损备用路线不能替用户接受。
- 云历史/Drive/跨设备：完整盘点包含这些能力，是否重建云服务尚未授权；默认不传Key/Token。
- 平台生态：当前Windows x64应用内功能与手机App、Zotero、Google Docs插件是不同交付。

## 6. 官方补充资料与证据状态

- [安装与版本](https://immersivetranslate.com/zh-Hans/docs/installation/)、[当前仓库源码说明](https://github.com/immersive-translate/immersive-translate)。
- [高级配置](https://immersivetranslate.com/zh-Hans/docs/advanced/)、[Prompt变量和批量翻译](https://immersivetranslate.com/zh-Hans/docs/prompts/)。
- [功能使用](https://immersivetranslate.com/zh-Hans/docs/usage/)、[文档工具](https://immersivetranslate.com/zh-Hans/document/help/)、[隐私政策](https://immersivetranslate.com/zh-Hans/docs/PRIVACY/)。
- [浏览器合作](https://immersivetranslate.com/zh-Hans/docs/browserExtensionIntegration/)与[JS SDK](https://immersivetranslate.com/zh-Hans/docs/js-sdk/)为官方授权集成备选；并非公开全部内部源码。

本轮结论为静态调查和候选方案。未执行真实插件、付费功能、模型推理、音视频捕获、文档转换或集成冒烟。
历史Electron 43.7.7扩展资格只作风险线索，当前43.8.4未复验原版兼容；不借此否定独立实现路线。

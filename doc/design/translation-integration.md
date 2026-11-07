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
- 后续差量基线：`3a46d8564fd8bd4d6dac090a15d0485da276f9a4`，接管干净；用户进一步要求成熟GitHub
  组件、在线免费层/BYOK优先、尽量不部署本地模型，并纠正录播字幕应提前取得转写、按时间轴逐句显示。
  本轮只更新候选路线、服务资格、字幕契约和验收计划；复用未改动的80项盘点与静态工具证据。

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

2026-11-07 用户补充决定：优先寻找成熟 GitHub 组件，模型计算使用官方在线免费层或用户自行配置的
API Key；默认安装不下载/部署本地 LLM、OCR、ASR、版面识别或 TTS 权重。本地 DOM/文件解析、
字幕同步、图像裁剪/排版与缓存不属于本地模型，仍由浏览器完成。此前本地模型方案保留为非默认候选。

高级术语、上下文、字幕断句/同步、圈选、漫画成图和文档排版仍在范围内；接通一个文字 API 不能代表
完成这些能力。以下为工程候选，尚未运行 AIbrowse 集成验证，不能以仓库存在或云接口存在代替效果验收。

| 路线                        | 优先方案与备用路径                                                                                                           | 最小可行性验证                                                                        | 停止/换路条件与差异                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| R01 网页/交互               | 评估 Read Frog 的段落/动态 DOM/字幕等模块，满足许可后提取适配；固定隔离脚本与自有UI负责原位双语、恢复、浮球、侧栏、快捷键    | 静态长文、SPA、iframe、Shadow DOM、富文本、编辑区、导航/关闭取消、恢复前后DOM比较     | 许可不兼容则独立实现所需模块；重复翻译、串页、正文损坏停止策略，不退化为快照摘要并称等价              |
| R02 智能翻译层              | 自有在线文字Provider＋有界上下文、领域专家、结构化术语提议、确定性校验、版本/优先级/冲突和对照                               | 同模型裸API对照；多义词/人名/专业词/指代、漏译/重译、术语采用、撤销                   | 缺段/改ID/术语错误时限次修复或明示失败；自动提议不静默修改永久术语库                                  |
| R03 模型适配                | 官方免费层与BYOK；复用安全凭据，新增类型化TranslationProvider；文字、视觉、ASR、文档按能力分别配置                           | 协议/批量/取消/超时/限额/重定向/结构反例；免费耗尽和计费估算                          | 不自动切付费、不共享Key池；免费层不可用时明确配置/额度状态，不把网页端点当有服务保证的API             |
| R04 写作/输入               | 用户选择语境→在线生成/润色→差异预览→确认回填；领域/语气模板、独立模型                                                        | input/contentEditable、IME、光标、原值变化、撤销、导航                                | 文档/元素/原值不符拒绝回填，不自动提交，不默认发送整页私信                                            |
| R05 已有字幕/断句           | 优先平台人工/自动字幕；SRT解析优先subtitle.js，WebVTT/TTML/ASS按能力补适配；上下文批量预翻译，确定性句段映射和同步，详见§3.3 | 短碎cue/跨cue长句/重叠/双说话人；预取、播放/暂停、seek、倍速、全屏、切视频            | 丢cue/错误时间/错绑视频即拒绝；不要求等待整片翻译，不在每句播放时才发翻译请求                         |
| R06 无字幕预转写            | 受控取得有权处理的录播音轨→在线文件/分块ASR（Groq优先评估，Azure批量ASR备选）→带时间戳原文→R05                               | 静音/噪声/口音/混语、分块边界/偏移、CER/WER、时间误差、首段就绪/全片完成、配额/取消   | 默认不录麦克风/实时回环听写；无可取得音轨时提供字幕/音频导入，不绕过DRM；直播/会议实时ASR另列可选范围 |
| R07 图片OCR                 | 在线OCR/视觉API返回文本、框、阅读顺序→在线翻译→本地覆盖排版；优先评估Azure Read/Layout，视觉模型作备选                       | 中英日等选定语种、旋转/小字/无字/混排、框坐标、DPI/缩放、恢复与溢出                   | 无可靠框或幻觉文字不得自动覆盖；低质量保留原图、允许纠正，旁注有体验差异                              |
| R08 漫画成图                | 云OCR/阅读顺序＋在线翻译＋受控遮罩＋云inpainting＋本地排版；复用许可允许的开源排版/遮罩模块，纯色气泡可确定性填充            | 竖排/振假名/拟声/彩底/网点/长译文；分别验OCR、残字、背景损坏、排版                    | 云修复API只是组件，不等于成熟整套漫画服务；背景破坏/顺序错则不自动成图，覆盖/旁注不能冒充无痕重绘     |
| R09 圈选/隐私               | 当前页显式圈选→受限截图/裁剪→用户配置在线OCR/视觉服务；本地确定性脱敏/可逆占位映射，不隐式部署NER模型                        | DPI/缩放/滚动/导航、仅选区上传、脱敏漏检/映射碰撞；图片中的敏感信息另验               | 文档/坐标不确定即丢弃；外发前可预览，敏感内容禁用不合适的免费层；规则脱敏不保证语义匿名化             |
| R10 文本型PDF               | PDF.js解析/阅读＋文字API用于双语阅读；保版导出优先专业在线文档API（DeepL/Azure）；BabelDOC只作非默认外部服务候选             | 双栏/脚注/链接/旋转/字体/表格/公式、逐页完整性/顺序/溢出/导出回开                     | PDF.js不是翻译引擎；专业API也不默认提供原译对照；仅双栏阅读不等价保版导出，需分别验收                 |
| R11 扫描/复杂PDF            | 云OCR/Layout或支持该格式的在线文档翻译→区块/表格ID→受控排版；公式优先保留                                                    | 倾斜/彩底/混合扫描/空白页、合并cell/跨页表、数值/公式/阅读关系                        | OCR缺漏、串cell、公式改动阻止成功导出；云端保版对公式/复杂扫描的能力也待真值验证                      |
| R12 EPUB/DOCX/文本/字幕文件 | 本地有界ZIP/XML按spine/OOXML结构解析，文字API翻译后恢复；epub.js阅读，python-docx仅必要时评估；纯文本/字幕独立导出           | 目录/ruby/RTL、域/修订/文本框/超链接、编码/字幕样式、Markdown代码/公式、恶意归档/回开 | 不支持/DRM明确拒绝；不丢内容后假成功，Mammoth仅语义预览，MOBI单独资格                                 |
| R13 朗读                    | Windows已有语音或用户配置在线TTS；不默认下载Kokoro等权重                                                                     | 语种/声线/切段、暂停/取消/释放/切页；时间事件单独验证                                 | 无时间事件只做段级高亮，不伪造逐词同步；免费字符耗尽不自动计费                                        |
| R14 数据/配置/历史          | 本地版本化术语/设置、原子导入/备份、Undo/冲突；缓存绑定原文/模型/Prompt/术语版本，云同步另适配                               | 损坏/中断/并发/迁移/恢复、账号变化、请求结果未知、Key不进导出                         | 不复制官方Key云同步/Drive权限或默认云保存正文；跨设备差异明确说明                                     |
| R15 外围/生态               | 侧栏/教程/反馈/公告本地设计；外部产品保留已识别入口；直播已有DOM字幕可做增量翻译                                             | 链接/开窗权限、隐藏条件/离线；逐项确定原版生态体验                                    | 不把直播增量字幕等同录播预取；账号/奖励/手机App/Zotero/Google Docs不因盘点就自动实现                  |

### 3.1 GitHub 组件资格与复用边界

以下固定核查到源码、许可及维护信号；“优先评估”不表示已经安装或通过产品验收。所有新增依赖仍须精确
固定。源码/许可义务不能靠进程、IPC或sidecar隔离自动消除；不兼容时选择独立实现或获适用商业授权。

| 候选与核查版本                                                                                                                                                                        | 维护/许可依据                                                                          | 采用范围与限制                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Read Frog](https://github.com/mengxi-ream/read-frog/tree/174027d2bdfb6013dfc41d54c1cb87ee8c13274c)，核查SHA `174027d2bdfb6013dfc41d54c1cb87ee8c13274c`                               | 活跃仓库，release v1.58.0（2026-11-05）；GPLv3及另行商业许可；存在段落/字幕测试        | R01/R05优先复用评估，需改接AIbrowse安全边界；其给其他项目的特定商业授权不覆盖本项目                   |
| [PDF.js](https://github.com/mozilla/pdf.js/tree/65832caa7b8dbc3a1274c533efe06032c7dba6d5)，核查SHA `65832caa7b8dbc3a1274c533efe06032c7dba6d5`                                         | Apache-2.0；最新release v6.5.438（2026-11-01）；测试覆盖Windows/Ubuntu与Chrome/Firefox | R10/R11阅读/坐标/文本项提取底座；不含OCR和完整保版翻译                                                |
| [subtitle.js](https://github.com/gsantiago/subtitle.js/tree/e4c7ad0427dd102619a09378e69cfdcd831a7582)，核查SHA `e4c7ad0427dd102619a09378e69cfdcd831a7582`                             | MIT；源码package 4.2.2，分支最后提交2025-11-16；有解析/时间戳/resync/输出测试          | R05/R12优先SRT解析/导出；WebVTT仅部分支持，TTML/ASS另做；GitHub最新release仍4.1.2，不能混称固定发行版 |
| [vtt.js](https://github.com/mozilla/vtt.js/tree/42ca104e8845bfc4485e8579d62cac6feaa00de9)，SHA `42ca104e8845bfc4485e8579d62cac6feaa00de9`                                             | Apache-2.0；默认分支最后提交2019-03-28；Grunt/Bower/PhantomJS旧工具链                  | 规范边界/测试参考，不优先新增主依赖；未归档不等于活跃维护                                             |
| [PDFMathTranslate-next](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/tree/f8dffcf4c3a33b254391d43514439b975ce8d966)，SHA `f8dffcf4c3a33b254391d43514439b975ce8d966` | AGPL-3.0；v2.9.0（2026-05-15），依赖BabelDOC 0.6.x；旧组织仓库停在2.8.2                | 纠正旧仓库地址；多Provider/任务调度可研究，但默认不安装其Python/版面模型栈                            |
| [BabelDOC](https://github.com/funstory-ai/BabelDOC/tree/38d3896dcde9b5a940c62cf5563cadea673a64d3)，SHA `38d3896dcde9b5a940c62cf5563cadea673a64d3`                                     | AGPL-3.0；v0.6.4（2026-07-16），最近提交2026-08-05；默认ONNX布局推理                   | 保版算法参考；rpc-doclayout不证明有可用公共免费服务；远端服务候选需独立资格                           |
| [epub.js](https://github.com/futurepress/epub.js)、[python-docx](https://github.com/python-openxml/python-docx)、[Mammoth](https://github.com/mwilliamson/mammoth.js)                 | 分别BSD、MIT、BSD；延续前轮候选，尚未固定本轮依赖版本                                  | 阅读/OOXML辅助不要求本地模型；有界ZIP/XML、外链与净化独立负责；Mammoth不证明保版                      |

Read Frog 可见的[TextTrack读取](https://github.com/mengxi-ream/read-frog/blob/174027d2bdfb6013dfc41d54c1cb87ee8c13274c/src/utils/subtitles/fetchers/text-track/cues.ts)、
[字幕翻译](https://github.com/mengxi-ream/read-frog/blob/174027d2bdfb6013dfc41d54c1cb87ee8c13274c/src/utils/subtitles/processor/translator.ts)和
[DOM分段](https://github.com/mengxi-ream/read-frog/blob/174027d2bdfb6013dfc41d54c1cb87ee8c13274c/src/utils/host/translate/dom/paragraph-segmentation.ts)
与[托管AI字幕请求](https://github.com/mengxi-ream/read-frog/blob/174027d2bdfb6013dfc41d54c1cb87ee8c13274c/src/utils/subtitles/ai/request-ai-subtitles.ts)须分开：
后者是videoTranscript任务/RPC与配额门控，没有据此获得其云端ASR实现或免费权益。其Google/Microsoft免Key
路径仅证明代码存在；[PR测试](https://github.com/mengxi-ream/read-frog/blob/174027d2bdfb6013dfc41d54c1cb87ee8c13274c/.github/workflows/pr-test.yml)
排除free-api.test.ts，本轮未调用验证，暂不作为可靠主链。

上游CI仅作成熟度线索：Read Frog/subtitle.js查到的成功运行并非上述固定SHA，PDF.js有coverage发布失败；
BabelDOC构建/解析冒烟未证明真实OCR/翻译。没有把“有测试”写成“当前全绿”或AIbrowse集成通过。
BabelDOC的[默认布局选择](https://github.com/funstory-ai/BabelDOC/blob/38d3896dcde9b5a940c62cf5563cadea673a64d3/babeldoc/docvision/base_doclayout.py)、
[ONNX推理](https://github.com/funstory-ai/BabelDOC/blob/38d3896dcde9b5a940c62cf5563cadea673a64d3/babeldoc/docvision/doclayout.py)和
[资产下载](https://github.com/funstory-ai/BabelDOC/blob/38d3896dcde9b5a940c62cf5563cadea673a64d3/babeldoc/assets/assets.py)说明仅配置翻译Key仍会用本地模型。

前轮已调查、现不默认部署的候选：PaddleOCR（Apache-2.0）、whisper.cpp（MIT）、manga-ocr（Apache-2.0）、
manga-image-translator（GPL-3.0）、Kokoro及其依赖。代码模块可继续评估，推理权重不随默认安装下载；
若以后明确选用本地方案，模型、运行库、字体、声线许可及Windows资源/安全资格分别核验。

### 3.2 在线免费层与自带 Key 的服务候选

下面是2026-11-07官方文档快照，不是账户已经开通或接口已经实测。免费额度≠免Key接口≠一次性试用；
地区、注册资格、模型、服务模式和实际配额以用户账户为准。免费/付费均需请求预算、429退避、取消和可见失败；
不能以免费额度耗尽为由静默切换计费账户或把私密内容交给不同数据政策的服务。

| 能力/候选                                  | 免费性质与已查限制                                                                               | 选择理由与验证边界                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文字：Azure Translator                     | F0每月200万字符，需账户/Key；单次多目标语言合计≤50,000字符                                       | 官方免费文字路径；Document Translation不在F0文字额度内。[价格](https://azure.microsoft.com/en-in/pricing/details/translator/)、[限制](https://learn.microsoft.com/en-us/azure/ai-services/translator/service-limits)                                                                |
| 智能文字/图片理解：用户现有LLM与Gemini候选 | 复用已有文字Provider；Gemini部分模型有需Key免费层，配额随项目；视觉必须新适配                    | Gemini免费内容可能用于改进及人工审阅，不能发送敏感内容；条款含用途/年龄/地区条件，不能无条件列为所有用户默认免费方案。[价格](https://ai.google.dev/gemini-api/docs/pricing)、[条款](https://ai.google.dev/gemini-api/terms?authuser=00)                                             |
| 带时间戳ASR：Groq Whisper                  | 需Key免费层；免费文件≤25MB；开发者层文件≤100MB，但直接附件仍≤25MB；受请求/音频时长配额约束       | 优先录播文件预转写；transcriptions保留源语后另译中文，translations只输出英语；支持segment/word时间戳。[ASR](https://console.groq.com/docs/speech-to-text)、[限额](https://console.groq.com/docs/rate-limits)                                                                        |
| 批量ASR/朗读：Azure Speech                 | F0的每月5小时适用于实时ASR，不能用于批量转写；批量ASR需S0。F0神经TTS每月50万字符，批量合成另收费 | 录播长任务/中文朗读备选，异步排队不保证即时；不能以实时免费额度宣传批量免费。[免费服务](https://azure.microsoft.com/en-in/pricing/free-services/)、[配额](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits)                     |
| OCR/版面：Azure Document Intelligence      | F0每月500页，文件≤4MB、每请求只处理前2页；付费层另限                                             | Read/Layout提供文字框/段落/表格，翻译/排版仍需开发；F0截断不能误报整份完成。[价格](https://azure.microsoft.com/en-us/pricing/details/document-intelligence/)、[限制](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/service-limits?view=doc-intel-4.0.0) |
| 保版文档：DeepL API                        | 新Developer为一次性100万字符，不重置；旧API Free每月50万但已停止新购；Growth等付费               | 文档格式/语种/体积另核；PDF/Office等最低每份计50,000字符，不把少页视为零成本；无双语/公式保真保证。[套餐](https://support.deepl.com/hc/en-us/articles/360021200939-DeepL-API-plans)、[计量](https://developers.deepl.com/docs/resources/usage-limits)                               |
| 漫画去字修复：fal托管inpainting候选        | BYOK，未确认稳定免费层，不列免费承诺                                                             | 有图像/遮罩API，可与云OCR和本地排版组合；需验证模型/许可、网点保护、输出尺寸和留存后才能采用，不是已完成漫画翻译器。[API](https://fal.ai/models/fal-ai/lora/inpaint/api)                                                                                                            |

数据处理按具体提供方/套餐适配：Azure文字翻译的[不保留提交内容说明](https://learn.microsoft.com/en-us/azure/ai-services/translator/secure-deployment)
不能外推到文档/音频；Document Intelligence结果临时留存及删除见[FAQ](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/faq?view=doc-intel-4.0.0)。
Groq[数据政策](https://console.groq.com/docs/your-data)区分默认处理、可靠性/滥用排查和ZDR，不把“默认不留存”写成绝对零日志。
DeepL文档的结果密钥应与账号Key同等保护，并遵守[下载时效](https://developers.deepl.com/api-reference/document/download-translated-document)。
Gemini的PDF理解不是保版导出，Files上传/主动删除见[文件接口](https://ai.google.dev/gemini-api/docs/files)；
向EEA/瑞士/英国用户提供客户端时的付费条件见上述条款，实施前复核适用性，不对个人用途作未经确认的法律结论。

开源仓库中的免Key网页接口可另做有界资格调查，但不能仅凭代码推断稳定、长期免费或允许产品集成。
本轮未发现可支撑全部高级功能、无需Key且有明确服务保障的免费主链。配置界面按能力显示文字、视觉/OCR、
ASR、文档及修图服务状态；一个普通文字Key不自动具备其余模态能力，术语/上下文和字幕体验由产品层实现。

### 3.3 字幕契约：读取已有字幕、重新断句与同步显示

用户进一步指出：YouTube原生字幕看起来实时逐词出现，启用插件后变成按时间轴整句显示。调查到的机制是
**读取已有时间轴→重新断句/合并→翻译预取→接管字幕绘制**，不等于插件必须重新识别音频。两种显示本来
都受播放时间控制，差别是逐词/滚动更新与完整句组显示；仅凭外观不能确定具体视频是否实时ASR。

1.34.4静态依据（均为§1.2的D/C/V，未执行插件）：YouTube规则监听`/api/timedtext`，`G8.fetchSubtitle`
设置`fmt=json3`；本轮未在该路径发现srv3，不能把其他工具的格式推定到它。C的`G8.loadSubtitle`
对`kind=asr`已有自动字幕轨调用`requestOriginalEvents`，在对应配置开启时走`dCe`基础分句；`jdt`将
`tStartMs + tOffsetMs`转为片段时刻，`cCe`产出句组的start/end/text。`kind=asr`在此是平台字幕轨类型，
不能解释成此刻插件正在采集音频。`mergeSegsText`及辅助函数过滤追加事件、归并片段和处理部分重叠，
不宣称通用无损去重。该基础分句受语言配置限制，现有`base/en`配置不证明全部语种均使用同一算法。

显示侧，YouTube规则通过`.caption-window {display: none;}`隐藏原生窗口；C的`eCe/Ndt`字幕层监听
`timeupdate`，按播放器`currentTime`和句组start/end选择当前文字；翻译调度从当前句向后分组预取。
会员英文增强分支`requestServerMerge`在预翻译/AI开关/Pro/支持语言条件满足时，把已有events/subtitles
发给`subtitles/yt-asr-subs`做分句；
它与T46的`asr-audio/v2/create-task`音频转写是独立路径。存在基础本地分句，不应把整句显示都标成必须用Pro。

因此R05须优先复现上述行为，并以确定性断句＋用户配置的文字模型增强替代托管分句能力。无可用字幕时才
评估R06。语义上的一句可能横跨多个碎cue，不能机械地把每个短cue孤立翻译。双语或仅中文可切换。

```text
平台人工/自动字幕，或用户导入字幕 ──────────┐
可取得的录播音轨 → 在线文件/分块转写 → 带时间戳原文 ─┤
                                                ↓
有界解析/校验 → 句段映射 → 带上下文批量中文预翻译 → 校验并缓存
                                                ↓
                               按播放器时间逐句显示原文/中文
```

1. 优先取完整已有字幕轨；只有分段轨时按播放位置预取。保留不可变的源cue ID、原文、开始/结束时间和轨道身份。
   一个显示句组映射到一个或多个源cue；译文只按组ID返回，源cue不得遗漏/重复覆盖。词时间戳不足时不伪造更细时间。
2. 句组以标点、停顿、说话人和阅读长度约束构建；模型可建议分组，程序验证覆盖、顺序和时间范围。译文模型
   不产生或改写媒体时间轴。允许原字幕合法重叠，分开说话人/轨道，不用“一律不重叠”损坏原字幕。
3. 翻译当前播放区间及有界前方窗口，先显示已经完成的片段，其余后台准备；支持整轨提前处理但不强制等待整片。
   “无需每句临场请求”可以降低播放时等待，不代表未缓存视频零等待、免费API无排队或永不缺字幕。
4. 无字幕音轨才走云ASR。长音频按服务限制分块，有界重叠，保留块起点；归一化返回时间戳、加回偏移并去重，
   不让译文模型猜时间。Groq参数以verbose_json和segment/word为候选，官方示例注释与参数表有差异，须聚焦实测。
   Azure批量任务的offset/duration映射到同一内部结构，模式分别验证，不能假定所有“兼容API”支持相同字段。
5. seek优先准备目标附近，取消过期请求；切视频/轨道/语言/导航后旧任务结果不可串入新媒体。缓存键包含媒体与
   轨道身份、原文摘要、语言、Provider/模型、Prompt/术语版本；缓存默认内存，跨重启保存需另定留存契约。
6. 仅向已配置服务发送该任务选定的字幕/音轨，不发送站点Cookie、账号Token或带凭据的媒体URL。音轨获取受
   BrowserController与任务授权约束，无法取得时显示导入入口。取消会停止本地消费/后续上传，已受理云请求的费用
   和删除状态要如实显示；支持远端删除的服务应清理任务/输入/结果，失败可见且限次重试。
7. 验收分别覆盖：原句与中文对齐、长句/短cue/双人重叠、时间漂移、首段就绪、播放前方字幕覆盖、seek补齐、
   网络断开/429/额度耗尽、取消/导航/切轨零串页。阈值和语料在POC前固定；没有真实测量不承诺及时性数值。

直播/会议在完整转写前无法取得未来字幕；原包另有`isLive`及`extractLiveCaptionFromContainer`路径，
读取`.ytp-caption-segment`等已产生字幕并合并滚动更新；这也不证明扩展自己录音识别。平台已产生的字幕
仍可增量翻译，其时延另验。用户具体视频是否直播、有效配置与所选字幕轨未取得，不能断定命中哪一分支。
麦克风、系统回环和实时ASR不是当前录播主路径，也不因功能盘点自动启动实现。

## 4. AIbrowse 集成边界

现有 BrowserController/TabManager 的标签所有权与文档世代、PageReader 固定隔离脚本、
LLMProvider文字流、DPAPI凭据和严格IPC可复用。现有快照是有界共读文本，不能直接承担全文回填；
消息内容目前是字符串，不能称已有视觉/音频/文档接口。

建议依赖方向：

```text
受信翻译UI → TranslationService（任务、术语、预算、取消）
  → 页面分段/回填、字幕采集/同步、圈选/图片、文件阅读与导出
  → 类型化 Text / Vision / OCR / ASR / TTS / Document Adapter
  → 主进程授权的在线Provider；本地固定版本Worker仅做解析/裁剪/编码/排版
```

- 不改AgentLoop工具数，不赋予模型脚本、shell、通用文件/网络/IPC能力；模型只返回翻译/术语/分组建议。
- 普通用户Tab与Research/Watch任务页继续隔离；翻译UI节点必须可标识并从可信采集排除，不能让
  页面译文悄悄成为原文Evidence。普通页DOM/网站状态的间接影响仍须诚实说明。
- 页面/选区/视频/输入回填绑定tabId、documentId、元素/媒体身份及原值；导航/关闭/取消后结果失效。
- 密钥仅主进程DPAPI；文本、图片、音频、文档适配各有闭合schema、端点授权和尺寸/时长预算。
  默认无本地推理端点；未来显式选择本地方案时也是窄授权，不扩大全局公共网络规则为任意私网代理。
- 文档Worker按用户选择的文件获得有限任务路径；拒路径穿越/压缩炸弹/外部关系，输出路径由宿主分配。
  Worker的日志/缓存/调试图不能成为未经授权的正文持久化；用户输出与临时中间件要区分。
- 原版PDF桥接可见通配targetOrigin和未见来源验证的消息处理；独立实现必须验证确切origin、frame、
  文档与任务token，不复制该消息模式。原版DNR图片站请求头兼容也不能变为通用改头代理。
- 自定义专家作为用户配置放入受控层，网页/Source/模型不能改system规则；不直接渲染模型HTML。
- 本地术语和设置可持久化；页面全文、语音、截图、翻译记忆和云同步的留存需正式契约，不能沿用
  插件默认。上下文摘要也可能含敏感信息。脱敏功能不能宣传语义层完全免疫。
- 服务按能力和数据政策配置，Key不进入网页/字幕脚本/Worker；云端任务ID、文档下载密钥等也须受控。
  上传大小/时长、重试/并发/累计预算以及远端结果删除纳入任务生命周期；取消不伪称撤销已发生费用。
- 本地解析/渲染组件与云端计算分开展示成本/能力；不下载模型、不默认引入Python/GPU运行栈。
  接受开源/API不等于授权无限费用、全部页面自动上传或全盘读取。

## 5. 验证计划与决策条件

### 5.1 实施前可行性验证顺序

以下为下一阶段的候选验证计划，本轮未执行，预算和阈值应先写入实施任务，再运行。

1. **文本与术语**：固定代表页面/术语冲突集；同一Provider/模型下比较裸API与上下文＋术语方案，
   人工校验语义、程序校验段落/术语/占位符。模型字符串出现不能算已采用术语或翻译正确。
2. **页面/圈选/字幕**：先本地固定夹具，后有界真实站点。包括导航、SPA、iframe、缩放、全屏、seek、
   倍速和取消；字幕单列原生滚动/碎cue→完整句组、播放前方预取与切轨。必须看实际DOM/像素/时间对应，
   不能仅日志PASS；站点已有字幕优先于ASR路径。
3. **OCR/ASR/文档**：每条路线先固定小语料及真值，测准确度、视觉损坏、网络/排队/首段与全任务时延、
   实际字符/时长/页数计量、429/断线/额度耗尽、取消/远端删除及本机RSS/包体。验证默认无权重下载、
   无本地模型推理；不能引用上游benchmark或免费层说明代替用户账户/Windows实际结果。
4. **持久化/安全**：术语历史、导入、缓存版本、迁移/损坏/磁盘失败、并发、权限撤销和输出净化反例；
   新独立审核覆盖关键持久化/隐私/并发边界。
5. **最终体验**：以用户认可的代表网页、视频、图片和文档逐项验收。没有官方Pro对照样例时只能报告
   本方案与裸API对比，不能声称已超过原版Pro。各批完成不自动意味着完整范围完成。

每种未知路线最多两轮有诊断的尝试；无新证据时换路，不无界调Prompt/模型刷绿。失败与原件保留。
所有fallback显式描述效果差异；影响用户体验/隐私/数据完整性/实质性能的替换须集中裁决。

### 5.2 需要实施时确定的产品参数

这些不阻塞当前完整调查，也不应在本轮反复要求用户审批工程手段：

- 支持矩阵：首批必须覆盖的网站、源/目标语种、文档格式、代表漫画/PDF；不推定214个展示链接全部支持。
- 视频路径已确定为现成字幕优先、无字幕才云端预转写、提前翻译和时间轴逐句显示；需确定首批站点及
  无字幕音轨获取方式、预取/首段时延阈值。直播/会议实时ASR另列，不再把实时/预转写重复提交用户裁决。
- 部署偏好已确定为成熟组件＋在线免费层/BYOK、默认无本地模型；实施时才绑定具体提供方、允许外发的
  数据类型、账户资格、费用上限和服务留存。免费不足不自动切付费，不默认为无限调用。
- 文档输出：保版PDF/可编辑DOCX/双语阅读器的优先级；有损备用路线不能替用户接受。
- 云历史/Drive/跨设备：完整盘点包含这些能力，是否重建云服务尚未授权；默认不传Key/Token。
- 平台生态：当前Windows x64应用内功能与手机App、Zotero、Google Docs插件是不同交付。

## 6. 官方补充资料与证据状态

- [安装与版本](https://immersivetranslate.com/zh-Hans/docs/installation/)、[当前仓库源码说明](https://github.com/immersive-translate/immersive-translate)。
- [高级配置](https://immersivetranslate.com/zh-Hans/docs/advanced/)、[Prompt变量和批量翻译](https://immersivetranslate.com/zh-Hans/docs/prompts/)。
- [功能使用](https://immersivetranslate.com/zh-Hans/docs/usage/)、[文档工具](https://immersivetranslate.com/zh-Hans/document/help/)、[隐私政策](https://immersivetranslate.com/zh-Hans/docs/PRIVACY/)。
- [浏览器合作](https://immersivetranslate.com/zh-Hans/docs/browserExtensionIntegration/)与[JS SDK](https://immersivetranslate.com/zh-Hans/docs/js-sdk/)为官方授权集成备选；并非公开全部内部源码。

本轮结论为静态调查和候选方案。未执行真实插件、付费功能、模型推理、音视频捕获、文档转换或集成冒烟。
后续在线偏好差量只读取官方服务页面、GitHub源码/许可/维护信号及原包YouTube字幕路径，没有实际调用API。
历史Electron 43.7.7扩展资格只作风险线索，当前43.8.4未复验原版兼容；不借此否定独立实现路线。

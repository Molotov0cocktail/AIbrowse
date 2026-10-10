# AIbrowse 第七阶段详细设计

> 本文件是第七阶段设计合同；审核与执行状态只看 progress。本文件不表示 E1 已启动或任一发布门已通过。
>
> 设计接管 baseline：`6bc4f00ab065d2c751d89ab120106aa4accce805`。
>
> 需求源：`Seventh_stage.md`；安全契约：`threat-model.md`；任务拆分：`tasks.md` 的 E1–E6；当前状态只看 `doc/tasks/progress.md`。

## 1. 目标、边界与工程决定

本阶段把既有 Browser、AI、Agent、Sources、Research、Watch 主路径加固为可安装、可恢复、可验证的 Windows 产品。
保留第一至六阶段的数据语义、权限矩阵、网络隔离和验收承诺；功能扩展不进入本阶段。
用户2026-10-04已授权E1–E6实现、验证、独立审核与收尾，Stage7完成后停止，不启动Stage8产品实现。

| 项目     | 本轮决定                                                                                              | 改变条件                                                    |
| -------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 打包     | `electron-builder` 目录包、NSIS 界面与全机 MSI，安装操作需 UAC，应用普通用户运行；精确版本入 lockfile | 当前资格或回滚失败时重定方案，不预授通过                    |
| 发布候选 | 未签名内部开发候选，显式标识；不公开发布                                                              | 公开渠道、证书及其权限明确后另行满足签名与发布门            |
| 更新     | 用户取得可信安装包后手动升级；无自动更新客户端、后台下载、自启或系统服务                              | 自动更新成为正式需求后单独设计来源、签名和失败处理          |
| 卸载     | 保留 userData；安装目录只放产品文件                                                                   | 清除用户数据是独立显式操作，当前卸载不顺带清除              |
| 本地 UI  | E1 首选固定 `aibrowse://app` 资产协议，只有构建资产白名单                                             | 可行性不通过时修订工程方案并保持任意本地文件不可读的 oracle |
| 数据传输 | 有版本的单文件本地备份容器，只含固定逻辑成员；不引入通用归档解压接口                                  | 等价方案须保留长度、路径、内容和恢复边界                    |
| 诊断     | 本地有界结构化记录；主动导出先预览，无自动上传                                                        | 不以排障需求扩大正文、凭据或机器数据采集                    |

未签名内部候选不等于最终 Release Gate。独立机器安装、手动升级和全部适用安全门仍是阶段关闭条件。
签名证书、独立机器等外部条件在实际需要时报告；不能以设计完成或同机新 profile 替代真实门。

## 2. 现状与需要补齐的差量

以下为 baseline 源码事实，不把待实现设计写成已具备能力：

| 源码范围                                             | 已有能力                                                            | Stage7 差量                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/main/index.ts`、`electron.vite.config.ts`       | normal/qualification 输出分离，UI 导航守卫，IPC 主窗口/主帧校验     | `SMOKE_MODE`、userData override、renderer 开发 URL 尚无完整 packaged 门；增加 release 构建与不可激活的测试入口 |
| `src/main/browser/session-manager.ts`                | 持久 Tab Session 的双权限处理器默认拒绝                             | 主 UI Session 同样闭合；下载处理和所有 Session 的安全策略统一验证                                              |
| `src/main/ai/config-store.ts`、`credential-store.ts` | Key 主进程读取、DPAPI 密文落盘；配置与 Key 分离                     | 已有 Key 按 providerId 取用，端点变更尚无凭据目标绑定                                                          |
| Sources/Research/Watch Store                         | 三库隔离；Sources v1、Research v1、Watch v5；共享迁移引擎逐版本事务 | Sources/Watch 已有迁移前备份，Research 缺少对应备份/恢复；需要整体维护、用户备份恢复入口                       |
| Sources/Watch 恢复代码                               | Store/Repository 层具备部分检查和恢复装配                           | `SourcesRestore` 是软删除恢复，不能当数据库恢复 UI；Watch Store 恢复也不等于用户可操作入口                     |
| `conversation-store.ts`                              | 50 会话/200 消息上限、JSON 原子替换、形状校验                       | 补读取前字节预算、闭合投影及损坏/超限文件的保留语义                                                            |
| `tab-manager.ts`、任务 Store                         | 网页崩溃状态、Research/Watch 遗留运行处理                           | 主 UI 崩溃恢复、跨模块 drain/重装配及错误提示需要一致契约                                                      |
| `logger.ts`                                          | 单行/滚动/保留预算和脱敏                                            | 结构化上下文、性能基线、诊断预览与导出                                                                         |

新模块职责由下表确定；名称可随实现整理，但不得扩大能力。

| 主进程职责             | 输入/输出                                   | 禁止的能力                                               |
| ---------------------- | ------------------------------------------- | -------------------------------------------------------- |
| RuntimeProfile         | 编译期构建类型、受控启动信息 → 固定运行配置 | 从网页、renderer 或任意 env 激活 release 的测试路径      |
| AssetProtocol          | 固定 scheme/host/资产 ID → 包内静态资源     | 任意路径拼接、userData、UNC、网络代理或通用文件读取      |
| CredentialTargetGuard  | 已校验端点变更 → 原生确认后配置提交/取消    | renderer 批准标志替代真人确认、Key 回读                  |
| MaintenanceCoordinator | 维护原因 → admission/drain/Store 关闭/恢复  | 暂停 UI 后仍留后台写者，或把超时算 drain 完成            |
| LocalDataTransfer      | 原生文件选择 → 有界备份/校验/恢复状态       | 任意源/目标路径 IPC、执行包内代码/SQL、复制整个 userData |
| StartupRecovery        | 主进程持久恢复清单 → 一致数据集或安全恢复态 | 猜测不明文件归属、默默覆盖原库、自动重放外部副作用       |
| Diagnostics            | 固定字段 → 有界预览和主动保存               | 通用日志/文件读取、内存转储、自动网络上传                |

## 3. E1：发布入口与能力边界

### 3.1 构建与启动

保留开发/验证入口，新增编译期 release profile 和独立输出目录。release 包只消费该目录的允许文件集；
测试装配、smoke、qualification、native qualification addon 和诊断 hook 不进入可达 release 模块图。
生产 preview 仍用于开发验收，不能等同最终安装包。

E1使用`release` mode输出`out/release/{main,preload,renderer}`。入口先做编译期分支转换，再由Rollup生成模块清单；
残留任何已渲染smoke/qualification/test模块即构建失败。原生产admission模块移到`watch/ipc-admission`，
不因历史smoke文件名将实际产品并发门排除。builder 26.15.3、fuses 2.1.3、asar 4.3.1、resedit 3.1.0为精确构建依赖。
产品名AIbrowse、package/app name保持aibrowse，appId为com.aibrowse.desktop；启动先固定现有appData/aibrowse数据根，
不把产品显示名改变误当数据迁移。CookieEncryption按原Electron EXE实读的Disabled保持关闭。

E1安全资格REPLAN：Electron43.4.0命中上游GHSA-qmv3-fv6v-rmhq（sandbox preload cache），官方明确无应用层替代修复。
据[官方安全公告](https://github.com/electron/electron/security/advisories/GHSA-qmv3-fv6v-rmhq)与
[43.7.7发行记录](https://releases.electronjs.org/release/v43.7.7)，同major更新到精确43.7.7，保持安全/资源阈值。
其余公告按实际功能适用性核对，不宣称版本命中等同产品可利用。新版本重做全量、build、dev/production及
实际packaged、导航/IPC/Session/fuse/ASAR资格；旧43.4.0壳证据仅作历史和反例，不冒充新版本通过。
Vitest固定4.1.11，锁闭包brace-expansion为5.0.12、undici为7.29.1，补齐可用安全修复。
构建树仍报告[http-cache-semantics共享缓存公告](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)的8项派生high；
该库无已发布修复，当前仅builder下载链存在、不进入ASAR；实际got默认HTTP cache未启用且构建配置未启用它，
不构成跨用户认证响应共享缓存。保留audit原件及不可达范围，不把生产依赖audit为0描述成整树无告警。

本机E1目录运行的工程隔离受MSIX KnownFolder虚拟化影响：声明路径和实体路径可能不同。
用户已明确允许清空现有开发数据后，工具可以把固定KnownFolder/aibrowse空目录作为合成根，
分别打开声明路径和解析实体路径，复验128位FileID、64位卷号、ACL、类型并持有根句柄；
独占marker/持久manifest证明本轮所有权，子进程复验同一目录视图和实际数据落点，Job确认全部进程收口。
这一替代不做旧profile的跨卷复制或同父rename；失败数据和journal保留，也不替代独立Windows验收。

实际EXE揭示MSIX文件系统视图会使同一声明目录的Node临时文件rename返回EXDEV。
保持逻辑KnownFolder/aibrowse、单实例identity和Chromium userData/sessionData路径；所有Node持久层统一使用
`realpathSync.native`解析并验证为同一对象的实体根，包括logger、凭据、配置、Conversation与三库。
这是同一目录的路径表示，不迁移/复制旧数据，不以copy/unlink代替原子rename，环境变量不能提供发行数据根。
启动前对固定Node成员及其既存子树，在两侧枚举中逐项核对每个已枚举成员的双路径可访问性、普通类型、dev/ino和精确native路径；同根表示也需核对子项。
包括配置/凭据的tmp、会话索引、数据库WAL/SHM及备份。只读元数据，不读取正文，不枚举Chromium或其它未知根成员。
双向流式逐项核对，不按文件累计总量拒绝旧profile，也不保存目录名称全集；不声称两个枚举器的名称集合已严格比较。
DFS只在一侧递归，另一侧只反向核对。
深度最多32层、每层至多两个目录迭代句柄且异常必关闭；现有产品仅生成固定浅层结构，超深目录不是既有产品生成形状。
拒绝可识别symlink/junction、非普通类型、普通文件nlink>1、路径偏移、缺项和对象差异。
Node API不提供全部Windows reparse tag信息，不宣称此检查构成OS沙箱；同账户本机攻击限制保持。
结构深度、权限、旧混合视图或身份检查失败均在业务写者与logger初始化前停止，以固定中文原生提示说明业务库未打开；
不把不一致视图当空库，不自动修改旧目录，也不由本次合成空根推断任意历史profile都兼容。
该检查只界定扫描内存/句柄，不声称总耗时恒定；实际启动成本纳入E4基线。

release 启动顺序：固定应用 identity/路径 → 获取单实例所有权 → 核对Node实体数据根并初始化logger → 安全 Session/资产协议 → 检查未完成恢复清单 →
打开数据 Store/执行已授权迁移 → 装配服务 → 打开业务 admission → 创建/接入 UI。
恢复未完成时只开放维护状态/用户恢复入口，Browser 可按明确隔离范围使用，不装配依赖不一致数据的业务写路径。

- release 忽略 `AIBROWSE_*` 测试开关、`ELECTRON_RENDERER_URL` 和测试 userData override；无法形成有效 release 配置时安全退出。
- 外部环境不得改变 UI 受信文档或产品数据根。开发和受控验收仍可保留明确隔离的测试配置。
- appId、App Name、version、安装目录与 `app.getPath('userData')` 的实际值在 E1/E5 资格中冻结。
  不凭新的 `productName` 猜测旧目录；保留现有账户数据，任何路径迁移先取得合成旧版本证据。
- 单实例锁先于 Store 写者；第二实例只聚焦当前窗口，不从命令行获得任意导航、恢复或文件打开能力。
- 打包资格实读最终 EXE 的 fuse：禁用 RunAsNode、NodeOptions、CLI inspect；启用 ASAR integrity 与 OnlyLoadAppFromAsar。
  禁用 file 额外权限与资产协议一同验证。需要新工具依赖时精确固定并审核其打包作用域。
  Windows EXE 必须包含与该 ASAR 对应的 `Integrity/ElectronAsar` header 资源，并通过实际篡改测试。
  CookieEncryption 保留现状；以后启用须验证单向 Session 升级与程序回退限制，不能当无影响开关直接切换。
- 对最终 EXE 注入 Node、inspect、测试 env 和替换 ASAR 反例；不能只检查构建配置字符串。

### 3.2 UI、IPC、权限与下载

资产协议使用固定 `aibrowse://app` 入口和构建生成的资产映射；URL 解析后校验 scheme/host/路径与映射，
拒绝编码穿越、反斜杠、盘符、UNC、ADS、空字节和映射外文件。不得把 pathname 直接拼到磁盘路径。
只服务已打包资产，不代理 HTTP、不开放 userData；CSP 限定脚本/样式/图像来源，禁止任意连接、子框架、对象和表单提交。
合法本地样式需要的例外单列，不为恢复页面功能开启 `unsafe-eval` 或远程脚本。

UI IPC 统一验证当前窗口、主帧、当前受信文档/世代以及 payload 闭合 schema；窗口重建后旧 sender/句柄失效。
远程 Tab 没有应用 preload；所有窗口保持 sandbox/contextIsolation、关闭 Node，保留 webSecurity。
主 UI 和每个 Tab Session 都设置权限 check/request 策略；网页权限默认拒绝。已承诺的“复制当前视图”
若需 clipboard 写权限，限定 UI、规范化安全投影和该能力，不允许剪贴板读取或给网页开放同权。

`window.open`、UI 非入口导航、Tab 非 HTTP(S)/既有受控空白页导航继续拒绝。
E1 增加 Session `will-download` 拦截：没有产品下载入口的下载一律取消，不能自动保存、启动可执行文件或调用外部 shell。
此处不新增下载管理器。用户选择应用内导出的原生保存对话框走专用主进程服务。

IPC文档令牌由main在受信主文档提交时生成，经隔离preload持有且不向renderer暴露；所有invoke/send携带令牌。
导航期间暂停授权，主进程明确拦截且原文档身份不变时恢复；新文档提交/窗口销毁后旧令牌失效。
实际Electron反例表明`about:blank`可能跳过will-navigate/will-frame-navigate，但触发导航开始和文档提交。
因此共享产品装配在导航开始暂停令牌、提交时核对固定入口；非入口至多异步重载固定入口一次，之后保持业务通道关闭。
不在native导航回调中同步stop（实际造成Chromium崩溃的失败原件保留），不把“同步拦截所有导航”当作平台保证。
开发同源的其他path也不能获得业务IPC。Research复制使用专用`research:copy-table`，仅接收既有导出视图DTO，
main读取已验证Result并重新排序/筛选/规范化，复制前再次核对文档世代；不开放通用文本或剪贴板读取通道。

### 3.3 已有 Key 与 Provider 目标绑定

主 UI 被攻破后能调用合法 bridge，因此 sender 校验不能证明真人授权。现有 Provider 配置可以改变同一 providerId
的 baseUrl；必须防止已有 Key 随变更被发往新目标。

1. 主进程保存“已授权规范化端点 + 配置版本 + credential generation”的绑定；不返回 Key。
   端点包含 scheme、host、有效端口和规范化 API base path；畸形 userinfo、query/fragment 等输入拒绝。
2. 初次绑定既有 Key、改变绑定端点、从无绑定旧配置迁移时，使用主进程原生确认显示确定性的旧/新目标及传输类型。
   renderer 不能提交 `approved=true`、选择提示正文或自行回填确认结果。保持原 HTTP 兼容，但明示其传输限制。
3. 确认前冻结提案；确认后重验配置版本、Key generation、窗口生命周期及提案有效期。取消、过期、并发变更均零提交、零新目标请求。
4. 在途请求使用不可变配置/绑定快照；配置切换不能改写其 Authorization 目标。新请求只读取已提交且匹配的绑定。
5. Provider redirect 不允许把凭据转移到未绑定目标。若当前适配器无法证明授权头和重定向边界，安全拒绝重定向并给受控错误。
6. 新 Key 的设置本身仍只写；Key 删除/替换作废旧绑定世代和未完成确认。绑定持久化失败不得留下“内存已授权、磁盘旧状态”的成功回执。

E1具体契约：确认有效期60秒，配置与绑定在provider-config v2中单文件原子提交；v1配置读入无绑定，首次原生确认后迁移。
每次Key写入（包括同值）创建新UUID世代；旧credentials v1用密文字节摘要标识旧世代，写/删时迁移v2，摘要不是密钥授权。
Provider调用使用main私有WeakMap中的不可伪造快照，并在读Key前后复验；redirect一律安全拒绝，不能转发到第二地址。
Key只在safeStorage可用时持久化；原内存回退继续支持，经相同原生目标确认后仅本次运行有效，重启不继承该授权。
读取及配置预算：最多64个Provider、配置文件256KiB；baseUrl原串2048字符、providerId为1–128个受限ASCII字符、
model为trim后1–256字符且拒控制字符，Key最多16384字符。目标拒绝userinfo/query/fragment、反斜杠、点路径段、
编码控制字符/分隔符/嵌套百分号；规范化scheme/host/有效端口、保留path大小写、百分号HEX大写、移除尾斜线。
凭据持久层与内存回退按Provider ID并集合计最多64项；单密文128KiB、credentials文件9MiB。
预算覆盖最大合法Key的UTF-8、DPAPI及base64膨胀，另保留固定结构余量；实际safeStorage最大输入作资格核对。
配置/凭据先open与fstat，再有界读取并探测尾随字节；损坏、超限和读取失败只返回不可用，不作为空库覆盖原件。
Key写删使用全局单调mutation epoch，使任何并发Key变更都令未完成确认过期，避免任意ID造成无界Map。
首次保存Key但取消目标确认时，设置仍显示hasKey并说明尚未授权；hasKey只返回布尔，不返回密文或Key。

这保护已有凭据目标；不声称被攻破的 UI 不能读取已向 UI 展示的数据、调用合法业务写接口或伪造当前 renderer 内的普通确认。
完整边界和对应红队见威胁模型 §2、§4。

E1受影响UI生命周期：ContextBadge只负责提示，按活动Tab状态与请求世代合并preview；加载期间不反复注入采集脚本。
每个存活Tab最多一个在途请求，旧文档/旧effect结果不可发布。读取失败显示预览暂不可用，无Tab才显示无上下文；
提问与Agent继续按原契约实时采集，不使用徽标缓存作为实际模型上下文。

## 4. E2：数据、迁移、备份与恢复

本轮恢复验收改用 `tasks.md`“当前恢复验收路线”的构建隔离、真实产品装配及分层补证。
下面历史验收工具的具体宿主/调用/资格顺序不再是当前前置门；产品协议、数值阈值、失败保全和可信 oracle 保持。
工具 dialog 适配不证明原生交互；发行包隔离和真实原生交互必须另有证据。未变容量/中断证据按源码绑定复用。
实际恢复一致性按任务合同的固定生命周期审计差量验证：合法 reconciliation 有精确数量、字段、时间与历史继承约束，
其余业务投影不变。只读 SQLite oracle 在新的合成副本运行，保留产品退出原件的零 sidecar 门。

### 4.1 数据范围与容量资格

备份是用户主动保存的私有数据副本，可能含 Sources note、Research 引用摘录、Watch old/new Evidence 和保存的对话文本。
这些是既有有界持久化字段，允许进入用户明确选择的备份；普通 CSV/Markdown 导出的限制继续保持。
用户自行写入 note/对话的私密文字可能随备份保存，不声称可识别并移除所有自由文本秘密。
Key/DPAPI 文件、Provider 配置、Chromium Cookie/Session、采集原始正文、内部 reasoning、raw Provider 协议记录、日志和诊断原件不进入备份。
合法 Conversation 用户/助手文本及已允许保存的有界字段属于上述备份范围；不为备份新增内部模型过程的持久化。
恢复保留本机 Provider 配置和凭据；在新机器必须重新配置。恢复数据不能替 Provider 重新授权目标。

备份容器有固定 magic、formatVersion、有界 manifest 和固定逻辑成员 ID；成员只映射到主进程固定目标。
manifest 记录产品版本、各成员 schema、长度、SHA-256、同一维护快照 ID；不含原机器绝对路径或执行指令。
Sources/Research/Watch 是不可拆分的一致数据集合，不提供任意单库恢复。Conversation 随同该批次，
不拼接不同备份批次或把未选择库留在原位造成引用混代；缺失成员的原始状态也必须由 manifest 明确表示并通过关联校验。
容器逐成员流式读写，声明长度、实际长度、总长度和 EOF 必须一致；拒绝重复/未知成员、尾随数据和缺失必需成员。
SHA-256 证明字节一致性，不证明发送者可信；所有导入内容仍须 schema/语义校验。

E2容量契约分层冻结。合成库、Git真实历史migration及极端消息先资格化读前资源界限；
随后允许实现只接固定可信夹具的编译期语义扫描/迁移函数及维护接线，以测定其实际成本。
不可信容器读取入口必须等完整时限、IPC、进程终止及UI预算冻结后才能实现。
这消除“测产品扫描前禁止实现产品扫描”的循环，不降低安全或最终验收门；测量后不能扩大已冻结阈值迁就失败。
最终完整备份/恢复仍在同一冻结预算内真实验收，准备工具通过不授E2 PASS。
既有 Watch/Research/Sources 数值预算继续生效，新预算不得截短合法旧数据以制造成功。
超限旧 Conversation 文件保留原件并进入该会话可恢复错误态；禁止静默截断、删除或空文件覆盖。
读文件前检查字节量，逐字段投影；文件名只取主进程合法 ID，拒绝旧索引中的路径穿越 ID。

完整 50×64MiB 会话的文件链路资格使用独立 `tools/data-qualification/full-transfer/` 薄 Electron 入口。
复用已有合成三库及完整会话夹具，以64KiB块只向一个全新profile排他导入一次，不重新生成正文、不硬链接或覆盖原件。
导入独立限120s，另30s只确认原Job归零；单进程、提交内存2GiB，100ms采样RSS门1GiB。
随后直接使用生产TransferFiles、guarded Electron adapter、原worker/controller/Pipeline：
backup执行run→verify→publish，再以新operation读取同一发布容器执行restore→verify，止于staging。
每动作verify后另由一个工具专用utility只读固定work三库，以六条编译期COUNT验证
5000 Sources、30 Research、200 Rule、2800 Event、8400 Evidence pair及1030 Digest；
仅返回闭合六整数，不接受外部SQL/路径、不改生产worker。两个额外读回utility也须真实Guardian先授权、后IO、实际退出并退休。
每次读回最多10s且扣该动作原SQLite90s剩余，包含启动、授权、读取和退出退休；夹原总截止，不额外续租。
每动作各保持原1500s总工作及各阶段余额、最多10s实际utility退出确认；不得将未用排水/回退额度借给扫描。
整轮外层3060s涵盖两动作及入口/最终有界记录，另30s只作实际归零；末尾IO/句柄关闭仍在原工作期限内。
真实Guardian ACK、utility实际退出/退休和finishShutdown均为硬门，不能以noop或Map替代。
外层原子Job设进程数24、单进程提交2GiB、整Job提交4GiB硬限并回读，100ms采样每成员RSS≤1GiB、整树≤2GiB。
这是工具资格资源门，不新增产品RAM承诺，也不把采样值当硬RSS上限。输入导入与产品工作时间分开报告。
PID列表是可变长观测，active限额不能充当数组容量。每次采样先读32槽，仅在Win32返回
ERROR_MORE_DATA（234）时以固定128槽立即重读一次；两次共用原截止，不等待或续租。
只有API成功、assigned=count且count不超过实际容量的完整列表可进入采样；其它错误、第二次234、
不完整/非法/重复PID均失败。列表可以包含已退出成员，但每项仍须持有并核对精确native handle、
创建时间与原Job成员，只有该同一handle已signal才可排除RSS；OpenProcess失败或身份未知不跳过。
已完成上述身份校验且已signal的采样句柄及时释放并从持有表移除，避免工具自身延迟Job退出计数；
累计采样身份仍限128个，未知或未signal者继续持有，原Job及精确root句柄持续保留到退出门。
逐项观察为未signal的候选累计仍不得超过import1/transfer24；这是一项保守采样门，不声称多个API为原子快照。
原生active/commit/RSS/时间门和原Job实际0、精确root handle signal退出门不变。
诊断只记录两次API的固定整数容量、返回长度、BOOL、错误和头计数；失败头不能作为可信成员事实。
固定128槽仍失败时保留原件并重定观测方案，不继续扩容。依据为Microsoft的
[PID列表结构](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list)与
[Job计数语义](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)。
空间按实际分配单元和生产transferSpaceAllocation计算两scope、导入、发布物及证据共存，另留1GiB余量；
保留全部原件，不能只靠固定32GiB预估准入或清理上一动作压低峰值。首个失败停止，不重试或延长门。
该资格覆盖满字节会话的生产备份/发布/恢复staging与主进程摘要核验，不代替真实服务图排水/UI、
原生选择确认、release/fuses、DatasetSwitch/回退副本/冷启动健康、物理最大三库或中断及磁盘不足门。

E2容量资格需区分“支持导入的资源范围”与“历史合法数据的最大值”：实际旧Sources无总行数硬上限，
Conversation部分持久字段无总字节上限，不能由有限合成测量声称历史合法数据有有限最大值。
冻结预算须覆盖已验证合法包络；超限明确进入可恢复错误态并保留原件，不静默截断、跳过成员或声称恢复成功。
SQLite文件长度还包括页/索引开销，不能直接把Research/Watch业务投影预算当作物理文件上限。
历史Watch migration存在同user_version的真实定义变体；根据Git中精确历史schema白名单和逐字段语义复验识别，
在staging显式规范化后再验证当前定义，不仅凭user_version接受，也不把可支持的已知历史变体误判敌手SQL。

读前硬界限依据现有容量、5GiB流I/O及Conversation投影资格冻结如下（MiB=1048576B，GiB=1073741824B）：

| 对象             | 硬界限与计费口径                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| 容器             | 5GiB，包含头、manifest、四个固定成员及全部子成员头                                               |
| 三库物理文件     | Sources 512MiB、Research 64MiB、Watch 512MiB；业务预算另行同时校验                               |
| Conversation消息 | 完整闭合消息紧凑JSON UTF-8最多4MiB，含所有字段名/标点/转义                                       |
| 会话             | 输入文件与闭合输出各最多64MiB，最多200条消息，不以紧凑输出可容纳为由无界读缩进旧文件             |
| 会话索引         | 输入与输出各64KiB、最多50个不同UUID；保留原UUID大小写，身份按忽略大小写去重                      |
| JSON结构         | 每索引/会话262144个值节点；对象/数组/标量各计1、键不另计；根深度1，输入最多16层、闭合投影最多6层 |
| Conversation成员 | 3201MiB，包括index、子成员头和所有会话；必须同时满足上述每项界限                                 |
| 元数据           | manifest与校验结果分别4KiB，闭合字段，禁止正文/路径/凭据                                         |

Sources5000条最大字段样本151023616B、Research30任务约15011840B、Watch已测逻辑预算99.228%的
物理样本110419968B是界限依据，不是历史总量上界。旧合法CJK消息紧凑编码3145839B否定原1MiB候选，
4MiB新界限和64MiB会话均已测边界值；超限原件保留并给可恢复错误，不删字段、消息或整个成员后声称成功。
Conversations完整51子成员理论最大3355512024B，四成员预算加元数据4497346784B，均低于各自外层界限。

Conversation本地读取与备份使用同一闭合投影。先打开固定成员并fstat检查长度，再有界读取、严格UTF-8与JSON预检；
不先readFile整个文件才检查上限。未知字段不带出，已知字段非法、孤立tool、重复UUID或超预算整成员拒绝，
不能丢字段/消息后报告读取成功。不存在的初始数据与损坏/IO失败严格分开；后者保留原件并置该Conversation域
为持久的recovery-required，拒绝后续写入、删除、切换ephemeral及会话新请求，避免间接覆盖坏成员。
构造与惰性历史读取失败均返回受控中文错误，不能令主入口崩溃或伪称会话不存在；状态DTO只含state/code，
不含文件路径、正文或凭据。恢复后由完整新数据世代重建Store/Service，不用清除内存错误标记冒充恢复。
写入前完成消息与索引预算校验；已保存会话达到50项时，拒绝保存模式切换且零正文写入。
切换失败只回滚本次排他创建、由打开句柄取得身份且清理前身份仍相同的文件，既有临时文件和异身份替代文件保留。
持久化失败后禁止后续工具/Provider工作，终态明确未完整保存；Agent已执行或尝试的步数和审计事实不能改成零。

数据库内JSON先校验UTF-8字节、语法、值节点数与深度，再交JSON.parse展开；字符串内标点和转义不计为结构，
对象键不计节点；进入业务对象的同一对象重复键（包括转义后等价的键）整值拒绝，不能靠后值覆盖绕过字段检查。
Research单JSON最多500000B（沿用每任务总持久化预算），深度16、节点最多500000，
该节点数是字节量对应的保守上界；随后仍做闭合字段、枚举、归属及整个任务500000B检查，不扩大Research预算。
历史字段没有更小持久化硬限时不借运行时输入默认值裁切。扫描明确区分结构/归属校验和无法从备份重证的原网页真实性。

Sources journal的before/after投影各最多2MiB、result_payload最多64KiB、source_ids最多4KiB，
均深度16、最多131072值节点；每Source最多20标签、journal最多100条entry，
每entry的source_ids/快照最多20项，沿用正式写入门。
扫描全部六张业务表，不把5000条容量样本变成历史行数上限；URL按既有规范化结果验证，不能将原始输入2048字符
直接重用于序列化后URL。历史journal对已硬删除Source的引用按Undo/幂等原语义验证。
FTS视为可重建派生索引；业务验证成功后只在私有staging用固定语句rebuild，再执行FTS5 integrity-check(rank=1)
与文档数复核，失败回滚并拒绝发布。普通MATCH未报错不能单独证明索引完整，原输入库零写入。

Watch先在SQL中核对列类型/有界标量并计完整逻辑字节，拒绝TEXT主键NULL使SUM漏账和未计费列超长，
再逐行读取全部15表；沿用100MiB业务预算，不通过prune后再声称输入合格。typed JSON深度16，节点上限如下：

| 字段族                                            | 最大值节点            |
| ------------------------------------------------- | --------------------- |
| schedule / outcome / health / run_stats / privacy | 4                     |
| target                                            | 128                   |
| condition                                         | 54                    |
| before/after Source projection                    | 7                     |
| affected_rule_state                               | 1201                  |
| source_ids                                        | 101                   |
| period                                            | 3                     |
| before/after Evidence value                       | 6                     |
| baseline projection / Digest facts / explanation  | 65536 / 49152 / 12288 |

节点界限来自闭合结构；没有更小历史字节上限的typed字段仍受100MiB全库预算约束。
Event Evidence沿用完整ChangeEvidencePair序列化总和32768B，不只计before/after值。
所有持久Evidence两侧URL须等于http(s)安全投影（无认证、query或fragment）；present哈希须为64位小写hex，
未截断值的UTF-8字节与SHA256必须可由摘录重算，截断值只验证完整字节数大于摘录字节及哈希形状，不能冒充重证完整正文。
两侧完整类型化值完全相同的Evidence不能冒充变化；该判断不以哈希相同单独代替值比较。
唯一语法例外是Stage6已承诺原样保留的legacy-opaque response_metadata_json：在100MiB全库预算内
用迭代语法检查、不调用JSON.parse、不解码键或展开对象；深度/节点仅受输入字节的自然上限约束，保留重复键原字节。
它不进入renderer、模型、条件或采集；只有满足既有小字节界限、严格v1结构及完全canonical编码时才可提升为DTO。

剩余容量资格只做一轮实际Electron：同一真实主入口空闲及在途维护各一次、固定utility语义扫描/历史迁移一次。
沿用已验证20秒单次acquire至ready工具预算、30秒utility、90秒进程工作与额外最多30秒Job收口；清理窗口不能继续业务工作。
票据期限覆盖90秒总工作窗口，与20秒排水监督分离。固定顺序为空闲维护ready→同代一致副本utility扫描→恢复→在途维护；
活动Research创建引起的正常历史保留变化单列，不能把容量扫描的30任务样本误报为之后仍有30份。
使用非release实际main/Electron.exe/真实UI与production Research factory，只经专用编译期入口注入固定离线端口；
常规与release产物排除该入口。本轮不是发行EXE或独立Windows验收，未变packaged utility机制复用已有资格。
固定5000 Sources、30 dense Research、200规则/2800事件/8400证据对/1030 Digest、50会话且其中1份64MiB。
原Research dense样本在测量后已删除任务，原dense库未盖正式user_version；工具重新生成已知合成副本并核计数/版本，
不把空闲页或未声明版本原件冒充产品已接受的数据。最多2GiB本轮产物，来源是约344MB集合的4份加历史/构建余量；
不等同完整5GiB恢复空间预算。既有5GiB顺序I/O与utility敌手七场景不重复执行。
UI使用已验证50ms采样、往返≤750ms、样本间隔≤1000ms，各固定相至少1秒/6次真实往返；
从首个样本到恢复相结束连续核对样本间隔，不能遗漏相之间的停顿。
人为保持时间单列，不当自然排水耗时。任何不符停止并保留原件，不自动重跑或延长门。
首轮实际在途资格暴露工具的过约束：Watch executeRun可先结束取消回执，但其原acquisition仍由维护屏障持有。
人工保持期间检查每个受控底层wait仍pending且主维护仍draining；不能要求外层编排一律pending。
ready之前仍必须证明全部原观察（含executeRun）成功结束，时间逐项不晚于ready；断言前持久命名状态供失败诊断。
纯测试须同时区分真实正确排水与只等外层回执的提前ready反例。修正并独审后允许同固定容量/预算完整续验一轮，
因为四相及相界连续UI必须来自同一进程；首轮已完成扫描结论保留适用范围，不能由跨轮拼接补出连续UI通过。
实际主入口资格及越界反例完成后，产品校验协议冻结为双向合计4KiB/帧、16帧/操作、64KiB总量，
只有init/ready/至多8个阶段/唯一terminal/cancel及4个控制余量；禁止逐会话无界进度消息。
结果只含固定成员摘要根、计数及闭合错误；完整正文、SQLite配置清单和逐会话明细不通过IPC返回。
该限制是应用层接收门，不声称阻止Electron在回调前为畸形消息分配内存。

撤回未冻结的300秒候选。实际Electron Conversation扫描为一份64MiB加49份空会话，首轮阶段6.272秒，
不能用先前单独投影耗时直接外推50份完整成员。完整实现采用以下1500秒受监督工作预算，另最多10秒确认所拥有进程退出：

| 阶段                                     |   上限 | 依据及边界                                                      |
| ---------------------------------------- | -----: | --------------------------------------------------------------- |
| 维护排空                                 |   20秒 | 既有门；失败零复制/切换                                         |
| 旧数据普查、回退复制及哈希               |  120秒 | 实际旧集合O可超新容器上限；超过期限保留原件、安全停止           |
| 容器/成员流式复制、哈希、flush           |  150秒 | 约3×4×已测5GiB顺序I/O 12.014秒向上取整；不保证任意慢盘成功      |
| 三库完整性/schema/业务/迁移/FTS/跨库检查 |   90秒 | 真实固定样本相关阶段约19秒；复杂输入仍由期限安全拒绝            |
| Conversation投影及实际输出读回           | 1000秒 | 50×20秒，单份20秒约为实测6.272秒的3倍；集合最大容量仍须最终实测 |
| 发布或回退                               |   60秒 | 持久清单、rename、文件核对                                      |
| 重启服务装配及健康确认                   |   60秒 | 只允许一次持久记录的启动尝试，失败保留恢复态                    |

每阶段取自身期限与总剩余期限的较早者，阶段消息不得续时；取消、失败和迟到成功语义保持。
单会话20秒只作内部协作检查，主进程独立监督整个Conversation阶段，不能冒充逐会话native硬终止。
relaunch前后单调时钟不跨进程拼接；清单记录剩余阶段和一次启动尝试。离线时间不算受监督工作，重启不能重置额度。
10秒内不能确认实际退出则recovery-required且禁止发布；不以exit0单独授权成功。
这些是进入有界实现的工程合同，不是全容量已通过声明。允许据此实现容器/监督/恢复，最终全路径仍需证明
50份64MiB集合、物理上限、磁盘不足、旧O超时、逐崩溃点和真实UI/重启；任何失败不得事后调宽预算。

### 4.2 维护协调与一致副本

主进程维护状态固定为：

```text
idle → requested → draining → snapshotting / validating / preparing
     → switching → verifying → completed
任何步骤失败 → failed 或 recovery-required
```

同一时刻只允许一个维护 operation。renderer 只能请求已知动作并读状态；不能调用任意阶段或指定数据库路径。
接口最小集合为 `getStatus()`、`requestBackup()`、`requestRestore()`、`cancel(operationId)`；
路径由原生 dialog 获取，返回 renderer 的 DTO 只有操作 ID、阶段、进度和受控错误，不包含文件正文或 Key。
取消只在可安全取消阶段接受；开始切换后由恢复协议完成到一致态，不以关闭窗口中断文件替换。

维护过程先停止新业务 admission 与 Watch/Digest 调度，等待或取消 Agent/Research/Watch/Provider 在途工作，
排空 Source observer 与跨库 journal 消费，再关闭需要替换的数据句柄。drain 超时不能继续复制/切换。
不得只冻结 UI 而保留后台写者；UI 只读浏览可在经过证明不会触碰维护数据的范围保持可用。

维护接线采用主进程单调世代。各参与者提供同步 `pauseForMaintenance(generation)`、
异步 `drainForMaintenance(generation)`、同步 `prepareResumeAfterMaintenance(generation)` 与
`resumeAfterMaintenance(generation)`；先完成全部恢复准备，再依序恢复域服务，最后开放总准入。
准备只核对同代本地状态与重建调度索引，不启动采集、模型或通知；总准入也约束后台回调，防止部分恢复产生新工作。
重复同世代幂等，错代、旧代、未真实排水或永久退出后均拒绝恢复。主协调者先在同一同步段关闭
全部新业务入口、定时准入和通知投递，再取消并等待已准入工作；维护不是调用旧 dispose/shutdown。
排水必须覆盖原始 Provider/工具/acquisition Promise、被 Promise.race 留下的工作、Provider 解析、
usage 写入、导出对话框后续和精确 task-owned Tab 清理。活动计数或 UI 终态不能单独授予排水成功。
Conversation/Agent 原交互取消与总时限保持；额外排水只决定何时可快照或关库，不延迟已有取消反馈。

Sources 的已准入内部读写和同步 Watch observer 保持可用，直到所有生产者及其续体结束；
然后封闭内部数据库访问并核对未决跨库 intent。不能在生产者终态落盘前关闭 Sources，
也不能为“排水”调用会产生新外部动作的 Digest.resumeActiveCycles 或 notification.drain。
通知维护暂停只阻止新 claim；已有同步投递须完成终态，未 claim outbox 保留。预览请求统一持有可取消
控制器，维护后旧预览/授权不可发布或复用。已显示的导出对话框返回后须复核世代，旧请求零文件写入。

维护超时或取消后仍持有所有未结束工作与旧数据库，零复制/切换；迟到成功不得使失败 operation 复活。
只有显式重新核验真实静止、数据一致且未进入切换后，主协调者才可恢复原数据集的准入；否则保持失败/恢复所需态。
重新装配后全部闭包必须指向同一数据世代，不能沿用旧 Repository/SourceService/usage writer。
恢复调度保持 HostRequestGate 历史、已消费 slot、Digest cursor 与已 claim Provider 状态，不自动重放外部动作。
完整排水时限与产品 UI 响应预算由本节容量资格和实际接线测量共同冻结；150ms 合成延迟反例不充当天然排水时延。

首次接线先限定为同一数据集的暂停、核验与恢复，不关闭或替换数据库。真正恢复文件后必须重新装配完整数据世代，
包括全局工具注册表、Source observer、usage writer、调度与通知闭包；同数据暂停成功不授予换库成功。
维护票据仅在主进程内由对象身份绑定，协调各await之后及恢复各阶段之前复验期限、取消和退出状态。
终态持久化或已确认数据写入失败必须保持失败事实，不能在下一轮pause时清除后授予快照；失效Runtime所有权保留至明确恢复。

创建备份时在同一静止逻辑点生成 Sources/Research/Watch 一致 SQLite 快照和 Conversation 投影，
使用 SQLite 一致备份能力或已证实的关闭后副本；不单独复制活库 `.db` 而漏掉 WAL。
快照检查完整性、外键、已知 schema、各域形状/预算及 Sources↔Watch 关联。
跨库扫描仅接同一静止批次、已通过各自schema/业务扫描的Sources与Watch句柄，零写入、零reconcile/Session授权。
prepared/source-committed的Source cleanup intent拒绝发布；complete/aborted按已解决历史处理。
enabled Rule的Source必须存在、未软删且启用，locator重算一致；存在Source的非deleted Rule版本须与同代Source相符。
paused Rule可保留旧locator或缺失Source，不能覆盖既有用户/健康暂停原因；deleted Rule为历史终态。
Digest固定sourceIds及归档事实可保留已删除Source的历史，不能按当前sharing反向删除本地历史Evidence。
按既有最多200个Rule及每schedule最多100个Source ID逐项prepared主键查询，不将5000条容量样本作为Source总行数限制。
所有成员通过后才写 manifest、完成容器并发布到用户选定目标；失败不产出“成功备份”，不删旧有效备份。

#### 4.2.1 数据转移服务的退出排水

DataTransferService 作为 RuntimeShutdown 的 producer 暴露 `beginShutdown()` 与
`drainBeforeClose()`。前者永久拒绝新的 start/recover/cancel，取消活动的非 handoff 工作；
后者等待其原始 start 与显式原代恢复 Promise 真正结束。服务须先登记拥有的 Promise，再调用可能同步
重入退出的原生 picker、确认及其他端口；早失败 DTO、取消信号和 worker kill 返回都不能代替原始工作结束。
原生窗口尚未返回时继续持有其原 Promise，不伪造关闭。已进入 handoff 的持久登记由原操作完成并保留现场，
已成功登记的 awaiting-restart 不 abort；退出排水不自动恢复业务、不重跑操作。

所有拥有的工作结束后，还须从主进程物理状态端口确认子进程已实际退出、原维护排水已结束，并核对协调器
pending=false；不能证明时退出失败且保留句柄。退出检验不重新授予数据读写或延长原 1500 秒工作账本。
外层最多 10 秒的退出监督只能使本次退出受控失败，不能把仍在运行的工作标为完成或继续关闭数据库。
主进程 requestRelaunch 端口只登记 relaunch 意图并返回，随后通过下一调度轮启动退出；不得在该端口内
等待一个反过来排空当前 start Promise 的 shutdownRuntime，以免形成自等待。

### 4.3 迁移与导入验证

普通启动在任何业务 Store 打开之前，经固定 startup-probe utility 对三库执行只读预检。
预检包含正式 SQLite user_version（含 WAL 视图）、闭合 schema、quick_check 与外键检查，
只返回固定根及 DB/WAL/journal 身份；不扫描完整 Conversation，也不冒充全业务语义校验。
缺失、空白和当前兼容 schema 可继续正常装配；历史 schema 必须先走整批迁移；未来版本、坏库、
孤立附属文件或身份不明进入恢复入口。预检只有结果及实际退出、守护账本退休同时成功才可继续。
主进程在开放 Store 前复核原件身份。预检消耗本次唯一 TransferBudget 的 SQLite 阶段额度，
后继 migrate 共用同一账本和绝对期限，不因换 utility 或启动装配重置。

SQLite 的 readOnly 打开不保证操作系统零写入：读取已关闭的 WAL 模式库时，SQLite 可能创建
空 WAL 和共享内存辅助文件。预检不改业务页、不改变 journal_mode、不修复或迁移原库。
仅对原本存在 DB、原 WAL 缺失的当前域，在该域 SQLite 句柄关闭后立即检查一次允许的转换：
root、域目录的卷与文件身份不变，DB 及 journal 的完整文件身份、大小与时间不变；
目录时间可因 SQLite 新建辅助文件变化，不能将其当成业务输入变化。新增 WAL 必须是严格 0 字节的普通单链接文件。
将此刻 WAL 的完整身份纳入结果，后续全域收口及主进程开放 Store 前均按该身份严格复核。
已有 WAL 的任何变化、新增非空 WAL、孤立辅助文件、DB 或目录变化仍须拒绝；不得给主进程复核
添加同样的转换豁免，或在整轮结束时重新认领迟到 WAL。共享内存只作 SQLite 协调辅助，不作为业务数据证据。
该平台边界见 [SQLite WAL 的只读数据库说明](https://www.sqlite.org/wal.html#read_only_databases)。

整批迁移由主进程产生固定 migrate job，不向 renderer 开放迁移动作。迁移输出须经过相同的
三库、Conversation、跨库及主进程工作成员校验；实际退出后登记 active/handoff，正常关闭并经
守护程序重启，再由 DatasetStartup 执行可恢复切换和只读健康期。启动准备也是退出排水的生产者，
其原始 Promise 和子进程退休未结束时不得开 Store 或授正常退出。

三库沿用编译期 migration 和 prepared statement。每版本事务只保证当前版本步骤回滚；多步骤升级或多库升级失败
可能保留已成功的步骤，错误文案不能笼统宣称“全部回到升级前”。Research 增加迁移前备份和用户恢复入口。
升级前保留完整一致的旧数据集；未知未来版本、损坏、锁冲突、备份失败均先安全停止受影响业务，原文件保留。

导入先放入本次 operation 私有 staging。SQLite 输入按敌手文件处理：读前预算，在隔离副本以只读、无扩展、
受控安全配置校验；已支持版本对应的表/列/索引/trigger/view 及定义均须匹配固定白名单，
并做完整性/外键、字段投影、业务预算和跨库引用校验，拒绝未知对象或定义漂移。
不运行包内 SQL/迁移脚本；本程序的编译期 migration 仅在 staging 执行，完成后重新验证。
如果保存的状态含运行中任务，按 §5 的 interrupted/uncertain 语义规范化，不自动执行旧外部动作。

不可信 SQLite 的校验与 staging 迁移由主进程监督的独立、可强制终止进程执行；主进程持有该进程的生命周期和期限。
`node:sqlite` 同步调用可能阻塞 native 层，主线程 JS timer 或 Promise race 不能构成限时保证。
执行进程首选固定 entry 的 Electron `utilityProcess`，先做 packaged 下 native 阻塞与强制终止资格；
E1 要求关闭 RunAsNode，不能默认采用 `child_process.fork`。仅接收本次 operation 的固定 staging 成员 ID 和闭合动作，
路径由主进程已登记的 staging 映射提供；不接收 renderer 路径、SQL、脚本或任意命令。
其环境、配置及 IPC 不注入 Key、Provider 配置或 Chromium Session；IPC 只返回有界状态/计数/校验摘要和错误分类，
不返回数据库正文，畸形/超预算响应安全拒绝。文件隔离和协议约束不等于 OS 沙箱，不声称该进程无本账户文件权限。

实际接线使用主进程登记的最多4KiB闭合bootstrap参数，包含operation、snapshot、独立数据世代、固定实体根、
产品版本及可选原生选中文件的身份/长度/时间戳；不从环境变量或renderer接收上述映射。
恢复输入直接只读访问已登记的原文件，不先复制整个5GiB容器；原件身份在开始与结束复核。
utility使用固定编译入口、空execArgv、私有cwd/TEMP及最小SystemRoot环境，标准输出忽略，不注入Chromium Session。
主进程在fork同一JS调用轮订阅退出/消息；保留确切child直到实际exit，kill返回值或原生error不能代替退出确认。
消息到达时即验证init及各阶段许可，不能排队后用后来发送的ACK追认提前的result；观察exit后不再发送消息。
结果增加固定backup输出摘要（backup必有、restore/migrate为null），仍受4KiB单帧和原总帧/字节预算限制。
主进程在exit后独立复算摘要。backup的Conversation摘要指固定conversations.bin；restore/migrate指最终目录的
dataset-tree-v1摘要，解释由闭合action固定，不能混用容器wire摘要与待切换目录摘要。
backup不额外生成会话目录副本；restore保留raw中的bin及work中的目录，migrate按同样N/W布局投影。
活WAL库的只读SQLite backup可能更新SHM读标记，不将SHM瞬态字节恒等当作持久数据语义；
三库DB/WAL业务快照仍要求同一真实静止点，实际回退副本在关闭业务句柄后保存全部存在的附属文件。

私有工作副本逐库打开，配置无扩展、defensive、foreign_keys、trusted_schema=OFF，使用MEMORY journal/temp和8MiB页缓存，
按已验证page_size将max_page_count固定在各库物理上限并回读；拒绝副本旁的WAL/SHM/journal、链接和多硬链接。
这些设置只用于独占私有副本，不能用于活库或输入原件。进程中止后工作副本不可发布，原件和失败副本保留。
实际Node SQLite构建含DEFAULT_MEMSTATUS=0，设置hard_heap_limit并回读成功仍未阻止超过该值的分配。
因此撤回未冻结的256MiB堆限制候选，不设置或宣称SQLite堆/RSS/OS内存硬限；设置记录明确heapEnforcement=not-guaranteed。
文件、JSON、操作时限和可强制终止约束仍独立生效；临时/语句journal额外磁盘量仍须在完整空间预算中核算。

主进程以独立单调期限监督完整操作；切换前预算耗尽时终止所拥有的校验进程，本次操作失败且零数据切换，不自动重启重试。
开始切换后的期限耗尽进入有界恢复或recovery-required，不能再宣称尚未发生替换；不得因监督超时开放混代业务。
确认进程实际退出后才可清理或复用本次 staging；终止/退出无法确认则保留现场并进入 `recovery-required`，禁止切换。
迟到结果和已失败 operation 的 IPC 不得重新授予成功。正常成功也必须同时证明进程退出、结果形状和成员摘要有效，
再进入 §4.4。若替换为其他执行方案，须先证明 native 阻塞时仍能及时终止、主 UI 保持响应及同等文件/IPC 边界。
实际Windows utilityProcess资格中，被kill的进程也可报告exitCode=0。因此退出码只是一项观测；
必须以未失败的operation世代、完整有效结果、成员摘要及实际退出共同授予成功，超时/取消不可因exit0复活。

### 4.4 可恢复切换

完整空间预算必须分别计每个卷的分配单元取整量。旧数据集O按实际DB/WAL/SHM/hot-journal和Conversation成员测量，
不能把新容器5GiB界限当作旧数据上限。恢复新增空间须容纳旧回退副本O、原始导入成员N、工作成员N及显式journal余量J；
已占用的输入容器和旧数据不再次计入新增量。备份新增量包含一致快照、工作副本、输出临时容器及J。
原始新成员N和工作成员W各最多4289MiB（DB1088MiB+Conversation3201MiB），工作增长按各成员上限计费。
同卷rename发布不另复制一套新数据时，恢复新增上限为O+N+W+M+J，备份为N+W+C+M+J，
分别即O+8578MiB+M+J和13698MiB+M+J。当前备份发布实现从私有容器复制到原生选择的目标目录，
再以同目录硬链接独占创建目标，因此另计P=C（最多5120MiB）；同卷新增总量为18818MiB+M+J，
跨卷则分别在userData卷计N+W+C、目标卷计P。即使目标同卷，也不能省去该发布副本。
不支持硬链接的目标文件系统安全失败，不以可覆盖目标的rename降级。
M列举私有文件及其同时存续的final/tmp：owner、journal、result各4KiB，固定诊断64KiB，
以及单一活动operation指针active各4KiB；恢复接替另计replacement及其tmp各4KiB、固定recovery-gate预留4KiB，
合计最多172KiB，
再逐文件按各卷分配单元取整。容器manifest已包含在C。文件系统元数据与其他进程写入不能由预检预约，实际IO失败仍须安全恢复。
固定Electron SQLite3.53.4/sourceId及安全配置下，MEMORY rollback/statement journal与temp_store的磁盘J为0；
依据该版本openSubJournal的nStmtSpill=-1实现和固定语句集合，不由目录末尾采样推断。
受控staging路径不使用ATTACH/VACUUM或切换journal模式，主库中间表/索引增长计入W并受max_page_count约束。
这不适用于旧活库WAL或正常Store启动写入；旧附属文件计O，恢复启动若需写入，须另核J_boot或将规范化提前至W。
这些完整预算已支持进入实现；产品成功发布仍须完成实际全路径资格，不把容量估算当作验收结果。

用户原生确认恢复的覆盖范围后，先登记已验证新成员及恢复意图；正常关闭旧数据句柄并重启后，
在发布任何新成员之前创建当前完整数据集的回退副本，并持久保存旧成员身份及摘要。
清单只含已知逻辑成员、operation/generation、阶段和校验摘要；路径由固定根推导，不能随容器提供。
采用逐文件替换与持久阶段记录：每一步先保存可恢复前态，文件写入/必要 flush 完成后再提交下一阶段。
不宣称多个 rename 是原子事务；不能让业务服务看到一半新库一半旧库。

启动先检查清单及实际文件/摘要：可证明完整的新数据集才继续验证并提交；否则按清单恢复完整旧数据集。
任一成员或记录无法证明一致时进入 `recovery-required`，保留新旧副本和失败原件，阻止关联业务写入并告知用户可执行动作。
绝不通过重建空库“恢复成功”。清单写入、各成员替换、迁移、验证、最终提交的每个崩溃点都必须有重启反例。

恢复入口只在主进程已证明无旧数据进程、无业务 Store 或原始在途工作时提供“选择备份恢复”。
该入口禁止备份和恢复原业务；选择路径及确认仍由原生对话框产生。每次显式选择产生独立操作与预算，
前次操作、维护排水及子进程实际退出/账本退休全部完成后才允许下一次选择，失败记录和 scope 保留。
新工作副本验证后，依序建立 replacement 凭据、归档固定旧 active/临时指针、登记新 active 和 handoff，
不从旧坏指针解析路径或赋予权限。DTO 的 availableActions 是主进程闭合能力投影，不能作为 renderer 批准凭据。

DatasetStartup 必须接收主进程的无写者证明：开 Store 前的证明与只读健康图证明分别校验，
异步边界后重查。健康句柄只有实际 close 成功才解除所有权。恢复 gate 存在而 active 或 replacement
不完整时保持恢复态；恢复了旧数据也不能自动越过 gate 开放业务。只有完整 committed 证据、gate
退役和 active 清理全部完成，才可开放写入。gate 已归档而 active 尚未清理的重启，也须复验完整
committed 与归档凭据，不能把“没有 gate 文件”单独作为准入许可。
最终成功后按正式保留策略处理本任务临时文件；失败原件和用户已有备份不作为临时垃圾清理。

恢复接线在单实例锁内先登记唯一active指针和已验证work的handoff，不读取或复制仍打开的旧活库。
持久handoff预先扣除同一账本中剩余containerIo登记额度及drain关闭额度；元数据登记与关闭分别受
该次单调截止监督，未用完的预扣额度不返还。发布/回退/健康额度保持原余量，不能用重启补回时间。
登记失败保留active/清单及原代，不能自动清指针重试；requestRelaunch只登记下一轮关闭意图，避免等待自身操作形成环。
正常排水、关闭句柄并受控重启后，在任何Store写入前普查旧13个固定成员（含三库各自三种附属文件），
逐文件按分配单元测量回退复制所需空间，准入后创建独立R；原有各库backups及凭据/Session不随换库移动。
逐成员退役旧件与发布新件都有持久意图，Conversation目录作为一个固定成员处理。临时active指针、未知清单、
世代/身份不符不能解释为没有待恢复工作；失败原件不自动清场。新的启动尝试及恢复额度持久扣除，不循环重启。

启动或部分服务装配失败仍提供仅恢复入口。部分服务图先排空真实存在的producer、usage、任务Tab、utility及句柄，
通过正常shutdown后受控relaunch进入零writer恢复界面；下一进程由用户再次原生选择备份，不持久化或重放旧选择，
不新增环境变量权威。零writer能力须由主进程生命周期与真实资源所有权证明，不能以当前进程Map为空推断历史child退出。
部分图的首次“恢复”动作只显示原生重启确认，说明当前Tab将关闭、下次启动再选择备份；取消时零gate写入和零重启。
确认后在同一TransferBudget内持久建立gate，最终复核当前文档、同一部分图及生命周期，再提交主进程重启意图。
该提交点之后文档导航不撤销已确认的意图，仍受原截止与20s关闭额度约束。控制入口不持有业务根租约，
实际shutdown排在当前原操作结束之后；gate一旦开始写入而失败或状态未知，本进程禁止重试并保留现场。
下一冷启动由gate直接进入无Store恢复界面，不自动循环重启。原生确认前及失败后的独立浏览器仍可使用，数据业务保持关闭。

普通启动和恢复健康启动都须在完整服务图核验后才开放总数据准入。Watch/Digest调度器使用独立的启动暂停，
其间只维护到期索引，不注册timer或消费到期项；不占用维护世代。普通Digest旧cycle恢复在完整图已装配且UI数据门仍关时执行，
全部成功后同步开放总门并解除启动暂停；恢复数据健康启动继续禁止重放旧cycle。真实排水失败必须锁存，
普通装配异常不冒充已经发生的排水失败，随后统一关闭仍须等待所有原Promise及真实句柄关闭。

新的恢复意图可有界接替无法解析的active记录：先持久创建固定`data-transfer/recovery-gate`。
gate仅以存在阻止普通Store启动，内容不授任何路径、operation或业务权限。新scope增加固定evidence目录，
owner新版version2绑定8个目录身份；已有version1的7身份scope保持可读，不静默迁移或覆盖其owner。
新恢复work通过全部校验、原生确认且零writer后，持久写入≤4KiB闭合`replacement.json`，绑定新scope、gate及
旧active.json/active.json.tmp各自presence、文件身份、大小和原始字节摘要。未知旧记录不解析为操作，不将其中路径当权威。
按固定路径将两旧文件逐件rename至新scope/evidence，保留原件和此前全部scope，再登记新的active。
旧记录可以超过4KiB；其opaque流式摘要受既有期限和固定chunk约束，不能将新元数据上限冒作旧文件上限。
旧文件只同卷rename，不新增一份内容复制；已有占用及目录分配单元仍按实测空间核算。

gate存在期间，只有新active、scope owner、replacement、gate身份及完整归档相互匹配才可继续该次恢复；
任何空窗、重复位置、身份变化或未知记录均留在恢复界面。完整新服务健康提交后，才可把gate原件rename入该scope/evidence，
随后清除同代active并开放业务。恢复失败即使切换器返回old-restored，也只是恢复救援前现场；该现场可能原本已坏或混代，
必须保留gate并禁止开放业务。再次显式选择备份使用全新scope，保留前次记录与现场，不自动重试、不续租旧操作预算。
gate、replacement写入、两次归档、新active发布与gate退役每个边界均须有崩溃重开反例；纯协议通过不替代真实零writer资格。

新数据健康期复用原main服务依赖图及Repository/Service构造器，使用专用verified-transfer句柄能力。
三Store此分支跳过迁移、保留清理、interrupted规范化和Source reconciliation写入；这些必要语义已在work完成并复验。
句柄保持DELETE journal，SQLite query_only与包装层同时拒绝写入，prepare延迟到受控调用后以阻止PRAGMA编译时副作用。
全部服务闭包装配完成、调度/通知/业务仍关闭时，切换器再次核对完整数据摘要，才可提交并解除句柄写保护、开放总准入。
该恢复进程继续使用DELETE journal，下次正常冷启动沿原WAL路径；受影响性能必须实际验证，不能假定与WAL等价。
健康期不转换WAL、不建SHM，不把普通Store的启动写入遗漏为J_boot=0。任一健康失败先关闭该代全部句柄，
再按剩余恢复额度回退或保留recovery-required；不能仅用数据库只读探针冒充完整服务健康。

Conversation排水须取消尚未注入的快照等待。PageReader在页面尚无URL或主框架加载中使用自有等待，
监听页面就绪、销毁、崩溃及主进程AbortSignal；只在当前就绪且未撤销时调用固定隔离脚本，Promise交接后重查。
ask/Agent初始采集沿原请求signal，预览持有独立controller，在全域封闭准入之后的真实drain中取消。
每个预览controller仅在原操作finally中解除所有权。已发出的原生脚本调用仍等待原Promise实际结算，
不能以abort、导航、destroy或超时race声称原调用已结束。共享空白物化仍由Tab持有，取消一个快照读者只撤销该读者，
不停止、关闭或改导航用户Tab，也不把共享load记为已完成。维护20s失败仍保留原工作和数据句柄，不伪造排水成功。

restore/migrate在work内规范化未完成动作：Research running和Watch非终态采集标记interrupted，
claimed Digest Provider保持uncertain、不重发，Session授权全部失效。含非终态Digest cycle的active
schedule通过既有CAS事务暂停，保留cycle、run、cursor、slot及claim事实，等待用户明确恢复该schedule；
启动健康完成不调用resumeActiveCycles来推进这些历史动作。pending通知在同一事务中变为failed，
保留attempts=0（从未尝试发送）、去重键及历史，uncertain通知不变；不得捏造一次发送尝试。
scanner只允许failed的attempts为0，sent/uncertain仍至少1，pending仍为0。

### 4.5 Windows 数据进程生命周期保护

Windows x64 使用随包提供的固定 lifecycle guardian，源码位于`native/lifecycle-guardian/`，
由机器已有 .NET Framework C# 编译器构建；生产只启动已通过包完整性清单及哈希验证的固定 EXE，
不运行 PowerShell、编译器或任意脚本，不向renderer提供PID、路径或进程接口。
guardian通过detached且隐藏窗口的固定spawn启动，避免libuv默认父退出Job连带终止guardian；
管道与精确父进程句柄仍被持续监督。guardian自身在数据Job之外，先把main加入Job，之后的数据utility自动继承。
Job仅启用KILL_ON_JOB_CLOSE，不允许两种breakaway；ready前回读限制、main实际成员及guardian非成员。
嵌套Job不能成立时关门，不静默绕过。helper异常退出可能终止整个受管应用树，保留持久恢复现场。

Job名称可在旧process句柄尚未signal前重新创建，因此fresh Job只表示名称可用，不证明旧writer已经退出。
E2要求实际退出的集合为所有获准访问三库或已保存Conversation的main及probe/transfer utility；
Chromium和conhost等不具这些数据能力的后代不冒充已逐个验证退出。main在打开Store前、每个utility在发送init前，
必须先由guardian持久登记PID、创建时间、固定映像辅助身份及角色，再返回同nonce/session/序号的ACK。
最多同时保留1个main和1个utility；旧utility的精确句柄signal且退休记录持久成功ACK后才可授权下一个。
Electron的utility exit事件只触发退休请求，不证明Windows进程已经实际退出。guardian在退休命令原有10s
单调余量内等待同一个持有句柄signal，核验期限并持久退休后才ACK；未知等待结果、父main退出或期限耗尽
仍fail-stop。此等待不重置上层操作deadline或1500s账本，TS到达时及交接时继续执行更紧的期限检查。
未登记或未ACK的utility不得进行live/raw/work文件或数据库IO，且有短的无IO自退出期限；不能把该期限当actual exit证据。
main不得提前排队发送init，失败或迟到ACK不得重新打开总准入。

固定userData根下`lifecycle-guardian/`包含独占`owner.lock`、闭合`writers.json`及其tmp。
三个槽是应用生成的闭合内部元数据，采用同一受保护父目录的OS默认创建策略；
不承载用户自定义ADS、EFS共享接收者或审计设置。产品核对owner/group/DACL及控制位、
Encrypted/Compressed、普通单链接文件身份和无额外数据流；不声称保留未查询的SACL、企业资源属性或EFS接收者。
在本owner内缓存已验证安全事实；旧账本读入建立其基线，只有原协议允许的全新根才可采用首次创建基线。
新tmp在首字节之前必须满足基线，不能写出内容后才因继承权限变宽或失去加密属性拒绝。
ADS检查覆盖三个槽，额外空流也拒绝；枚举失败、截断或超预算不能解释为无额外流。
发布以原RW+DELETE源句柄持续持有，祖先目录禁止共享删除；仅向固定规范实体目标使用
SetFileInformationByHandle的FileRenameInfo、NULL RootDirectory及完整路径，首写禁止覆盖、后续写须先验旧receipt。
保持预/后Flush及完整读回，发布前和最后IO后重验支持的安全事实、身份、字节、ADS及目录；
全部临时资源释放后仍检查原期限，随后才能ACK。失败不换API、不delete+copy、不自动回滚。
写前拒绝保留空tmp及旧final；写后发布前失败保留已写tmp；rename后失败保留实际现场、零ACK并原fail-stop，
不能承诺此时旧final仍在。API没有目标FileID比较交换，不能声称完全隔离同账户恶意竞争；已可检测漂移仍必须拒绝。
每槽最多4KiB，常驻元数据另计12KiB及一个目录，各文件按分配单元取整；不挤占operation的172KiB记录预算。
同卷空间准入统一合并两部分：operation为11个4KiB槽、2个64KiB槽及10个目录，guardian另为3个4KiB槽及1个目录。
槽大小逐文件按该卷分配单元取整，目录分别计费；旧代回退按实际文件与目录计费，并另计可能新建的三个域目录，不能用固定旧容量或任意簇数替代。
账本跨重启绑定规范化userData根路径及该根的文件身份；guardian子目录身份只在当前owner生命周期内复核，不声称已持久绑定。
版本、角色、PID唯一性、创建时间和摘要均闭合；拒链接、硬链接、半写、未知字段及重复键。
新guardian先取独占锁、校验旧账本，再逐个打开旧PID并核创建时间；同实例必须等待精确进程句柄signal。
仅明确不存在或PID已对应不同创建时间可判旧实例消失；AccessDenied等未知错误关门，不向旧PID发送kill。
旧记录通过后才Assign新main、持久登记新main并ACK。只有经本协议从未授予IO的全新根可建立首个账本。
已有guardian目录却缺账本、存在tmp、未知格式或不可判身份时保留原件并拒绝准入，不能悄悄删除后当首装。
此元数据损坏的救援仍须先取得旧数据writer已消失的可靠证明，或采用不复用旧实体根的隔离救援；普通恢复确认不能替代证明。

单次应用准入及跨代旧writer检查共用10s单调期限；guardian退出确认另受10s约束。
两者不延长数据操作原1500s账本；utility登记与退休仍由上层原操作deadline约束。
管道采用固定ASCII闭合帧，单帧≤4KiB、单会话≤65536帧且累计≤16MiB；无任意命令、代码或PID枚举终止接口。
正常重启只能先登记固定relaunch意图，由main完成正常shutdown；guardian确认main实际退出及Job ActiveProcesses=0，
持久退休账本并关闭旧Job/锁之后，从Job外启动固定当前EXE和编译期开发app入口。不得使用会继承旧Job的app.relaunch。
main完成全部原始工作排水、数据库关闭和清理后，必须收到固定finishShutdown确认才正常退出。
finish要求utility已退休、永久禁止新授权，并从此刻启动独立10s退出确认期限；正常EOF可在该期限内等待
精确main进程signal，避免Electron先关闭stdin时提前强杀覆盖正常退出码。未finish的EOF、坏帧和逾期仍按
失败终止Job；finish不代替实际退出、账本退休或Job归零。relaunch意图须在finish之前登记。
纯Win32资格不代替实际Electron早期子进程、嵌套Job、完整关闭、外部relaunch及发行目录资格；失败原件及历史unknown保留。

## 5. E3：崩溃与异常恢复

| 失败范围                        | 用户可见行为                                                       | 数据/副作用约束                                                                 |
| ------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 单个网页 render-process-gone    | 该 Tab 显示崩溃及重载入口，其余 Tab/应用继续可用                   | 文档世代失效；旧 elementId/授权不复用；只重载该用户 Tab                         |
| 主 UI renderer 崩溃             | 主进程保留已提交状态，受控重建 UI；短期连续崩溃进入错误页/重试选择 | 旧 sender、订阅、确认与临时句柄作废；不因重建重复开始业务动作                   |
| Agent/Provider 中断             | 当前生成标记中断/失败，用户明确重试                                | L2 pending 失效；不自动重放 click/fill/写操作，不拼接未知请求结果               |
| Research 中断                   | running 按既有契约记 interrupted，保留已验证结果                   | 不自动续跑；capture 正文不为恢复落盘；只清理本任务 Tab                          |
| Watch 调度/采集中断             | 保留已有事实，失败可解释，调度按冻结规则恢复                       | 消费的 slot 不重放，Event 幂等；已 claimed Digest Provider 标 uncertain、不重发 |
| DB locked/corrupt/future schema | 明确受影响子系统和可用恢复动作                                     | 不覆写原库、不无限重试、不启动关联写者；浏览器独立可用                          |
| 主进程异常退出                  | 下次启动先恢复数据一致性再开业务                                   | 不假定异常 handler 记录日志后即可安全继续；未提交状态不伪称保存                 |

“用户不因一页崩溃丢失整个状态”至少证明其他 Tab、保存会话与持久业务数据不受影响；
不新增跨重启恢复全部网页 DOM/表单内容的承诺。既有 Cookie Session 保持兼容，但不纳入数据备份。
主 UI 沿同一窗口仅重新加载可信入口，自动恢复为同一 60 秒窗口最多两次，不重装配业务图；失败或超限后
提供固定原生选择和最多一次明确手动重试，再失败只允许退出。旧 guard/订阅/确认失效，在途 UI 请求中断。
main 未捕获异常/未处理拒绝只启动一次关闭准入和排水；共用 10 秒总截止后 exit1，由 guardian 接续写者退出与现场保全。
无法证明健康时安全停止循环，不把未完成排水称为正常退出。
固定原生错误提示通过AbortSignal及内部race最多9秒；排水与提示并行，二者完成后才发送guardian finish并exit1。
这使guardian grace只覆盖原生退出，避免耗在等待用户知晓上；原10秒总门、数据保全及异常退出码不变。
故障接管后普通退出链不得发送guardian finish，每个await后复验；已发finish时runtime必须closed，故障不再等待提示或旧ack，
直接exit1由guardian退休写者。共享finish所有权不重置旧grace，不二次发送，也不将异常退役称为正常退出。
dispose、drain、窗口重建、服务重装配必须幂等；退出排水不得由强杀冒充正常退出。

## 6. E4：性能与诊断

### 6.1 基线及回归判定

测量对象覆盖冷启动、创建 Tab、多 Tab 内存、PageSnapshot、AI 首 token、Research、大型 Sources 搜索和 Watch 调度。
每项先冻结 profile/包、机器/电源条件、合成数据集、时间起止、采样次数、统计量、观察器开销、预算和停止条件，
再执行 baseline。计时采用单调时钟；AI/Research 区分本地开销和真实 Provider/网络耗时，Fake 不能证明外部首 token。

在候选结果产生前登记可接受的相对回归阈值及绝对保护值；先做对照可行性验证，测量本身不稳定时修复 oracle。
没有历史数字的项目先取得 baseline 再冻结回归契约，不以测量后调整阈值消除失败。
Watch 沿用 Stage6 已通过的正式固定负载、分组增长 oracle 和全部硬阈值；工具变化需证明等价并独审。
电池为用户裁决后的 NOT RUN，功耗/续航未验证，不重新列强制门，也不把接电数据当电池结论。
只有新证据指向产品瓶颈才优化；性能变更不得减弱隔离、预算或数据语义。
长时多 Tab 的最低负载/时长和完整错误体验矩阵按 `tasks.md` 的 E3/E4 对应项执行，不以 Watch 旧长测替代该门。
多Tab增长按该负载实际稳定进程数组分别判定，不沿用Watch的10/11数组；不得以跨组增长相消授PASS。
新可行性场先确认主体/过渡组，全部采样保留；稀疏段最多两个连续10秒点/≤20秒，前后返回同一已评估稳定拓扑，
且全部点满足原资源绝对门；缺双侧锚点、持续换组或超界失败，不伪称瞬态独立OLS已证明。稳定组仍各自原增长门。
应用与Job单调时钟显式绑定启动offset和实际工作窗口；持久化预期在启动前固定，退出后仅在副本核完整四域一致性。

### 6.2 可观测性与诊断导出

日志增加进程内 sessionId、component、operation、duration、errorCategory 和白名单 sanitized context；
保留现有行长、文件大小/数量/年龄限制。自由文本、原始 Error、URL query、绝对用户路径不能直接作为结构化 context。
错误向用户说明故障、受影响数据和可执行动作；堆栈只在受控脱敏日志中，不能冒充恢复建议。

诊断包由主进程从固定字段重新生成：应用/运行时版本、构建 ID、功能状态、错误分类和有界计数/耗时。
错误数只表示本次进程自 logger 初始化后的日志入口错误事件分类计数，初始零不表示历史业务从未失败；
功能状态表示当前入口/服务图可用性，未采集业务总数和耗时为 null，构建 ID 为编译时 Git SHA，dirty 资格另由发行来源记录判定。
可选日志仅接受规定时间窗和已定义字段投影；不复制原始日志、DB、备份、Cookie、配置、环境变量、prompt 或内存转储。
先生成不可变候选、显示完整导出字段和实际预览，再由用户原生保存；保存必须对应预览的同一摘要/版本。
取消/失败不外发，产品不自动上传。预览不替代字段白名单和隐私反例。

## 7. E5：安装、手工升级与卸载

用户 2026-10-10 明确批准全机 MSI 安装、升级、卸载使用管理员 UAC，日常运行仍无需管理员。
旧 per-user MSI 的实际回滚留下损坏注册、正常卸载失败，保留 M6/P1 原件，不继续尝试该权限模式。
NSIS 只提供中文界面并调用 MSI；固定受保护 ProgramFiles/AIbrowse 安装根，禁止用户可改写任意目标及安装后自动运行。
固定 appId/identity 与各用户实际 userData 映射；业务库、凭据和 DPAPI 不属于全机安装组件。
全机 locator/组件/缓存包必须按 machine context 核验；自写 guard 仅只读准入，管理员文件写入和回滚由 Windows Installer 执行。
全机组件以真实文件为keypath，与原生实际文件路径逐项比较；Advertise=yes与固定DISABLEADVTSHORTCUTS=1生成普通快捷方式，遵守ICE归属校验。
先按任务合同运行独占中文/空格 ProgramFiles 小样，完整注册/文件/快捷方式回滚缺一不可，再接实际发行包。
现有builder附带NSIS3.04缺后续临时目录安全修复，全机界面改用固定官方NSIS3.13便携工具及摘要；不修改node_modules或应用依赖。
管理员暂存与执行目录必须独占、限制DACL且非重解析点，MSI只能来自已绑定的嵌入内容，不接受任意外部命令或文件路径。
/a管理映像在AdminExecuteSequence写入前固定拒绝，准入helper为无控制台winexe并以退出码返回，避免交互选择阻塞安装。
准入在事务前对全部旧注册文件（含旧版独有文件）核写入/删除占用，仅取得并释放兼容句柄、零写，拒绝让Installer等占用。
只读准入总预算10秒；不把已取得检查句柄保留到组件事务，不管理未知文件归属。
安装和卸载准入置于CostFinalize之后、InstallValidate之前，确保先于平台文件占用检查及时拒绝；
MajorUpgrade仍在InstallInitialize之后，组件提交和回滚边界不变。
发行入口仅builder dir与受控MSI/NSIS3.13构建；完整安装构建输入和EXE/MSI摘要纳入来源记录，旧NSIS目标不得继续发行。
installer/uninstaller 只能管理该安装拥有的产品文件；不递归删除 userData、任意外部目录或链接目标。
采用任务合同的 NSIS 界面与 Windows Installer 文件组件/回滚事务；自写部分仅只读准入。
自写两槽事务的独立失败保留为 REPAIR，禁止接入发行包；未通过实际负例不授安全安装通过。
卸载明确提示本地数据保留；重新安装能识别原数据。安装包不嵌入真实 profile、日志、凭据、旧证据、测试文件或开发工具。

升级先确认运行实例已退出并释放数据，不让安装器强制覆盖仍在运行的组件。
新版第一次启动走 E2 迁移及回退副本；安装失败保留旧安装/数据可用路径。
旧版打开更高 schema 必须安全拒绝，不能为“回滚”降级解析或覆盖新库；回退由兼容旧安装与完整升级前数据集共同完成。
人工操作说明明确“程序版本回退”与“数据恢复”的配对要求，不承诺任意版本自动降级。

实际 Windows 安装产物验证名称、图标、版本、安装目录、userData、日志目录、升级和卸载。
发行启动固定`com.aibrowse.desktop`，仅Windows发行初始化实际调用setAppUserModelId且正常返回后保存配置成功状态；
调用失败则Windows通知不可用，应用内提醒继续可用。Windows通知资格同时要求Windows、packaged、配置成功及Notification.isSupported；
不再保留Stage6的固定false占位，也不伪造Electron未提供的OS身份getter/probe。配置成功只证明调用完成，实际通知显示仍须独立原生证据。
投递期间持有native Notification至click/failed/用户关闭/applicationHidden或应用清理；横幅timedOut保留活态通知中心点击能力，不用任意TTL缩短。
内部同时持有最多200份（既有10×20通知drain批上界）；超过时新native投递受控失败，应用内提醒仍可用，不删除持久化事件或把未投递标为已显示。
重复/晚到回调只消费一次终态，清理后不得路由；不能让V8 GC提前移除点击回调，也不能无界积累引用。
native show回调只记录系统投递回执，不能当作用户看见的证据；同步show()返回不提前记录已显示。
实际安装版仍须通过正式Watch事件证明默认正文隐私、OS卡片显示及进程存活时的精确事件点击路由；不直接调用通知API作产品验收。
原生主动点击使用闭合activation推送，仅携带内部event/digest类型和UUID；普通被动提醒仍沿现有notification展示，不自动切换用户视图。
主进程在当前可信窗口、同一数据实体和生命周期准入均成立后恢复/显示/聚焦主窗；renderer直接进入对应工作区与精确详情。
所选event详情由当前Repository按已校验UUID独立查询，不以当前列表过滤或前50项代替目标查找；缺失目标不回退为其它事件。
连续目标切换、组件卸载和晚到digest查询不能覆盖新目标；该接线不新增数据库写入、通用IPC或跨重启通知激活能力。
用户 2026-10-10 明确批准以当前机器/账户的受控 NSIS 首装、手动升级、卸载、重装及实际包依赖/权限/内容检查
替代独立环境最终门，记录环境与产物 hash，仍须实际安装 EXE 运行而非开发 preview。
独立干净 Windows 本身保持 NOT RUN；其它 Windows 配置与机器范围开发依赖的影响未实测，用户已接受该剩余兼容风险。
全部替代门和其余阶段门满足后可以关闭内部候选范围的 Stage7，不将同机测试改称独立环境 PASS。

## 8. E6：发布管线、证据与最终门

管线顺序：候选 Git → 锁定依赖/干净构建 → 适用全量门 → release package → 包清单/隐私/fuse/篡改检查 →
批准的同机 NSIS 安装及升级回归 → Release notes/已知限制 → 新独立阶段审计。
CI 与本地同一构建命令；CI 默认无真实 Key、无真实用户数据、无公开发布写权限，不以 secret 运行不可信 PR 代码。
产物记录版本、commit、工具链、构建参数、包内容清单与 SHA-256；检查可重复构建差异的确定性来源。
“可复现”需能从清单重建等价内容并解释时间戳/未来签名差异，不能只保留一个可下载文件。
guardian 使用现有 PowerShell Roslyn 的固定摘要 deterministic 编译；输出仍针对现有 Framework 4/x64，
编译器与固定引用输入进入来源记录，实际双构建须保持 helper 字节相同；不以忽略 helper 差异实现 payload 等价。

内部未签名候选的来源由受控构建和交付流程保证；同处下载的 hash 不能单独证明发布者身份。
公开发布前需实际发布授权和签名/渠道方案；证书私钥只经受控 CI secret 或本机安全存储注入，不进命令行/Git/日志。
不在此阶段默默接入 auto-updater、更新 URL 或远程执行入口。

E6 逐项审查 `Seventh_stage.md` 最终验收，并对威胁模型红队矩阵记录结构证明、真实受控观察、外部观察与诚实限制。
第一至六阶段主路径回归、迁移旧版矩阵、崩溃反例、性能基线、批准的同机安装替代和安全包检查缺一不可。
关键安全/持久化/并发变化独立审核；阶段最后使用新独立 Stage Auditor。风险未裁决或硬门缺证据不能以条件性 PASS 关闭。

## 9. 任务依赖与停止条件

| 任务 | 主要结果                                        | 依赖/审核                                                   |
| ---- | ----------------------------------------------- | ----------------------------------------------------------- |
| E1   | release 资格、UI/IPC/Session 边界、Key 目标绑定 | 设计 PASS 后且获得实施启动授权；新独立安全审核              |
| E2   | 容量契约、三库迁移、备份/恢复维护态             | E1 的能力边界；新独立持久化/隐私审核                        |
| E3   | 崩溃与中断恢复、幂等释放                        | E1/E2 的启动/维护状态；并发和生命周期独立审核               |
| E4   | 基线、可观测性、诊断预览导出                    | 可先做独立设计/合成测量；集成依赖 E1–E3，隐私受影响部分独审 |
| E5   | 最终 NSIS/MSI 包、安装/升级/卸载证据            | E1–E4 稳定候选；批准的同机替代与 UAC 模式                   |
| E6   | 可复现管线、红队闭环与最终审计                  | E1–E5 完成；新独立 Stage Auditor                            |

资格失败、同路线连续两轮无新证据、无法证明跨库一致性、容量损害合法旧数据、发现凭据越界或需改变产品承诺时停止该路线。
工程限制先 REPLAN；产品取舍、未解决用户风险和必需外部条件集中请求裁决。其他独立且已授权工作可继续。
用户已授权持续完成 E1–E6 实现、验证、独立审核及收尾；依赖与硬门满足后方可授予各任务通过。
Stage7完成后停止，不启动Stage8产品实现；未签名内部候选和手动升级边界不变。

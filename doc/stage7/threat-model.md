# AIbrowse 第七阶段威胁模型

> 本文件是第七阶段安全设计；审核状态、E1–E6 的实际证据与完成状态只记录在任务文档和 `doc/tasks/progress.md`。
>
> 设计 baseline：`6bc4f00ab065d2c751d89ab120106aa4accce805`。
>
> 需求：`Seventh_stage.md`；产品/接口契约：`detailed-design.md`。第一至六阶段安全契约继续生效。

## 1. 保护对象与新增攻击面

保护已有 Key、共享登录 Session、已提交业务数据、受限浏览器能力，以及用户对备份/恢复/安装行为的知情控制。
新增攻击面集中于 release 启动环境、打包与依赖、Provider 目标配置、用户备份导入、崩溃恢复、诊断导出和安装升级。
原 Watch 的 Public DNS/robots/TLS/跳转门、Session task-owned Tab、事实确定性、保留策略及零原始正文落盘继续保持。

本轮实现目标是未签名内部候选、per-user NSIS 和手工升级。没有自动更新网络面，不公开发布；
签名/公开渠道需要后续实际条件。设计中的防护必须由 E1–E6 证据证明，不能把待实现条款算成已有保护。

## 2. 信任边界与诚实假设

| 主体/输入                     | 攻击者能力                                          | 必须保住的边界                                                                                     | 已知受损范围                                                                                                                   |
| ----------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 远程网页/Source note/模型输出 | 任意文字、DOM、URL、重定向、恶意结构和指令          | 无应用 preload/IPC、无本地文件/Key、无主进程通用 shell/SQL/HTTP 工具；确定性工具门                 | 模型语言可能误导；网页自身 HTTP(S) 流量与已登录站点行为不等于 Public Watch 网络                                                |
| 被攻破的主 UI renderer        | 可调用该 UI 合法 bridge、控制 UI 文本与普通确认按钮 | 不能越过主进程 schema/配额获得通用能力；不能将已有 Key 静默送往新目标；不能无原生操作导出/恢复数据 | 可读展示给 UI 的信息、调用原本允许的业务修改、批准 renderer 内普通 L2/Session 授权、消耗已允许任务预算；不承诺这些仍由真人操作 |
| 导入备份/旧磁盘文件           | 任意字节、长度、SQLite schema、路径字段及历史状态   | 不执行文件中程序/SQL；不逃出固定文件集合；验证及确认前不覆盖原数据，切换前留回退副本；有界处理     | 用户主动恢复会用已校验历史数据替换当前数据，必须提示覆盖范围                                                                   |
| 更新/安装包来源               | 提供被替换的 EXE/ASAR/依赖或错误版本                | 构建产物可追溯、包内容验证、手工来源指引；程序与数据版本匹配                                       | 未签名包没有操作系统签名证明；hash 不能独立建立发布者身份                                                                      |
| 同账户恶意本机进程/管理员     | 读取或篡改本账户文件、注入进程/替换 EXE             | 应用避免危险链接/路径写穿，保留可审计失败；不把本机控制当网页能力                                  | 本地明文业务库可读；同账户 DPAPI、OS/主进程被攻破不在 sandbox 保证内                                                           |

主 UI 主帧 sender 是通道身份，不是真人授权证明。主进程也不是对同账户本机恶意软件的独立安全域。
原生确认用于防 renderer 通过 IPC 自批高敏动作；它不能抵御已控制 OS 的攻击者，也不能防止用户受骗点击。
用户在已被攻破的设置 UI 中新输入的 Key 也可能被该 UI 读取；已有 Key 的主进程存储/目标绑定不提供受攻输入面的保护。
原有普通确认仍保护网页/模型输入边界；renderer compromise 场景应如实报告其不足，不能把这一限制藏在“默认可信 UI”中。

## 3. 具体威胁与防护责任

| 编号   | 攻击路径/失败                                                           | 防护与关闭条件                                                                          | 任务     |
| ------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------- |
| S7T-01 | 安装版响应开发 URL/测试 env，给远程页面 preload，或把数据根换成任意路径 | 编译期 release profile、固定路径和入口；实际安装 EXE 的敌手环境反例                     | E1       |
| S7T-02 | UI/file 协议访问任意本地文件；自定义协议路径穿越                        | 固定资产映射、严格 URL/资源校验、关闭 file 额外权限；合成外部文件不可读                 | E1       |
| S7T-03 | 子帧/旧窗口伪造 IPC，恶意 payload 获取通用能力                          | sender/主帧/受信文档/世代与闭合 schema；旧句柄作废；反例调用无副作用                    | E1/E3    |
| S7T-04 | UI Session 权限漏管，网页下载 EXE 或弹窗/协议调用系统工具               | 所有 Session 双权限策略；专用 UI 复制例外；下载取消、无自动执行、window.open/协议白名单 | E1       |
| S7T-05 | 受控 UI 改 Provider baseUrl，将已有 Key 发给攻击者                      | Key 与规范化目标绑定；主进程原生确认、版本复验、在途不可变快照、跨目标 redirect 拒绝    | E1       |
| S7T-06 | 网页/Source/模型注入诱导上传文件、Key 或扩大工具权限                    | 常量 prompt、UNTRUSTED 块、固定工具、确定性 L0–L3；无本地文件/Key 工具                  | E1/E6    |
| S7T-07 | 备份复制 credentials、Cookie、原始采集正文或误称无私密内容              | 固定成员/投影，排除 secret/session/raw/log；原生保存前说明有界私密字段                  | E2       |
| S7T-08 | 假 manifest、截断/重复成员、超大 JSON/SQLite、恶意 trigger              | 读前及流式预算、固定成员、hash/长度/schema/语义复验；未知对象拒绝，编译期迁移           | E2       |
| S7T-09 | 路径穿越、UNC、ADS、链接或目标碰撞覆盖任意文件                          | 容器无可执行路径，主进程固定 staging/目标；不跟随异常链接、不覆盖不明文件               | E2/E5    |
| S7T-10 | 复制活库漏 WAL、Sources 与 Watch 快照不同步                             | 维护 admission+drain、跨库静止点、一致 SQLite 副本、关联校验                            | E2       |
| S7T-11 | 迁移/恢复半途中断，数据混代或“恢复”成空库                               | 三库升级前副本；持久清单、启动优先恢复、逐步故障注入；不可证明则 recovery-required      | E2/E3    |
| S7T-12 | 崩溃后重放 click/fill/Provider/Watch slot，旧 elementId 误操作          | interrupted/uncertain 与单一终态；新文档世代，旧授权作废；不自动重放外部动作            | E3       |
| S7T-13 | 锁冲突、不断崩溃/重启或重复清理拖垮主应用                               | 有界重试/恢复预算；子系统隔离；幂等 drain/dispose；二次实例不并发开写者                 | E2/E3    |
| S7T-14 | 原始 Error/日志/环境/路径进入诊断包；预览后换内容                       | 固定字段再投影、不可变候选与摘要、原生保存、无自动上传；秘密 canary 零命中              | E4       |
| S7T-15 | npm/打包包含开发文件、真实 profile 或资格 native 模块                   | 精确依赖、白名单包清单、独立 release 输出、实际 ASAR/EXE 内容扫描                       | E1/E5/E6 |
| S7T-16 | 替换 ASAR/加载裸 app 目录、Node/inspect 启动绕过                        | 真实 fuse 验证及篡改反例；只加载有效 ASAR；保留未签名本机篡改限制                       | E1/E5    |
| S7T-17 | 安装升级删数据、旧版覆写新 schema、卸载越界                             | per-user 固定 identity；保留 userData；迁移/回退配对；未知新 schema 安全拒绝            | E2/E5    |
| S7T-18 | CI 将 secret 给不可信 PR 或把未验候选自动发布                           | 默认无秘密/发布权限；候选版本/commit/hash 对齐；外部发布独立授权                        | E6       |

## 4. 关键安全契约

### 4.1 发布入口与本地资产

release 的模块图和打包允许集必须同时排除 smoke/qualification/test harness。仅在运行时写 `if (!isPackaged)`
仍不足以证明包内没有开发入口；资格包也不能被拿来替代正式 release 包验收。
本地资产协议不接受磁盘路径，主进程从构建清单定位资产；收到编码分隔符、重复解码、UNC/盘符/ADS/路径穿越、
host 变体和未登记资源即拒绝。CSP 保持本地脚本边界，实际验证 renderer 无法读 userData 或仓库外合成文件。

最终 EXE 验证 RunAsNode、NodeOptions、CLI inspect 禁用；ASAR integrity 与 OnlyLoadAppFromAsar 成对启用。
ASAR 完整性是内容检查，不能替代发布者签名，也不能保证同账户攻击者不能同时改 EXE 与其检查逻辑。
Windows 实际产物必须做篡改反例；不能从 `asar: true` 推断 integrity 已经生效。
该 EXE 的 `Integrity/ElectronAsar` header 资源必须对应最终 ASAR；只翻转 fuse 不构成证明。
CookieEncryption 保留现状，未来启用须证明单向数据升级与回退限制，不能在打包时默默改变已有 Session。
相关平台能力依据 [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) 与
[ASAR Integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)。

### 4.2 高敏确认与 Provider

已有凭据首次绑定/目标变更由主进程生成提案和原生确认；提示使用确定性字段，清理敌手控制字符。
确认绑定 operation、旧/新目标、配置版本、credential generation 和窗口生命周期；重入、取消、过期、版本变化
均不授权。UI 不能提供成功标志、替换确认内容或使用上次授权。请求只能使用与 Key 绑定的不可变端点。
所有含 Authorization 的 redirect 都须保持绑定，否则安全失败；不能寄望 fetch 默认行为证明该条件。
保留允许的 HTTP 配置兼容，原生确认明确传输类型；不宣称非 TLS 传输防窃听。

renderer 中的普通 Agent L2/Watch Session 按钮不能作为 renderer compromise 下的真人确认。
仍须证明受攻 UI 不能获取 Key、读取任意文件、执行 SQL/shell，不能从配置切换绕过上述目标绑定。
已经向 UI 暴露的内容与业务操作属于此攻击下的受损面，不用“没有 getKey”推导整个凭据链安全。

### 4.3 备份、恢复与迁移

备份含允许持久化的私密业务数据。原生对话框控制本地输出，界面告知包含范围和保管责任；
备份不是匿名诊断，不自动分享或上传。只复制已验证且一致的固定成员；不复制整个 userData 或历史备份目录。

导入包的 hash 是内部一致性检查，不是可信授权。先有界解析 manifest/成员，再在隔离只读副本、无扩展和安全配置下
校验固定版本的表/列/索引/trigger/view 定义、业务预算与引用，最后在 staging 做本程序迁移。
未知对象、定义漂移或未来 schema 拒绝；不使用导入 SQL、扩展、任意 ATTACH 或文件路径。
SQLite 引擎漏洞仍受所用 Node/Electron 版本影响，不能宣称 schema 校验能消除引擎漏洞。

恶意数据库可能令同步 `node:sqlite` 校验或迁移长时间停留在 native 调用；同线程 JS 超时不提供可强制停止的边界。
由主进程监督独立可终止进程处理固定 staging 成员；闭合请求不允许任意 SQL/路径/命令，不注入 Key 或 Session，
只通过有界 IPC 返回校验摘要/状态。主进程独立计时，超时终止该进程并判本次失败、零切换、无自动重启；
确认实际退出后才清理或复用 staging，无法确认则保留现场并进入恢复态。迟到结果不能把失败改成成功。
该文件隔离不构成 OS 沙箱；等价替换必须先证明 native 阻塞时的终止能力和主 UI 响应。

Sources/Research/Watch 按同一快照 ID 不可拆分地恢复，Conversation 属于同一批次；不增加单库选择/拼接恢复入口。
恢复前的主进程原生确认独立于 renderer，自行显示覆盖范围；确认后冻结操作并复验待恢复数据摘要。
先保留当前完整数据集；maintenance drain 成功前不替换；持久清单在启动装配前消费。
逐文件替换不具多文件原子性，只能通过可恢复协议确保业务不会访问混合世代。无法证明就进入恢复态，
原库/旧副本/失败原件保留，不能自动创建空库覆盖或删除不明文件。

### 4.4 诊断与隐私

日志脱敏属于纵深防御，不能靠正则保证任意 secret 形态均被识别。敏感输入应在进入 logger 之前排除。
诊断只接受白名单字段与预算，不包含完整 URL query、路径、用户名、机器唯一标识、Provider 目标/模型私有配置、
网页/Source note/Evidence 自由文本、prompt、表单值、Key、DPAPI、Cookie、DB 或内存转储。
有界指标可从主进程读取；不新增 renderer 通用日志文件读取 API。预览后的不可变候选才允许原生保存。
失败/取消的保存无上传、无外部自动通信，不在普通日志回显用户所选路径。

## 5. 红队与故障 oracle

每项保留初始失败、修复后结果、运行形态与实际产物 hash。未知原因记 unknown；没有执行记 NOT RUN。
离线/Mock 证明纯策略，实际 Electron 证明壳行为，真实受控网络证明请求去向，独立 Windows 证明安装与升级。
禁止只从日志“已拒绝”判成功；检查真实副作用、文件、请求、进程和持久化结果。

| 编号    | 最小反例                                                                                                                   | 必须观测的结果                                                                                                                                     | 责任     |
| ------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S7RT-01 | release EXE 带开发 URL、测试开关、数据根替换、Node/inspect 参数                                                            | UI 仍为包内入口；受控外部哨兵路径未触碰；无测试能力或调试端口                                                                                      | E1       |
| S7RT-02 | 被控主 UI/子帧请求外部合成 file、UNC/ADS/编码穿越资产                                                                      | 零外部文件内容/零网络代理；仅清单资产可读；错误不回显正文/路径                                                                                     | E1       |
| S7RT-03 | 远程 Tab、UI 子帧、旧窗口世代发 IPC；未知/超大/畸形字段                                                                    | 拒绝且零业务写/零通用能力；合法 UI 主路径仍通过                                                                                                    | E1/E3    |
| S7RT-04 | UI 与 Tab 分别请求权限；popup/302 非白名单 scheme；可执行附件下载                                                          | 未授权权限拒绝、无窗口/外部程序/下载文件；专用复制功能按合同工作                                                                                   | E1       |
| S7RT-05 | 受攻 UI 把已有假 Key 的 baseUrl 改到受控接收器后 ask；并发确认/删除Key/redirect                                            | 未经原生确认接收器零 Key/零请求；取消零提交；授权仅准确目标；旧请求不漂移                                                                          | E1       |
| S7RT-06 | 恶意网页和 user_note 要求上传本地文件/发送Key/添加工具，Research 来源与 Watch DOM 结构攻击                                 | 工具注册/权限不变；本地合成秘密零泄露；Evidence/事件按确定性 oracle 产生或拒绝                                                                     | E1/E6    |
| S7RT-07 | 含合成 note/Evidence/对话与 Key/Cookie/raw canary 的数据根执行备份                                                         | 允许的业务投影可还原；禁区 canary 在容器、manifest、DOM、日志为零；UI 正确提示私密内容                                                             | E2       |
| S7RT-08 | 容器篡改/重复/未知成员/尾随字节、未来 schema/恶意 trigger、超大/深 JSON；慢 SQLite 校验/迁移、期限耗尽、畸形/过量/迟到 IPC | 按已冻结预算拒绝；慢 native 调用仍可终止且主 UI 符合响应 oracle；确认实际退出后才清理，无自动重启；零切换，原数据摘要不变，零导入 SQL/外部路径访问 | E2       |
| S7RT-09 | staging/备份/目标中的符号链接、junction、碰撞和磁盘满；Conversation 恶意 ID                                                | 安全失败，不覆盖外部哨兵/有效原件；失败副本保留，错误受控                                                                                          | E2/E5    |
| S7RT-10 | 备份/恢复请求时 Agent/Research/Watch/Source 写者活跃，drain 超时                                                           | 不先复制/切换；成功备份跨库关联一致；取消/失败重新开放 admission 的条件明确                                                                        | E2       |
| S7RT-11 | 每一已支持真实旧 schema 升级；每个清单写/迁移/rename/验证点异常退出后重启                                                  | 完整旧或完整新数据集；否则安全恢复态；未来版本不被改写，不出现“空库恢复成功”                                                                       | E2/E3    |
| S7RT-12 | 网页崩溃、主 UI 崩溃、Agent pending、Research running、Watch claimed 时中断                                                | 其他Tab/持久数据保留；旧确认/elementId失效；不自动重放外部动作/Provider claim                                                                      | E3       |
| S7RT-13 | DB locked/corrupt、重复 second-instance、连续 renderer 崩溃与重复 dispose                                                  | 有界退让和恢复；一个数据写者；不无限循环/泄漏；退出真实 drain 可证明                                                                               | E2/E3    |
| S7RT-14 | Error/URL/路径/自由字段注入多形态秘密与控制字符；预览后改变源记录/取消保存                                                 | 诊断仅白名单投影；预览与导出同一摘要；秘密零命中、无自动上传                                                                                       | E4       |
| S7RT-15 | 从干净构建检查 ASAR/EXE 清单，注入假开发文件/资格 addon/secret                                                             | 真实包拒绝禁区文件；版本/commit/清单/hash 可关联；不以源码扫描代替包扫描                                                                           | E1/E5/E6 |
| S7RT-16 | 修改 ASAR 字节、移走 ASAR 加裸 app、以 debug env 启动安装 EXE                                                              | 错误产物拒绝运行/加载；原正确包可运行；未签名限制单列                                                                                              | E1/E5    |
| S7RT-17 | 独立 Windows 首装/升级/卸载/重装，失败升级和旧版打开新库                                                                   | per-user/identity/实际路径正确；userData保留；版本不兼容安全拒绝；无外部目录删除                                                                   | E5       |
| S7RT-18 | CI 不可信 PR、包版本不匹配、未签名候选试图公开发布                                                                         | 无 secret/发布写权限，候选标识和审批边界有效；发布产物对应审计候选                                                                                 | E6       |

红队只使用合成秘密、合成数据根和受控接收器；不读取真实凭据/真实用户库来证明防护。
真实 Provider 若需兼容证据按既有长期授权和受控 harness 执行，报告仅次数/目的/分类，不能把 Key 发给测试接收器。

## 6. 证据分层与阶段结论

- **结构证明**：release 模块图/包白名单、严格 IPC、固定资产/文件集合、Key 目标绑定、常量 migration、预算和状态机。
- **受控实际证据**：Electron 权限/导航/下载、EXE 启动/fuse/ASAR 反例、备份恢复故障点、真实崩溃与本地网络请求去向。
- **环境证据**：独立 Windows 安装升级、实际 Provider 兼容、性能基线；仅在确实执行且条件满足时记 PASS。
- **诚实限制**：模型语义无法完全免疫；受攻 UI 的既有业务能力；本地明文数据库/备份；同账户本机攻击；
  未签名发布者身份限制；用户自行写入 note/对话的私密内容可能进入其主动备份；电池功耗/续航 NOT RUN；
  未提交瞬态内容和任意网页 DOM 不承诺跨重启恢复。

上述限制不是自动接受新漏洞的许可。发现产品承诺越界、已有 Key 外带、任意文件/代码/SQL 能力、混合数据集或
静默数据丢失，必须 REPAIR/REPLAN；无法修复且影响用户的风险提交裁决，不能靠改名为限制通过阶段门。
必要独立安全/持久化/并发审查通过后，E6 新独立 Stage Auditor 再逐项判断最终安全与发布验收。

## 7. 平台依据与核验范围

2026-10-03 查阅官方原始文档；具体 API、fuse 与打包版本仍以 E1 精确资格和实际 Windows 产物为准：

- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)：隔离、sandbox、IPC sender、导航、窗口与 CSP 基线。
- [Electron Session](https://www.electronjs.org/docs/latest/api/session)：Session 权限处理与下载事件边界。
- [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)：关闭不用的启动能力；file 额外权限和 Cookie 兼容需专项验证。
- [ASAR Integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)：Windows 支持、完整性元数据和配套 fuse；开启 asar 不等于已验证完整性。
- [electron-builder NSIS](https://www.electron.build/nsis/)：选定安装器路线；per-user、数据保留等实际配置由 E1/E5 验证，不能依赖默认值推断。

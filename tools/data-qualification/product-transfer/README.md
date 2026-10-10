# E2 正式产品传输资格工具

完整最小场景仍为：全新受控 profile → 正式 EXE 的本地数据面板 → 原生保存对话框资格 → 取消 → 再次保存 → 产品完成状态 → 独立流式读回 → 正常关闭。实际009已通过取消、保存按钮和产品完成状态，但预期目标不存在；文件仍保存到系统默认目录的原默认名。该文件与内部output字节相同且独立容器校验通过，整轮仍为FAIL，原件保留。

当前停止重新运行完整产品场景，先执行正式tasks规定的文件名提交最小资格：自有IFileSaveDialog夹具用GetResult核最终选择，区分Edit文本与Shell提交状态。该资格不启动产品、不写备份；只有新方法经独审和实际资格证明后，才修订本目录产品helper并恢复验收。下列WM_SETTEXT文本双读规则是009所用候选，不再作为最终目标选择已成功的充分证据。

当前候选恢复完整小场景。实际008投影中保存/取消按钮均有原生 `Button` 类、ID 1/2、同PID、enabled/visible及HWND，UIA类型为other且没有Invoke。另有同ID但无HWND的节点。因此按精确原生HWND检查MSAA默认动作：资格失败即停止；`InspectSaveDialog` 只有文件名和两个按钮全部合格才成功。首个实际场景须经新独立审核，纯测试不授真实备份PASS。

## 执行入口与边界

只从已审的 disposable profile 包装器执行：

```powershell
pwsh -NoProfile -File tools/release-profile/disposable-profile.ps1 -Action Run -Runner ProductTransfer -PackageRoot <已核对的win-unpacked>
```

包装器固定映射本目录 `run.ts`，不接受任意脚本。沿用 KnownFolder 实体 profile、ACL/marker/文件身份、单一原生 Job、进程身份档案和归零后终态记录。只接受初始 owner marker，没有其它数据的全新 profile；不迁走、覆盖或删除未知用户数据。失败 profile、旧 scope、产物和原始日志全部保留。不得直接调用 `run.ts` 绕过包装器。

产品为 unsigned Windows x64 正式发行构建。先核对 EXE、ASAR、fuse、guardian 及固定 worker；不用 smoke 或 qualification 入口。产品子进程删除全部 `AIBROWSE_*`、`ELECTRON_RUN_AS_NODE`、`ELECTRON_RENDERER_URL`、`NODE_OPTIONS`，不以环境变量替换实际 release 数据根。唯一 Chromium 参数为无额外执行能力的 `--force-renderer-accessibility`。不调用内部 IPC、CDP、任意页面 JS 或 Provider。

## 固定预算与停止条件

- runner 的所有异步工作等待共用启动时建立的 480 秒绝对期限，包括身份探针、读写、诊断回执与产品退出；退出等待至多 30 秒且夹到剩余额度。到期停止后续动作并保留未结算的原 Promise，不把逻辑失败当作真实退出。失败报告只做一次异步提交，不延长工作额度；提交失败或未完成也不授成功。
- 外层原生 Job 保持原有 600 秒工作 + 30 秒实际归零确认。每个 UI 动作 30 秒，runner直接持有的helper超时后发送精确自有进程终止；既有identity helper内部的pwsh仍由外层Job持有。480秒是停止本轮工作，真实整树收口必须看外层Job，不能声称所有未知helper已被runner终止。
- UIA及MSAA同步调用可能阻塞；返回后、标记成功前以及最后回执 flush/close 后均核原 30 秒期限。runner 的 35 秒 helper 等待仅用于收口，不延长成功期限；必须同时有匹配回执和 helper exit0，磁盘上单独的 ok 不能证明按期完成。
- 外层 Job 保留 kill-on-close，并加总计 24 个进程的 native ActiveProcessLimit。仅启动一个产品主进程；角色采样上限为 main 1、guardian 1、Chromium renderer/GPU/crashpad 16、utility 2（包括 Chromium 网络服务及一个串行数据 helper）、工具及 conhost 4。
- 角色计数是在动作边界的完整 Job 列表采样，不冒充连续逐角色硬限；总 24 是原生硬限，回执记录系统实际读回的flags/count。采样期间持有Job及每个进程句柄，先核PID/创建时间/映像/实际Job成员，CIM按同一身份交叉核对（时间取CIM的微秒精度），结束再核原句柄、成员集合与限额。回执保留这些固定身份，不记录命令行正文。采样遇进程消失、未知类型、列表不足或身份变化即停止，禁止自行重试整轮；有限复核不宣称冻结整个系统的原子快照。
- UIA 树每次最多 512 个节点；每份回执最多 64 KiB。工具不按桌面全局标题寻找窗口：以已登记 PID/创建时刻/EXE 获得主 HWND，再仅允许其同 PID owned `#32770` 原生保存窗口。
- 历史按钮只读投影函数保留用于重放诊断源码；当前Inspect不再刻意受控失败。历史投影仍受512节点/32候选、闭合分类及30秒门约束，不将008诊断完成当作实际按钮动作成功。
- 保存/取消按UIA整树含根最多512节点枚举，在已核dialog内唯一匹配精确ID 1/2、ClassName Button、同PID、enabled、非offscreen、非零HWND及有限精确名称。保存名称仅 `保存` / `保存(S)` / `保存(&S)` / `Save` / `&Save`，取消仅 `取消` / `Cancel`。不依赖UIA ControlType或InvokePattern；同ID无HWND或其它类/名称节点不能成为动作目标。
- `NativeSaveButton.cs` 持有精确产品进程句柄，核PID/创建时间/映像/存活、主窗口、dialog owner及原生Button、GetDlgCtrlID、GA_ROOT、IsChild、WS_CHILD、enabled/visible。MSAA固定OBJID_CLIENT/IAccessible/CHILDID_SELF，仅接纳S_OK、role43、无unavailable/invisible/offscreen、精确已核名称、非空DefaultAction。动作前在同一COM对象上读两次语义并再次核原生身份/期限，只调用一次默认动作；异常或迟到不得重发。finally释放COM和进程句柄。同步阻塞由35秒helper及外层Job实际收口。
- MSAA回执只含version/mechanism/controlId/nameClass/hresult/role/available/visible/defaultActionPresent/nativeIdentityVerified，不保存原始未知Name或DefaultAction。Inspect、Cancel、Save均保留两个按钮证明；后两者另有固定buttonAction证明。名称只输出原有限集合内已核值。
- 文件名只接受唯一 host 子树内唯一 AutomationId `1001`、ClassName `Edit`、同 PID、enabled 且非 offscreen 的 UIA 节点及其非零 HWND；host 同样须满足 PID/启用/可见资格。UIA ControlType 和 ValuePattern 仅作固定结构事实记录。原生层持有精确产品进程句柄，复验 PID、创建时间、映像、存活、主窗口及 dialog 归属；输入必须是同 PID 的有效、启用、可见 `Edit`，`GetDlgCtrlID=1001`、`GA_ROOT=已核owned dialog`、`WS_CHILD=true`、`ES_READONLY=false`。所有权不明、零句柄或类别变化即停止，不猜第二条输入路线。
- 每次原生读写前后重新检查 UIA host 子树，要求 host 和输入的 UIA 身份、HWND 均保持一致；原生消息之间也复验持有进程和窗口身份。初值只在 RAM 内完全匹配 `AIbrowse-backup.aibak` 或 `AIbrowse-backup`，回执分别只留 `exact-default` 或 `exact-stem`；不推断系统省略扩展名的原因，也不把初值投影扩为产品承诺。保存只写 runner 的固定、绝对、不存在 `.aibak` Target；写后以及 MSAA保存动作前完全读回并再次核身份。取消不写入文件名。保持产品选择 → 原生确认的数据流程，不绕过产品确认。
- 原生 helper 仅发送 `WM_GETTEXTLENGTH`、`WM_GETTEXT`、`WM_SETTEXT`，使用 `SendMessageTimeoutW`、固定 flags `0x23`，每条消息上限为 `min(1000ms, 原30秒剩余)`。接收控件必须属于独立产品 PID 和线程，禁止 broadcast、任意消息和 `NOTIMEOUTIFNOTHUNG`。文本最多 4096 个 UTF-16 单元，仅在 RAM 内使用；长度、返回计数或完整读回不符即失败。写消息超时可能已产生副作用，失败后不重发、不执行按钮动作、不授成功。
- host 结构诊断只在已核对 owner/PID/标题/`#32770` 的对话框内遍历一遍 Control View，含对话框根最多 512 节点；枚举时只在内存保存 UIA 引用、父序号与 AutomationId 固定分类。必须恰好一个 `FileNameControlHost`，再投影其最多 8 层祖先（含对话框根）、host 本身及全部最多 16 个后代。不存在、重复、预算不足或读取错误均停止，不把截断子树当作完整证据。节点索引和父序号只相对于本份局部回执，不保存全桌面路径或 RuntimeId。
- 输出至多 25 个局部节点，各字段固定为关系/父序号、ControlType 分类、ClassName 分类、AutomationId 分类、同 PID/启用/离屏布尔、ValuePattern 是否存在及只读状态。ControlType 只识别 Edit/ComboBox/Pane/Custom/Group/Window/Button/Text；ClassName 只识别 `#32770`/Edit/ComboBox/ComboBoxEx32/DirectUIHWND/DUIViewWndClassName/FileNameControlHost/Button/Static；AutomationId 只识别空/`1001`/`FileNameControlHost`。未知字符串一律归 `other`，不扩表猜测私有内容。详细 UIA 属性只读取上述局部节点，不读取其 Name 或 Value，不保存原始未知 ID/class、文件名、路径或 shell 内容；底层读取异常只留固定失败分类。`filenameHostStructure.status=complete` 只证明局部采集完成，`filenameNativeSelection.status=uia-bound` 只证明 UIA 绑定；必须继续通过原生资格、精确默认值和按钮资格才产生成功 dialog 资格。
- 旧文件名聚合诊断与 ValuePattern 选择器保留作历史回归，实际 Inspect/Cancel/Save 已不调用它。旧默认值可见性假设不能成为永久产品要求，也不能用新结构解释早期失败的唯一原因。旧 host 独立测试在本轮由实现者维护断言后属于作者回归；本轮独立审核须另建反例，冻结旧诊断源码及测试原件可用于精确比较。
- 每步失败即结束；不自动换窗口、重跑、放宽期限或清理失败现场。外层 `terminal.json` 的 `jobReleased` 和 `markerValidated` 均真才证明本轮已安全收口，内部 `report.json` 不能独自证明 Job 归零。

## 文件名定位的工程依据与本轮停止条件

微软说明 [AutomationId 仅在同级中唯一，定位需要容器范围](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/use-the-automationid-property)，而 [Control View 是动态 UIA 树的过滤视图](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-treeoverview)。本方案以本机已取得的 host 结构约束定位，并用 [Automation.Compare](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automation.compare?view=windowsdesktop-9.0) 比较重新取得的 UIA 对象身份；不把一次树观测当作不可变的系统接口。

[Electron 的 defaultPath](https://www.electronjs.org/docs/latest/api/dialog) 是默认目录、路径或名称；[IFileDialog.SetFileName](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifiledialog-setfilename) 设置初始文件名。这些文档没有承诺默认名必然出现在当前 Control View 中某个 Edit 的 ValuePattern，因此本轮修订的是可观测性假设，保持产品主动选择和原生确认的数据流程。

[GetDlgCtrlID](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdlgctrlid) 与 [GetAncestor / GA_ROOT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getancestor) 提供原生 ID 和父链检查。[WM_GETTEXT](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-gettext) 的缓冲区包含终止符、返回长度不包含终止符；[WM_GETTEXTLENGTH](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-gettextlength) 可高估长度，所以同时校验实际返回值、前后长度和完整文本。[WM_SETTEXT](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settext) 返回值必须成功。依据 [SendMessageTimeoutW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw)，同队列可能忽略 timeout，因此固定目标必须是另一进程，且 helper 始终受 runner 35 秒与外层 Job 收口保护。

009已执行过本候选的独审后单次完整小场景；不得复用该许可无诊断重跑。host非唯一、结构超限、HWND为零、原生身份不符、默认值/完整读回不符、MSAA语义不符或期限耗尽均立即停止。不得换点击路线或重发动作。前后身份与语义检查是有界观测，不能承诺原子冻结系统或消除所有句柄复用竞态。

`test-native-save-button.ps1` 以008形状和敌手节点执行当前选择函数。`native-save-button.test.ts` 执行实际C#身份和MSAA状态机，OS/COM获取使用封闭纯端口；真实P/Invoke声明另经Add-Type编译。当前Inspect成功及文件名旧反例均恢复执行，不skip。为适配MSAA而更新的历史独审夹具在本轮仅算作者回归；新的Reviewer必须建立独立上下文和反例。`test-button-diagnostic.ps1` 须显式传入 Source/BeforeSource；`test-save-button-independent.ps1` 须显式传入 SourcePath/BeforePath，二者仅重放冻结历史诊断的受控失败行为。归档旧协议不变比较由 test-product-completed-archive-review/repair-review.ps1 显式接收 BaselineSource；默认当前测试不依赖 ignored 历史快照。

## 证据与 oracle

在包装器 journal 的 `runner-output/product-transfer` 下排他建立：launch contract、package/进程身份绑定、每次 UIA 原生控件资格、Job 采样、取消目录零产物、最终备份、独立读回及报告。取消后目标目录必须为空；成功 UI 必须显示“备份已完整保存，原数据业务已恢复”，且备份按钮重新启用。

`run.ts` 固定16项工具来源摘要包含 `NativeSaveControl.cs` 和 `NativeSaveButton.cs`；替换 helper 字节必须改变来源绑定。纯测试执行实际消息/身份逻辑时，仅将所有 P/Invoke 声明替换为固定假端口，并拒绝任何未隔离声明；它证明拒绝规则和超时控制，不代替真实 Windows API 或产品验收。

成功归档固定绑定ui-4-InspectSaveDialog、ui-6-CancelSave、ui-12-SaveBackup及report的dialogQualification/cancelAction/saveAction，严格校验动作证明和互相一致。旧UIA Invoke证明或新增未知字段均拒绝。16项源码单个≤8MiB、累计仍≤32MiB；原metadata≤8MiB、150秒共用读回、包和备份预算及持锁/身份协议保持。

固定身份探针失败时，报告额外保留该探针退出码及最多 8192 字节 stderr，明确截断标志；等待探针流关闭后才收集。
这只增加本地工具诊断，不把诊断当身份成功，也不收集网页、Provider 或业务正文。原始输出仍不入 Git。

`backup-evidence.ts` 只读实际目标，以 64 KiB 块复核固定魔数/版本、4 KiB manifest、四固定成员、同一 snapshot UUID、frame 长度/摘要、每成员实际 SHA256、精确 EOF 和前后 inode/size/mtime/ctime。它专验产品 writer 的规范 JSON 输出，拒绝非规范 JSON/重复键；不作为用户导入 parser。它不展开或执行 SQLite、容器路径和 SQL，也不声称业务语义或成员数据与旧库的逻辑一致性已独立证明。

## 真正未完成的条件

1. root 提供包含最终 E2/guardian 的已绑定正式 unsigned package，并确认其它实际验收未占用同一 profile/Job。
2. 新固定 runner、Job 限额与 UIA/file-dialog 控件选择需独立审核；随后首次小场景才验证真实 Windows 模式，不预称已资格。
3. 本场景使用正常启动生成的小空数据集，不替代正式 50 × 64 MiB Conversation、物理/空间边界与完整恢复证据。
4. 后续需单独扩充原生恢复选择、确认取消/确认、实际外部 relaunch、同 profile 三库与 Conversation 一致性、旧动作不重放、失败恢复态和崩溃点。不能用本轮备份读回替代这些结论。
5. 本机同账户证据不授 E5 独立机器验收。

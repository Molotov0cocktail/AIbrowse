# R/P 产品恢复界面接线

正式契约见 `doc/stage7/tasks.md` 的“产品恢复原生确认接线差量”和“R/P 固定场景装配与总预算”。
`ui.ps1` 提供固定启动状态、Save/Open、取消、四域读取及关闭动作；`confirm.ps1` 提供原生确认。
它们只由冻结的 R/P runner 在受控外层 Job 中调用；完整装配仍须独立审核及真实验证，不能单独运行产品动作。

界面工具只接受 R/P 场景和固定动作，不接收脚本、选择器、按钮名或正文。目标限定本场 journal 的
`product-A.aibak` / `synthetic-H.aibak`，保存拒绝覆盖，恢复持有已生成的小输入并重复核摘要。
每个序号先 CreateNew 占用，再执行界面动作；最终需要原期限内的闭合回执和 helper 实际 exit0。
首次 partial 取消与普通选择/恢复取消分别使用产品源码的固定提示，不混用两种业务状态。

`NativeProductFileSelection.cs` 复用已资格验证的原生 Edit 端口和一次选择/替换消息。
Save 保留默认名/stem；Open 允许空或有界稳定初值，但只写固定目标。初值不落盘。
按钮动作仍须完整 Win32/MSAA 身份、可见/可用状态及精确名称；Cancel 的 ID 2 也使用调用方原期限。
原30秒时钟减去调用方已耗额度，不能在编译或构造新端口后重新授时。

`confirm.ps1` 仅支持 R1 restore、P1 partial、P2 restore 的批准或取消。标题、正文与按钮名
由源码固定。原件固定在已审核 disposable journal 的 `runner-output/restore-native/`；
`*-start.json` 以 CreateNew 先占用一次动作序号，`*-native.json` 为闭合动作结果。
它不替代后继观察器要求的 `*-aN.json` 批准投影，后者必须由 runner 验证实际 helper exit0
和原件后创建。磁盘 `ok=true` 单独不授成功，最终原期限检查和真实退出码仍是必要条件。

原30秒期限覆盖编译、UI读取、MSAA动作和释放；runner仍须使用35秒helper收口上界并持有
原Promise直到退出。UI树最多512节点，文本最多4096 UTF-16；仅固定名字参与选择，不落盘未知文本。
`NativeRestoreConfirmation.cs` 复用旧 SaveButton 的严格类型 MSAA 读取，另有原生身份端口，
绑定首次实际正整数控件ID，拒绝后续漂移。平台默认动作动词只要求非空。
批准可能导致原窗口正常消失，后继身份由独立观察器判断；不会在动作后通过仍存活窗口来证明恢复成功。

纯验证不创建 UI、COM 实例或 Job：

```powershell
pwsh -NoProfile -File tools/data-qualification/product-restore-ui/test-confirm.ps1 -Evidence <新的小原件目录>
```

确认测试覆盖真实 C# 动作控制流及真实 PowerShell Context 函数。Context 测试仅替换有界树
读取和原生owner读取；作用域内的身份、正文、唯一按钮及期限判定保持。原生Win32持有端口
完成编译，尚无真实恢复确认行为证据，仍需独立审核及完整R/P装配。

`test-file-selection.ps1` 比较旧非空夹具路径与新 Open 空初值，覆盖消息次数、期限、部分替换、身份与释放。
`test-ui.ps1` 提取真实入口函数，覆盖固定参数、混代、唯一选择、原生按钮资格、节点/文本上限和迟到。
后者只替换 UIA 树读取端口，不建立真实窗口或 COM 对象；实际产品文案可访问性、文件提交、四域展示与关闭行为仍待验证。

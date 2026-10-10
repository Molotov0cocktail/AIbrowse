# 原生 Save/Open 路径选择最小资格

本工具只验证 Shell 原生对话框是否提交精确路径，不执行备份或恢复。正式边界见
`doc/stage7/tasks.md` 的“E2 原生Save/Open选择区编辑差量”。

## 入口

```powershell
pwsh -NoProfile -File tools/data-qualification/native-file-selection/test.ps1 -Evidence <新的原件目录>
pwsh -NoProfile -File tools/data-qualification/native-file-selection/test-diagnostic.ps1 -Evidence <新的诊断原件目录>
pwsh -NoProfile -File tools/data-qualification/native-file-selection/run.ps1 -Mode Build
# 新独立审核通过后，由主协调串行执行一次：
pwsh -NoProfile -File tools/data-qualification/native-file-selection/run.ps1 -Mode Run -ScopeId <Build返回的新scopeId>
```

Build 只快照六项实际源码并编译 fixture.exe 与 helpers.dll，不创建对话框、COM 实例或 Job。
Run 在预检前用 CreateNew 留下一次性 claim；任何失败保留 scope，禁止复用。
回执先完整扫描原始 JSON 词法，再解析字段；任何层级的转义字段名均拒绝，值内合法转义保持支持。

精确原生 Edit 1001 只接收一次 EM_SETSEL(0,-1) 和一次 EM_REPLACESEL（wParam=0）。
消息发送结果只判断发送完成；每条最多一秒且使用夹具最初30秒的剩余时间。失败或迟到不发送后继。
完整双读和原生身份复核后只执行一次严格 MSAA 按钮动作，不调用焦点、键盘、剪贴板或其它提交消息。

Save 的一次 OnFileOk 与 Show 成功后的 GetResult 都必须是目标路径；COM 注销、释放与真实退出完成后
才能创建 Open 场景。Open 创建真正 IFileOpenDialog 并读回 filesystem/path-must-exist/file-must-exist/
no-recent 选项；独立按钮白名单不修改旧 Save 策略。固定61字节 `.aibak` 只是路径控制文件，
不是有效备份容器。整轮持有其文件身份、只读句柄及固定字节摘要，Save 不创建任何目标文件。
Open 默认动作要求 MSAA 返回严格字符串且非空，保持独立名称、ID、类型、角色、状态及原生身份边界。

原30秒/35秒/整轮120秒及30秒收口、共享filename Job限额、UI遍历上限、单回执64KiB/总1MiB保持。
shared Job 源码 SHA256 固定为 be1fbf5623ae06da19848f33c5837c1c3ca42827935961d99453a1397cbcd167。

`result.json` 永远是 `qualified=false/terminal=pending`，不能授实际成功。
只有完成最终身份校验、释放、序列化和输出后的原期限检查，最终 stdout 才有资格返回
`qualified=true/terminal=wrapper-complete`；调用方还必须核对真实 wrapper exit0。
实际资格通过也只授权后续同原语产品接线，不能替代产品 R/P 或 E2 验收。

测试编译并调用实际 Edit/原生读取/按钮端口和夹具纯函数；Open 身份测试只使用固定小文件。
测试不创建 UI、COM 实例或 Job。失败原件及旧 Build scope 均保留。

## Open 预检失败诊断

helper 保持原回执字段，只细分 `phase` 与闭合 `failure`。阶段为 preflight/runtime/handshake/
binding/native-edit/native-button/initial-recheck/initial/select-replace/button/complete。
原 host/button 拒绝之后，仅在 ID=1、Class=Button 的结构候选唯一时，区分空句柄、PID 不符、
disabled、offscreen 和名称不在允许集；多个结构候选不能推断 disabled。原合格候选过滤与动作门保持。
未知异常只记 helper-unexpected，不记录名称、路径、文本或异常正文。旧失败仍保持 unknown。

诊断纯测执行实际绑定函数的内存替身，覆盖零动作拒绝、512 节点上限、未知异常及旁支不改变原资格。
新的 Build scope 仍只有 Save→Open 两场，供本轮有界根因诊断；不授产品备份、恢复或 E2 验收通过。

## 一次只读 Open 结构观察

`-Purpose open-structure-observation` 必须同时传给 Build 和 Run，并与冻结回执严格一致。
它只启动一次 Open，保持失败夹具的目录、初值、类型与选项；不运行 Save，不调用编辑、焦点或按钮动作。
纯测试入口为 `test-open-structure.ps1 -Evidence <新的原件目录>`；Build 不启动 UI/COM/Job。

观察沿原 ControlView 最多 512 节点统计 FileNameControlHost；`open/structure.json` 只保存
精确计数及 zero/one/many 分类。Win32 子树同样最多 512 节点，只投影最多 16 个原生
Edit/ComboBox/ComboBoxEx32 候选及每个最多 8 层父链。每步检查原期限、精确进程、owner/dialog
及原生节点从属。字段只有闭合 class/ID 分类和 enabled/visible/同进程/同 dialog 布尔状态；
不记录名称、值、路径、原始句柄或未知 ID。观察不选择任何候选。

ID 分类只有现有资格使用的 1001、1148、1149 和 other。Microsoft 的
[dlgs.h](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/dlgs.h)
将后两者定义为 cmb13/cmb14；它们只用于观察分类，不证明现代 IFileOpenDialog 的内部控件语义。
未知 class 同样只记 other，不能据此取得定位资格。

helper 观察完整写入后，campaign 通过固定取消信号关闭夹具，并等待原 35 秒剩余时间。
只有零选择事件、取消 HRESULT、COM 注销/释放、原期限与最终 Job0 均满足，整轮才可返回
`outcome=open-structure-observed` 和 exit0；`qualified` 始终为 false。
任一观测或收尾失败均保留固定原件并返回失败，不重试。单回执 64KiB、总 1MiB 和原 30/35/120 秒不变。

此结果只描述该冻结 Open 夹具。生产 Electron Open 没有传 defaultPath，标题与初值配置也不同；
观察不能直接授生产选择器、R/P 或 E2 通过。后续严格选择器仍须以实测身份、唯一性和最终 COM GetResult 验证。

# 早期启动专项工具

仅在主协调确认正式窗口和 drain 均已结束后执行。它不修改产品、产物、既有 profile 或凭据；
每个场景创建新的合成六根，使用默认 GPU。所有原件和合成根保留，不自动删除。

## 前置条件与运行

先按现有构建流程产生新的 normal、qualification-diagnostic、对应 addon，并完成受影响纯反例。
工具不负责重建产品，不接受旧产物已验证的推断。WorkParent 必须是获准的本地合成父目录；
ArtifactRoot 位于受控 log。以下变量由调用者填写，不从既有 profile/harness 推导。

```powershell
& ./tools/watch-qualification/startup-check-build.ps1 -OutputDirectory $buildRoot -WindowEnded
& ./tools/watch-qualification/startup-check-run.ps1 -WorkParent $workParent -ArtifactRoot $artifactRoot -ToolPath (Join-Path $buildRoot 'startup-check.exe') -WindowEnded
```

仅一次 suite，外部 watchdog 420 秒。正控首先确认 Electron 43.4.0 实际支持工具固定的
`NODE_OPTIONS --require`；缺失观察记录即失败，不继续后续场景。任何失败保留原件，定位后才决定
是否需要新轮；不自动重试。构建和运行输出均应由调用者保存到 log。

## 范围与判定

九个顺序场景：合成读取/模块正控、无 hook 的真实正常启动、有 hook 的正常启动、延迟一秒真实
父 pipe、缺认证、错绑另一合成根、重复两个安全 user-data 参数、额外参数、真实 normal 构建拒绝。
每个成功资格场景最多 100 秒，其他场景最多 15 秒。缺失/空 user-data 只交现有 native 纯反例，
不会真实启动默认目录。启动时先 assign Job 再 resume；异常和外部超时均由 Job 收口。

实际 ready 核对 PID/creation、父进程、六根 FileId、入口/可执行文件哈希和目录身份。成功资格场景
要求正常 exit0、complete、Job0 和管道 EOF；拒绝场景要求固定 native 错误分类、非零退出、零
认证/ready、限定业务 DB/凭据文件不存在。普通构建另要求观察器未见资格 addon 装配。

每场 resume 前尝试改名实际 userData；延迟场景还在真实认证等待中再试。必须拒绝且 FileId 不变；
同一个新 userData 在任何 pin 建立之前的改名及恢复正控必须成功；随后才 pin 并运行拒绝反例。
这避免在已经固定的祖先目录内选择不独立的正控。此操作不替代历史其余根/重解析点反例。

观察器只记录：受控 CJS 入口/chunk/addon 的加载尝试与内容 SHA256、实际 native prepare/authentication
分类，以及限定凭据文件的 JS 读取 API 调用。正控在 appdata 读取公开固定合成内容，不将 canary 放入
必须为空的 userData/watchTemp。读取尝试位于合成根外时在 JS API 前拒绝并保留缺陷记录，不读取真实内容。

**模块图仍须独立审核。** 将观察中的内容 SHA256 对应到本轮 manifest 和当前产物，检查认证之前的
静态依赖只包含允许的启动能力，业务/凭据实现的首次装配在认证之后。工具记录每个受控模块的加载尝试，
不依据未知 chunk 名字自动推断“业务模块”。normal 入口有静态编译代码，拒绝证明关注资格能力不可达、
业务没有启动、凭据没有读取，不能把存在类定义误称实际凭据访问。

## 证据限制

- hook 是合成专项插桩；另一个无 hook 场景绑定真实未修改入口和 addon。两者证据分别标记。
- JS oracle 覆盖 `readFileSync/readFile/openSync/open/createReadStream` 及 promises 的 `readFile/open`
  对固定 `credentials.json`/`credentials.synthetic` 文件名的读取尝试；计数为 API 观察数，可能重复。
  它不追踪既有 fd、内部 native I/O、任意路径别名、任意 DLL 或全机读操作。
- 模块观察仅 CJS `Module._load` 的受控产物加载尝试。它不证明同一 chunk 内每个类何时构造，不覆盖 ESM。
- 本轮启动边界要由固定 Electron 源码、受审 launcher、当前产物图、无 hook 运行与带正控 JS 记录组合判断。
  此工具不授资源/电池/全阶段 PASS，不做完整负载、OS 沙箱或全机 ETW 声明。
- 原始 stdout/stderr 和 telemetry 只写 log；摘要不输出任意路径、文件正文或真实凭据。

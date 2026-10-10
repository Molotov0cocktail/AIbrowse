# R/P 恢复后继身份观察器

本目录是 E2 专用验收工具，独立于旧 ProductTransfer 十六来源。只观察进程、外层 Job、固定 profile 元数据与
`lifecycle-guardian/writers.json`。不启动/停止产品，不打开数据库，不接入产品 IPC，不打开内部 DataWriters Job
或 `owner.lock`。普通冷启动另由场景 runner 显式创建并核验；本工具只覆盖 R 一跳、P 两跳。

## 装配接口

调用方先核已审 wrapper journal、包 EXE/guardian 制品与源码来源回执，应用原生 Job 总量 24。
`startObserver` 仅启动一个隐藏 PowerShell helper；**返回 client 后再 await client.ready()**。
这使准入失败时 caller 仍拥有 `client.closed` 和 `client.pendingOwned`，不能因准入 Promise 逻辑超时释放 scope。
原 `stop` 回调停止后续动作并交还外层 Job 收口；观察器自身无 kill 产品权限。

```ts
const observer = await startObserver({
  journal,
  appData,
  scene,
  initial,
  deadline, // deadline 为原场景 performance.now() 绝对期限
  executableSha256,
  guardianSha256,
  bindingSha256,
  stop,
});
await observer.ready();
await observer.arm(actionSequence); // 必须在原生批准按钮调用前完成
// 完成既有原生 UI 动作及回执验证，写下述固定投影。
await observer.decide('approved');
const accepted = await observer.waitSuccessor();
// 仅此时可把 UI helper 指向 accepted.identity。
// 首次 UI 资格 deadline = min(原UI30s期限, accepted.bootDeadline, 原场景期限)。
await observer.assertCurrent();
// P 第二跳重复 arm/decide/wait；普通产品退出后：
await observer.finish();
```

`initial` 为 `{pid, created, image}`；`created` 是精确十进制 native FILETIME，不能用 JS number 或 CIM 时间替代。
`bindingSha256` 是调用方已核源码→目录包的原件摘要；它不是工具自行推断的包与源码等价证明。
当前 Guardian Stop 顺序的源文件摘要在启动入口固定核对；源码改变时须重新审核该组合证明。
`ready()`/`arm()`/`decide()`/`waitSuccessor()`/`assertCurrent()`/`finish()` 原 Promise 和 helper 关闭均由 client 持有。
外层 wrapper 的最终释放还必须等待 `pendingOwned===0`、`closed` 真实结算及外层 Job0；逻辑失败不算结算。
原产品分阶段期限由 runner 继续约束；本模块只有原场景余额与新 main 后最多 60 秒，不能代替 partial 排水 20 秒等原门。

## 原生动作原件

固定路径从 journal 推导，不接受任意输入路径：
`runner-output/restore-native/{R|P}-t{1|2}-a{actionSequence}.json`。
caller 在真正验证同一原生动作回执后，以 CreateNew/flush/close 写入闭合投影：

```json
{
  "version": 1,
  "runId": "32位小写hex",
  "scene": "P",
  "transition": 1,
  "actionSequence": 7,
  "purpose": "partial",
  "result": "approved",
  "nativeReceiptSha256": "64位小写hex"
}
```

R1/P2 的 `purpose` 固定 `restore`，P1 固定 `partial`。`result` 只能 `approved` 或 `cancelled`。
TS 与 native 分别读取同一固定文件、验证所有字段及关联；native 另核完整原件 SHA。
取消后本观察器不允许再次 arm 或收养后继；runner 的取消场景不应消费批准交接槽，正式 arm 在计划批准前建立。
如取消发生在已 arm 的动作，停止该观察链并保留结果；不能把晚到 successor 当成合法重试。

## 证明与边界

- 关键进程用 `QUERY_LIMITED_INFORMATION | SYNCHRONIZE` 句柄持续持有，FILETIME、parent、映像及外层成员均核对。
  CIM 只补参数，按其微秒精度核 native 身份；完整权威时间始终来自所持句柄。
- 新 main 必须唯一且由精确旧 guardian 创建；创建晚于旧 main 退出、处于旧 guardian 生命周期内。
  两个精确 guardian 的短暂重叠合法；第三 guardian、双活 main、错父系/nonce/root、未知映像均拒绝。
- profile 的 FileId128/VolumeSerial64 与 Guardian legacy volume/index hash 分别从同根原生句柄读取。
  ledger 的 image 使用 Guardian 相同的路径/volume/index/size/last-write 身份算法；不把它当内容 SHA。
- 所有旧 main 子系已持有 utility 都须实际 signal，真实退出码保留。只有账本登记的 `registeredWriter` 才按数据协议
  要求 exit0；Chromium 服务不承诺该退出码，非0本身不解释为数据 writer 失败。未知 signal/身份均拒绝。
- 未逐个捕获的短命 utility 与中间 null/null 账本，只获 `held-observations-plus-guardian-retirement` 组合证明：
  已冻结 Guardian 不可跳过的 Stop 顺序、精确 old guardian exit0、已持旧资源 signal、唯一后继父系与新同根账本。
  缺任何前提不能通过，未捕获退出码保持 null，未知总数不声称为零。此证明不授 Store 健康或四域语义 PASS。
- 新 main 不额外传可访问性开关。首次 UIA 仍由 caller 用原 30 秒/512 节点门验证，不可手动重启替代。
- `successorSeenMs` 保留协议字段名，但值是保守计时锚点：前一次完整 Job 样本开始时刻，初始缺样本时用 session 起点。
  前一完整样本没有该后继，后继由已持 guardian 在同外层 Job 中创建，故该边界不晚于创建和首次捕获。
  每个新身份在 OpenProcess、父系/CIM 查询前冻结该值；确定为后继时立即核同一 boot60，分类阻塞时间不重新发放。
  后续扫描、批准和原件读取不重置此锚点。TS 在全部证据、关联和期限通过后才一起更新公开身份和状态；迟到保留上一代。

## 预算、原件与验证

helper 单进程计入 tools≤4，原 Job limit flags 必须为 `0x2008`、总量24；main≤1、guardian≤2仅精确交接、
Chromium≤16、utility≤2。成员正常变化不要求前后集合相同。成员查询不完整/API失败及关键身份丢失均停止。
已完整消失且未持有的 ledger utility 单独记录；不会为了逐个捕获短命进程增加 ETW/IOCP。
poll 间隔25ms不是完整事件捕获承诺。CIM、原生 IO、原件 flush/close 都受外层原期限，阻塞时仍持有原 Promise。

固定证据目录 `runner-output/restore-process-{R|P}/`：每个 `tN-record-NNN.json` 是独占状态变化原件，
每交接≤512条/2MiB，每帧≤4KiB；`tN-transition.json`/`tN-final.json` 独占最终回执≤64KiB。
持有身份整个 session≤128（比每交接上限更严格）；触顶失败，禁止覆写旧原件。失败保留首个受控分类和已持事实。
native 连续持有句柄至 helper 的 finally Dispose；不持有内部 Job、所有权锁或 ledger 长期文件锁。

```powershell
npx vitest run tools/data-qualification/product-restore-process/protocol.test.ts --maxWorkers=1
pwsh.exe -NoProfile -File tools/data-qualification/product-restore-process/test-native-pure.ps1
pwsh.exe -NoProfile -File tools/data-qualification/product-restore-process/test-native-deadline.ps1
npx tsc --noEmit --project tsconfig.node.json
npx eslint tools/data-qualification/product-restore-process/*.ts
```

纯检查不创建 observer session、产品、Job 或 UI；实际新后继身份、同根账本与 UI 可观测性仍待新独审后 R/P 首资格。
期限纯回放保留实际 Capture/Scan/Deadline 和锚点绑定，仅替换系统/IO边界与时钟，覆盖开句柄、分类阻塞与跨扫描不续期。
不增加额外通用合成实跑硬门，也不授 E2 PASS。

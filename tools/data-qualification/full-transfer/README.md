# 完整会话 Transfer 容量资格工具

本工具变更须完成受影响范围的独立审核，再按冻结预算执行小原生资格、构建、一次输入导入和一次双操作采集。
当前执行状态只看 `doc/tasks/progress.md`。不得把纯测试或已生成的输入当作产品容量通过。

## 固定输入和产品路径

- 会话来源固定为 `full-conversations-29d6709186ef4d179628e94ec8c73663`，50 个独立
  64 MiB 文件和 15,676 B index，共 3,355,458,876 B。每会话 200 条消息，最大消息
  335,581 B；不代表 4 MiB 单消息或最坏 JSON 形状。
- 三库只取 `runtime-9399eea0c11d4e6f9cde46ae2369376b/fixtures` 的当前三库：
  Sources 5,000、Research 30、Watch 200 规则的既有受控负载，不取可变 profile 或历史 DB。
  既有 fixture proof 的内容 hash 固定，数据库在导入时重新流式核 hash。
- `build.ts` 新建 UUID scope，单独编译薄 main 和**原生产 transfer-worker**，从当前 native 源码
  编译真正 Guardian，并绑定实际 Node、Electron、csc、源码及制品。它不修改或复用普通 out。
- `import-entry.ts` 只把三库与 51 个会话成员直接复制一次到新 profile。每次最多 64 KiB，
  `wx`、短写循环、flush、真实输出读回、EOF、源/目标身份和目录闭合。没有额外 fixture 副本、
  链接、压缩或重建 JSON。失败现场不清理。
- 薄 main 先获得真实 Guardian，然后两次调用生产 Files/guarded adapter/supervisor/worker：
  backup `run → verify → publishBackup`；新的 operation 和 generation 做 restore
  `run → verify`。恢复沿用容器原 snapshotId。每次 worker 的实际退出与 Guardian 退休 ACK
  均由原 adapter 持有，未知退出时不得继续。
- 每次 Files.verify 后，另一个工具专用 counts utility 只读该 operation 的固定 work 三库，
  六条编译期 COUNT 核对 5000/30/200/2800/8400/1030。每次含启动、真实 Guardian 授权、读取和
  实际退出退休最多 10s，并扣同一个操作原 SQLite 90s 的剩余量；最多两次额外 utility。
  单库错误、错计数或未退休均使本操作失败。没有主进程 SQLite，没有任意路径或 SQL 消息。
- 工具没有 Store/Service/浏览器 UI/Provider/网络/业务维护图。`maintenanceOperationId` 与 ticket
  为 null。恢复止于独立 staging；没有 DatasetSwitch、旧 rollback 副本、active、handoff、冷启动。

## 限额和停止条件

| 范围       | 工作时间              | 退出确认                     | 原生硬限                                             | RSS 采样门                        |
| ---------- | --------------------- | ---------------------------- | ---------------------------------------------------- | --------------------------------- |
| 一次导入   | 从 wrapper 开始 120s  | 失败后最多 30s，仅终止与确认 | active=1；process/job commit 各 2 GiB                | 100ms，每进程/整树 ≤1 GiB         |
| 两操作整体 | 从 wrapper 开始 3060s | 失败后最多 30s，仅终止与确认 | active=24；每 process commit 2 GiB；Job commit 4 GiB | 100ms，每成员 ≤1 GiB、整树 ≤2 GiB |

所有 Job 在 `CreateProcess` 时经 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 原子加入；创建前设置、
前后回读限额。每个采样进程都持精确 PID/creation handle 并校 Job 成员，无法取证即失败。
原 Job handle 一直持有到 Active=0，并确认根进程 Win32 handle 已 signal；未知则保留所有权。
失败后的退出专用30s在调用 `TerminateJobObject` 前启动一次单调时钟，包含终止调用、
原 Job 实际归零查询及同一已持有 root handle 的 signal 证明。Job 先归零时，root 只可使用
这同一截止的剩余量；不得重新给30s/10s，也不使用已经耗尽的工作余额把这次等待压为0。
截止内未取得两项证明时保留所有权，终止请求成功、当前 PID 不存在或 wrapper 已退出均不能替代。
正常路径仍最多使用 `min(10s, 原工作剩余量)` 等待 root，不借退出专用期限完成正常工作。
`Failure` 保留首个明确失败；固定 `ExitFailure` 单独记录收口问题，未知退出仍使 `ActualZero=false`、
`OwnershipRetained=true`。末尾原生限额读取/校验失败还会将 `LimitsVerified=false`，
避免保留原 `deadline` 分类后被 timeout 资格入口误认作完整通过。
内存 commit 硬限与 sampled RSS 不相同；采样不能证明两次采样之间峰值，也不保证不会 OS OOM。
每次已核精确成员的既有内存查询刷新峰值时，同批记录该 PID、精确十进制创建时刻、root/other 分类和采样尝试序号。
这不增加 API 调用或过滤任何成员；尝试序号不能证明该次完整采样已结束。历史缺少这些字段时不能后验猜测峰值成员。
导入 Node old-space=768 MiB；生产 utility 原 `execArgv: []` 不变。

PID 列表是可变长观测；原生 active=1/24 硬限不等于列表容量。[Windows 列表契约](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list)
包含该 Job 及子 Job 的成员；[活动计数契约](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)
说明被限额拒绝的进程可暂时增加计数，直到终止且引用释放。不能据此猜测某次现场的成员数或嵌套原因。
采样使用固定 1,032 B 缓冲区，首读仅提供 32 槽；只在错误 234 时提供 128 槽再读一次。
两次共用原工作期限，没有等候或续租。第二次仍失败、其它错误、成功返回但 assigned≠count、
返回字节数不足/越界、列表超当前容量、重复/零/超32位 PID 均立即失败；不从失败或不完整列表采样。
每次 API 的容量、BOOL、错误、返回长度和头计数只记固定整数/布尔；失败头仅供诊断。
保留最后一次采样和最后一次扩容的两次观测，另记累计扩容次数；不输出路径、命令行或异常正文。

完整列表可以超过 active 门，但每项仍必须取得精确 native handle、创建身份及原 Job 成员证明。
只有同一句柄已 signal 且身份复核通过才排除 RSS，并释放该已知退出的采样句柄，避免观察器引用
延迟被拒绝进程的计数退休。裸 PID 的 OpenProcess 失败、成员/身份未知或 wait 异常绝不跳过。
未 signal 的候选累计仍不得超过 import1/transfer24；这是保守采样判定，不声称多次 API 构成原子快照。
累计最多打开并接受 128 个采样身份；未知/活句柄保留原所有权，原 Job 和精确 root 退出门不变。
固定 128 槽仍失败时保留本轮并重定观测方案，不继续增加容量或重复挑绿。

每个操作仍各用新的生产 `TransferBudget`：1500s 工作、10s 子进程退出确认，阶段余量分别
20/120/150/90/1000/60/60s。containerIo 的 worker 封装/解包、主进程 verify、备份发布共用
同一 150s 账本，不能重新进入后续租。未执行的 drain/rollback/publish/boot 余量不转给其它阶段。
最后回执、身份检查和关闭句柄均计入原期限；提前写下 completed 不授权成功，必须同时有
`*-result.json`、wrapper 最终 stdout completed=true、wrapper exit=0 与原 Job actualZero。
首失败停止；不得复用同一 intent 重跑，也不得丢失旧失败。

空间取实际 Win32 allocation unit，调用**生产** `transferSpaceAllocation` 计算首次输入逐文件取整、
保留 backup 的 N+W+C+P 与 restore 的 N+W、M/J，再加 16 MiB 工具/回执和 1 GiB 余量。
不是固定 32 GiB 门。导入前核实际 free；运行时再次核剩余两操作成本，且每操作仍调用原
`requireTransferSpace`。后者本身不含 old rollback O；本工具没有 Switch，不加虚构 O，
也不能据此证明正式恢复的 O 空间门。预检不是配额预留，后续磁盘不足仍必须失败保留。

源文件、制品、证据和大输入持续持只读锁，末尾复查 native FileID、mtime/ctime、nlink、属性，
小证明重 hash。输入只在导入流中读一次；结束不再次 hash 3.2 GiB。生产 Files 独立完成实际
输出 hash，工具补有限 metadata/目录闭合。依赖私有 scope 无其它写者，不承诺敌对同用户并发下
全目录原子快照。没有根据 `kill()`、日志终态或当前空 Map 推断退出。

原 fixture 锁覆盖 import wrapper 至其最终关闭；transfer 的输入是已导入 profile，持续锁该 profile
54 成员到 transfer 收口。import-result 绑定该轮 input-proof 的原 hash，后继不得认领新 proof；
input-proof 还必须匹配编译期固定 54 个 bytes/hash 和两个来源 proof hash。两 wrapper 之间属于
同一私有、串行、独占工作区；不承诺对抗能同时改写全部工具回执的同用户攻击者。
两个 action 的最终回执写入/close 用各自截止；已经完成的第一 action 的最后 metadata 复核用
整体截止，不把两次独立 1500s 错合并为一次。

PowerShell/编译器在数据 Job 外，只持有限源码、小证明及句柄；所列 Job 内存门不覆盖该宿主。

## 固定 WinExe 夹具

小资格夹具无 Console IO、AllocConsole 或界面需求，使用 `/target:winexe /platform:x64` 编译。
编译成功后、任何 Job 启动前，持只读共享锁读取实际产物的有界 PE 头：文件≤1 MiB，
MZ/PE 签名、AMD64、PE32+、可执行非 DLL、头范围及 Subsystem=2 必须全部成立，事实记入 intent。
这里验证编译产物的子系统，不把编译参数文字当作产物证明。

[C# 编译器契约](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-options/output)
区分 console `exe` 与 Windows `winexe`；[Windows 控制台契约](https://learn.microsoft.com/en-us/windows/console/creation-of-a-console)
说明 GUI 进程创建时不附加控制台。原来的
[`CREATE_NO_WINDOW`](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
仅承诺没有控制台窗口及控制台 handle，没有承诺不会产生辅助进程。
实际头字段依据 [PE 格式](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format) 检查。

改变的是夹具不需要的控制台子系统请求，固定自身子进程负载、每进程显式 1 MiB、
`transfer-limit` 的 created23/denied1 和原同时24门保持。原 helper 不过滤 conhost，
每个 Job 成员继续参加完整身份与 RSS 采样。历史 Guardian 原件能证明彼时出现 conhost；
完整列表48的 FullTransfer 失败没有成员映像，其身份仍 unknown，不能声称已证明24×2。

WinExe 是新的资格对象；旧 console 三场 PASS 与全部失败保留为历史证据。
新五场按下列次序各执行一次、各用新 scope，首失败停止：先 `transfer-success`，只主动创建根和
一个子进程，证明最小可行性；成功才继续 `import-success`、`import-child`、`transfer-limit`、`timeout`。
前四场工作各≤12s，timeout≤1.5s；另30s仅确认原 Job 实际归零；落盘≤1 MiB，
每进程/整树 commit、RSS、实际 Job0 与精确 root signal 等门保持。
最小场失败即保留现场并重定方案，不扩大缓冲区、活成员数或期限，也不追加无诊断重跑。

## 审核后执行入口

### 固定 Node 启动资格

import 专用创建标志为 `DETACHED_PROCESS | EXTENDED_STARTUPINFO_PRESENT`（`0x00080008`），
transfer 保持 `CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT`（`0x08080000`）。两者均保持
原 `PROC_THREAD_ATTRIBUTE_JOB_LIST`、不继承句柄和原生限额。原生结果记录实际传入的 `CreationFlags`。
[Windows 创建标志](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
规定 DETACHED_PROCESS 不继承控制台；[控制台创建语义](https://learn.microsoft.com/en-us/windows/console/creation-of-a-console)
进一步说明该 console 进程初始不连接控制台，之后仍可自行 AllocConsole。因此这一选择需要真实小资格，
不能据标志推断没有辅助进程，也不能恢复历史额外成员的身份。

只有活候选超限的失败成员会追加 `FailedSampleImage` 固定分类：`root`、`system-console-host`、
`other` 或 `unknown`。查询使用已核精确句柄，最多一次 32,768 字符的 image 查询，并复核创建身份、
Job 归属和原工作期限。root 匹配已核 root PID/creation；console host 匹配系统目录的完整 conhost 路径，
不能仅匹配 basename。所有路径只在内存比较，不输出路径、命令行或异常正文。分类失败保留原首失败，
任何类别均不跳过活成员计数、RSS 或退出门。

`node-tiny.ps1` 无参数，只使用已固定 SHA256 的当前 Node 24.18.0；启动前检查实际 AMD64、PE32+、
非 DLL、Subsystem=3。Node、工具、helper、编译器、编译产物及固定脚本持续持只读锁并绑定 hash/身份。
新 scope 内只执行固定 16 B 文件往返与 crypto 校验，以及当前 import 使用的 stdout/stderr 常量写入。
成功回调后等待固定 1s，再独占创建完成文件；标准流报错不能产生成功文件。不调用 importInput、
不创建 child、不访问容量原件、不创建 profile。这里的 stderr 常量是资格内容，不表示产品导入已运行。

整个 wrapper 工作≤12s；原 import active=1、process/job commit 各2 GiB、单进程/树 RSS≤1 GiB；
失败后仅同一个30s单调截止终止并确认 Job0/held root signal，落盘含源码、DLL与回执≤1 MiB。
通过必须有至少一次完整采样、原 native 成功/身份/限额/退出门、ExitFailure=null、闭合小完成文件和
wrapper最终 ok=true/exit0。入口不以小文件完成替代原生门，也不以原生正常退出替代脚本证明。
结果另保留首个失败的闭合 `phase`：scope/runtime/compile/binding/execute/receipt/final-bindings/finish。
后续关闭、环境恢复或回执错误不能覆盖该阶段，也不输出异常正文。

先完成纯反例和新的独立审核，再仅执行一次此新 Node tiny；首失败停止，保留原件并按新证据 REPLAN。
不增加 active 门、PID容量或时间，不因 system-console-host 类别过滤成员。旧失败 scope 保留；
tiny PASS 只证明启动最小可行性，之后需要新建绑定当前源码的 full-transfer scope，不能沿用旧构建。
开发 Electron GUI RunAsNode 是候选失败后的独立 REPLAN 方向，本方案保持原 Node 运行时。

```powershell
# 只在独立审核和本轮额度已明确后执行；每项首失败停止。
pwsh -NoProfile -File tools/data-qualification/full-transfer/node-tiny.ps1

pwsh -NoProfile -File tools/data-qualification/full-transfer/qualify-runner.ps1 -Case transfer-success
# 最小场通过后依次：import-success、import-child、transfer-limit、timeout。
# 每场景单独新 scope；≤24 个 native 小进程、每进程显式分配1 MiB、落盘≤1 MiB。

node --experimental-strip-types tools/data-qualification/full-transfer/build.ts
pwsh -NoProfile -File tools/data-qualification/full-transfer/run.ps1 -ScopeId <构建返回ID> -Mode import
pwsh -NoProfile -File tools/data-qualification/full-transfer/run.ps1 -ScopeId <同ID> -Mode transfer
```

构建入口直接使用已安装的 Node24、esbuild 和 .NET csc，不安装新工具。

## 证据边界

保留 build/input/import/campaign/backup/restore/result、native helper DLL/编译器 hash、完整阶段帧、
真实 Guardian authorize/retire 顺序、51 成员的最终树摘要、输入原件和所有工作目录。
固定 `observations.jsonl` 总计≤64 KiB，每条 flush；原生 fail-stop 即使来不及 JS catch 仍保留
最近阶段与 ACK 边界。JS 失败只记录固定 stage 和受控错误类别，不记录 SQL、敌手正文或额外路径。
观察失败始终转发原协议与实际 exit 回调，不伪造原 Promise 结算。
旧 runtime 的 8-stage/30s 采集不作为本轮生产 pipeline 的执行证据。
通过本工具最多证明指定受控全会话容量输入的生产传输路径；不能批准 release/UI、真实选择器、
业务 drain、正式恢复切换/回滚/重启、容量之外的故障矩阵或完整 E2。Guardian 自身失败必须诚实
保留，不能替换成 no-op；独立的 release/UI Guardian 问题仍保留。

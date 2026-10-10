# 维护排水资格准备

这是 `doc/stage7/detailed-design.md` §4 所需的读取/解析前资格工具。只用合成数据，
直接导入当前产品服务、运行时与 Repository，不复制业务实现、不打开 Electron、不读取真实 profile 或 Key。
本目录不实现产品维护接口，不授 E2 产品 PASS。

## 固定方案与停止条件

- 3 轮，每轮串行执行 Conversation、Research、Watch 三个固定场景；每轮最多 20 秒。
- 每个旧方法返回后保留原操作至少 150ms，再由夹具明确释放延迟端口。
- 外层沿用已审核、未修改的 `tools/release-profile/JobProcess.cs`，90 秒执行、30 秒终止确认。
- 单次构建及证据最多 1 GiB、最多 256 个诊断事件。全部路径由固定构建 ID 派生。
- 无 TCP listener、无 HTTP 请求。Provider/acquisition 是编译期固定内存端口；不存在外部地址、
  路径、SQL、命令参数入口。`synthetic.invalid` 仅是合成配置/规则标识。
- 任一准备、启动、反例、真实 Promise 结算、磁盘、Job 归零条件不符，即停止本次测量并保留原件。
  不自动重跑、换包或按观测结果放松阈值。单轮定时器不能打断原生阻塞，外层 Job 才是最终收口。

这些数字只是资格测量预算；150ms 是人为安排的反例窗口，**不能作为产品自然排水时延**。
最终 E2 预算还需全容量 IO、实际维护接线及 UI 的共同测量。

## 场景与证据边界

| 场景         | 真实实现                                                               | 原操作/持久化判定                                                                | 预设红态                                                                            |
| ------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Conversation | `ConversationServiceImpl.ask/dispose`、`ConversationStore`             | 固定包装原 `runAsk`，返回同一个 Promise；真实 JSON 写入并重新读取 assistant 终态 | dispose 返回时原 Promise 未结束，释放 Provider 后仍写入 aborted                     |
| Research     | 生产 RuntimeFactory、ResearchRuntime、ResearchService、真实临时 SQLite | 工厂装饰仅观察原 `handle.done`；独立 SQLite 连接读取同一任务                     | stop 返回仍 running，释放 Provider 后变为 cancelled                                 |
| Watch        | WatchRunCoordinator、WatchProcessingService、真实临时 SQLite           | 直接跟踪 acquisition 原 Promise，另查 coordinator 活动数/持久化 run              | stop 返回且活动计数为 0，原 acquisition 仍在途；旧 run 仍 running，留待现有启动收敛 |

Conversation 的固定私有方法诊断接缝改名/不再返回 Promise 时必须失败并重定方案，禁止回退到
inFlight 大小。Research 工厂保留真实 Provider 解析与 runtime；planning 会在模型调用前读取
一次 `listGroups({page:0,pageSize:20})`，夹具返回合法空分组并记录唯一调用。
其余 Sources/browser/search 操作在首轮 Provider 取消之前不得被使用，意外调用直接失败。
Provider 入口与真实 `runtime.done` 同时观察；runtime 先结束或拒绝时立即报告前置失败，
并记录真实任务状态、错误码与步骤/模型轮次，不能继续等待一个永远不会进入的 Provider。
入口已进入但 runtime 同时结束也拒绝，不进入排水测量。Watch 使用固定 revalidator/scheduler，
实际采集故意延迟响应 abort；这证明旧 stop 不覆盖原采集，不代表实际网络耗时。

报告分别记录方法返回、原 Promise 结算、延迟端口释放、终态读回、返回后的写入、未完成计数。
`completed=true` 仅表示预设旧行为反例已收集，`productE2Pass` 始终为 false。
不宣称覆盖 Agent 工具、Digest、Provider 解析期间 shutdown、Tab 关闭失败、Source 观察日志、
恢复/重开、满容量磁盘或真实 UI；它们仍需 E2 正式接口及后续资格。

旧夹具误将 `listGroups` 前置准备当成禁止操作并抛错，runtime 在模型零轮时已写入 failed，
夹具却只等待 Provider 入口，最终耗尽 20 秒。该失败证明旧夹具假设失效，不证明 Research
排水超时；旧包、运行原件及真实 SQLite 终态保留。Conversation 已观测的提前返回证据仍有其
自身适用范围，不能代替修复后 Research 的实际测量。

## 静态准备与受控运行

仅使用仓库已有 Node 24、Vite、TypeScript；不安装/下载依赖。

```powershell
node --experimental-strip-types tools/data-qualification/drain/build.ts
# 只执行纯判定器测试，不启动测量夹具：
npm test -- --run tools/data-qualification/drain/contract.test.ts tools/data-qualification/drain/controls.test.ts --maxWorkers=1
# 启动器环境反例只运行 Node --version，不调用夹具：
pwsh -NoProfile -File tools/data-qualification/drain/launcher-environment.test.ps1
```

build 不运行产品代码，输出到 `log/stage7-e2/drain-<32位ID>/`，保留 bundle SHA256、实际导入
源码摘要、Git baseline 和 Node 版本。产品未提交差量由源码摘要绑定，不能只凭 HEAD 复用证据。
旧 Watch 资格三个编译开关固定为 false；最终 bundle 若仍含 Electron import 或动态块则构建失败。
这只去除与本测量无关的旧 seed 入口，不替换任何本次被测产品方法。实际解释器为本机 Node 24，
与 utilityProcess 所用 Electron 内嵌 Node 版本的差异须在后续正式产品验收中覆盖。
fixture.cjs 是独立 Node 测量程序，不是 Electron 产品包；不能将其结果写作正式 Windows 包验收。

主协调者明确安排运行窗口后，只能运行指定 ID 一次：

```powershell
pwsh -NoProfile -File tools/data-qualification/drain/run.ps1 -BuildId drain-<32位ID>
```

run 验证实际 bundle/Node/预算，Node 预检与实际 Job 都先进入固定环境，finally 恢复；
非白名单变量用 `[NullString]::Value` 真正移除，避免 PowerShell 把 `$null` 转为空字符串。
运行进程创建时原子加入 Job，核对进程成员与真实归零。
已有 runtime 或 job-result 的 ID 一律拒绝复用。原件保留为 `runtime/events.jsonl`、
`runtime/report.json`、`job-result.json` 和每轮合成数据，不删除失败现场。
对实际测量以外的纯判定器测试，不能推断上述运行红态已经观测。

# 完整会话准备的固定外层监督

`run.ps1 -ScopeId full-conversations-<UUID32> -RuntimeId runtime-<UUID32>`
仅接受已构建的新 scope 与既有合成来源 ID，不接受路径、脚本、预算参数或 Electron。
开始即排他写入 run-intent；成功、失败或未知退出均不能复用该 scope 重跑。
原六个准备工具文件保持独立审核时的冻结内容。

## 已批准的准备预算

- 工作 **150 秒**，从 wrapper 开始的单调时钟计，源码核验和编译耗时扣除后，剩余值传给 native Job。
  停止后另最多 **30 秒**仅用于终止并等待所持 Job 实际归零；不启动新工作、不读数据证明成功。
- Job 在创建 Node 时通过 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 原子赋予。进程数硬限 **1**，
  禁止 breakaway，kill-on-close。创建前设置限额，创建前和真实退出后读取同一 Job 验证。
- 原生进程及 Job **提交内存硬限各 2 GiB**；这不是 RSS 硬限。
  每 100 ms 从持有的原进程句柄采样 WorkingSet，超过 **1 GiB**请求终止；短峰可能未被采到。
- Node `--max-old-space-size=768` 只约束 V8 老生代；Buffer、年轻代、native 等不在这个堆限内。
  历史指定投影 `projection-39ad20d443ae48aca1048413c6053aed` 采样峰 **582180864 B**，
  `runtime-9399eea0c11d4e6f9cde46ae2369376b` utility 采样峰 **532316160 B**。
  当前只投影一次 64 MiB ASCII 模板，其后为 64 KiB 复制；1 GiB 门约为历史较高采样值的 1.84 倍。
  这只是工程余量，不保证任意最大形状成功，也不承诺系统不会 OOM。
- PowerShell wrapper 不在 Node Job 内；它只保留有界元数据、文件锁和 native 句柄，不读取整份会话到内存。
  编译及主机 PowerShell 内存没有该 Job 的硬限，不能把 Node 限额说成整台机器的限额。
- 数据上限 **3201 MiB**，工具与准备证明另 **1 MiB**，wrapper 证据另 **256 KiB**。
  预检按卷分配单位为 50 个 64 MiB、851968 B 工具及 10 个 64 KiB 元数据／目录槽向上取整，
  再要求 **1 GiB**空闲余量。目录槽是保守估算，不是文件系统配额保证；当前余量不能保证写入中不耗尽。

## 绑定和完成

wrapper 核对固定源码集合、build-proof、工具制品、源证明、Node 文件版本与摘要，
以及 runner/helper 本身摘要；这些输入以只读且禁止共享写入/删除的文件句柄持有至完成。
固定首个 64 MiB seed 也由同一只读句柄计算真实 SHA256、核精确长度并持续持有，
不能用来源 proof 的锁代替原件的锁。启动回执记录该 seed 的摘要与原始 native 文件事实。
子进程环境采用最小环境白名单，没有 NODE_OPTIONS、Electron、AIBROWSE 或 Provider 配置继承。
父级以同一 Job 的 ActiveProcesses=0 和持有的根进程 exit0 判断退出，**不重新创建／打开 Job 证明退出**。
无法确认归零时返回 OwnershipRetained，保留原句柄至 wrapper 结束，结果为失败；不复用目录或自动重启。

成功还需产品投影准备回执、51 个闭合文件、字节数、Node 实际文件身份与 native 文件身份吻合，
以及无 sparse/compressed/reparse 输出。退出后只做元数据和小证明检查，不重新读 3.2 GiB 哈希。
这些输出也在 wrapper 最终回执写入期间被持有，之后再核目录名单及工作截止。
最终检查同时覆盖全部原输入、51 个成员和两个产品小证明的原句柄；核 dev/ino、长度、
mtime/ctime、单链接与普通文件属性。共享读锁不保证 metadata 或 nlink 不变，不能省去这步。
输入／输出小证明先从原句柄重新哈希，再检查目录闭合和全部原文件事实；不增加整组会话哈希。
自己的 intent/launch/result 回执也从排他创建的原句柄持有，不在完成点重新认领同名替代物。
单独 `run-result.completed` 不授权成功：最后检查失败会以 wrapper exit1 和 stdout false 收口，
旧回执保留。所有持有句柄关闭后再检查同一 150 秒截止时间，关闭尾部不另开工作窗口。
任何后续产品验收仍须自行验证实际输入，不把准备当作 E2 Transfer PASS。

## 最小 native 资格

`qualify-runner.ps1 -Case success|timeout|child` 每次新建独占日志目录，不能覆写旧原件。
只启动一个固定 Node 脚本，分配 1 MiB（授权上限 64 MiB），落盘远小于 1 MiB。
成功/拒绝 child 各最多 5 秒工作，强制终止例 1.5 秒工作，每次另最多 30 秒真实归零。
它们验证实际成功、超时 kill 后原 Job 归零、第二进程被拒、限额读回，以及 native/Node 文件身份一致。
没有通过申请 GiB 内存制造 OOM；内存硬限执行只验证设置/回读，不声称实际触发过 OOM 门。
资格日志与源码摘要保存于 `log/stage7-e2/full-conversations-native-*`，原件全部保留。
首个异常即停止调查，不自动重试。尚未执行完整 50×64 MiB 生成。

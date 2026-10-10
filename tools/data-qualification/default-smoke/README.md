# E2 默认冒烟固定矩阵工具

本目录提供有界的普通开发或 production 默认 `AIBROWSE_SMOKE=1` 矩阵。每轮只接受一个固定 Variant；它只用于 E2 候选准入，不能替代 E2 产品备份/恢复验收、独立持久化/隐私审核或 Stage7 PASS。

## 固定行为

- `run.ps1` 只接受必填的 `-Variant dev|production`，无场景、脚本或路径参数。每个新 UUID 只执行所选 Variant 的一次完整默认矩阵，遇到第一失败立即停止，不清理、不重跑、不枚举或终止仓库外进程。
- dev 使用已资格的 `electron-vite@5.0.0` 真实启动路径、`file:` URI Node preload 和 `installCrossSpawnHook`。构建完成后，hook 立即通过 `prepareCrossApp` 冻结 `out/main`、`out/preload`、`out/renderer`、`out/lifecycle-guardian` 并改为私有 app 根启动。
- 默认矩阵的 SRT-03/SRT-12 会从 appPath 扫描源码，`scope.ts` 因此在真实启动前排他复制当前 `src` 到私有应用目录。源码单成员仍限 8 MiB，集合限 32 MiB/2000 项/深度 16，纳入原工作和原件预算；复制前后、独立读回时核对原候选及副本的完整路径/长度/SHA-256 清单，不使用链接或跳过自检。dev 包装既有 spawn hook，production 使用同一默认准备入口，旧 cross 工具不变。
- production 不构建。主协调者必须先在同一冻结候选根执行普通 `npm run build`；wrapper 在任何应用启动前要求四类普通 `out` 完整、主制品内嵌 helper 清单与就近 `manifest.json` 字节一致，并复核 helper 的长度和 SHA-256。它随后冻结该普通 build，经 `prepareCrossApp` 从私有 app 根启动，绝不复用 dev 轮生成物冒充 production build。
- 应用及适用的 prepare/readback Node 都由创建时原子加入的 `JobProcess` 持续监督。通过必须同时具备 exit 0、held Job 实际归零、`main/utility` 账本均为 null、完整固定“冒烟场景全部通过”标记和“冒烟自检通过，正常退出”主入口标记。Research 的故意 91 不在本矩阵内，也不会被接受。
- wrapper 冻结 native/TS/配置/lockfile/工具、固定 runtime、初始 `out` 与实际 Node/Electron/helper；每步及最终复核源码和 runtime。每个源码或工具文件最多 8 MiB，制品快照累计 32 MiB，私有日志累计 8 MiB，整轮采样原件累计 256 MiB/4096 项/深度 16。
- production 始终保留准备前的制品基线；dev 在应用退出后、读回前冻结制品，并由读回核对真实 hook 清单。读回和最终收口均比较原基线，不能以读回后的新快照追认漂移。三个真实进程回调使用独立变量名，避免覆盖 PowerShell 的只读 PID。

每个 Variant 的工作预算各为 600 秒，覆盖绑定、准备或构建、启动、读回、所有回执和最终 close。应用启动从原余额保留 30 秒供读回与收口；production prepare Node 与 readback Node 各最多 10 秒且都从这 600 秒扣除。整轮另有累计最多 30 秒只计入已超时原 Job 的实际归零，不能据此宣称产品正常退出。

所有原件保留在 gitignored 的 `log/stage7-e2/default-smoke-<Variant>-<UUID>/`。`result.json`、`completion.json` 和进程退出 0 三者必须一致，且只证明本次固定矩阵。SMOKE 内部条件导致的既有 `NOT RUN` 保持原语义。

## 使用

先由主协调者冻结无并行写入的候选。dev 轮自行经固定 CLI 构建；production 轮须先完成就近普通构建：

```powershell
pwsh -NoProfile -File tools/data-qualification/default-smoke/run.ps1 -Variant dev
npm run build
pwsh -NoProfile -File tools/data-qualification/default-smoke/run.ps1 -Variant production
```

实际 Electron、build、native Job 和大 I/O 只在独立 Reviewer 准入后执行；普通源码检查可运行本目录 Vitest、typecheck、lint 与 format check。

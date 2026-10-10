# PageReader 原 Promise 退出诊断

固定一轮，最多四场景。使用当前 Electron 43.7.7、新建独立 app/profile 与 127.0.0.1 短页面，不加载产品 main、Store、Provider 或用户数据。源码/制品/EXE 摘要在运行前后复核，attempt 文件排他创建，旧失败不重跑。

1. 页面完成加载，实际 PageReader 及其原 execute Promise 正常结算控制。
2. HTTP 响应保持、尚未注入时调用实际 PageReader，然后销毁 webContents。只加 console 注入标记；原 execute Promise 原样返回。
3. 已注入且返回诊断专用永挂 renderer Promise 后导航。
4. 已注入且返回诊断专用永挂 renderer Promise 后销毁。

后两项用于区分 Electron API 注入后的机制，不冒充产品同步 snapshot 模板。每项前提必须先被观测，否则首意外失败立即停止。500ms 观察窗到期只记 pending/fulfilled/rejected；仅原 Promise 自身 then 回调可写 settled，不用 race 或 destroy 冒充结算。四项结束时仍 pending 的原件保留，随后正常退出资格 main，最终以 held Job 归零证明本轮进程退出。

main watchdog 15s；外层从既有 JobProcess 固定派生，只增加 native ActiveProcessLimit=8（并实际读回），保留 JOB_LIST 原子加入和 held root handle，工作20s + 最多10s实际退出。全证据目录 ≤8MiB；不删失败输出。总过程若超预算、未知退出或控制失败，不授本轮成功。

静态构建：`node tools/data-qualification/page-reader-exit/build.ts`。一次执行：`pwsh -NoProfile -File tools/data-qualification/page-reader-exit/run.ps1 -BuildId <固定构建ID>`。不允许自动换批重试，不替代默认冒烟或产品修复验收。

## 独立快照取消复验

构建参数 `snapshot-cancel` 选择独立入口 `snapshot-cancel.ts`，保留上面的原机制诊断入口不变。沿用同一固定四场景/20秒工作/10秒退出/8进程/8MiB预算，不做性能判定。

四场景固定为正常PageReader、保持HTTP响应时取消读者、保持HTTP响应时销毁页面、释放保持响应后正常采集。前两取消分支须原reader自己完成且native调用数为零，signal及WebContents自有监听释放；取消读者不能停止或销毁页面，原加载随后完成也不能迟到注入。正常与释放控制须原native Promise自己完成、非降级且内容正确。所有本轮原Promise都须实际结算，最后held Job归零才授本轮功能通过。首意外失败立即停止，旧失败原件保留；不代替真实主服务图、默认冒烟、打包或E2整体验收。

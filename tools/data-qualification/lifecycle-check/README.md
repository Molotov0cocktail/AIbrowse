# E3 限定真实故障与 E4 诊断 IPC 补证

工具构建普通产品 main/preload/renderer/utility/guardian，bootstrap 仅隔离合成 profile、固定页面与主进程故障动作。
不加入产品测试开关，不替换错误或恢复处理；所有返回值来自真实生产 IPC。

```powershell
node --experimental-strip-types tools/data-qualification/lifecycle-check/build.ts
pwsh -NoProfile -File tools/data-qualification/lifecycle-check/run.ps1 -ScopeId <构建返回值>
```

固定网页崩溃/仅该 Tab 重载、主 UI 两次实际崩溃与重建、诊断隐私投影、main未捕获异常exit1及冷重开。
第三次恢复预算纯检查已有独审；发行原生交互必须另有证据，不能由本工具授 PASS。
每场120秒，原生24/commit/RSS门保持；main-fault只接受记录的同PID、注入后10秒内exit1，所有场实际Job0。
全表oracle只打开退出后的新副本，三代既有reconciliation审计完整继承，任何其它业务变化拒绝。
源码/制品绑定、命令、Job结果、失败和原件均保留于新UUID scope。首次失败停止，不复用scope。

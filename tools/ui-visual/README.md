# UI 可视验收工具

该工具启动当前工程构建的 `out/main/index.js`，使用真实 Electron 主窗口、preload 与
`WebContentsView` 完成深浅主题、三种视口和主要空态的截图/交互检查。它不读取 `output/`，
不使用真实 profile，不启用 smoke 模式，也不会调用 Provider。

每次运行创建 `log/ui-refresh-20261012/<唯一运行>/`，其中 `profile/` 与 `session/` 是该轮专属
Electron 数据目录，`captures/` 保存 PNG 及同名 JSON 检查，`result.json` 保存总结果。失败时保留
已生成的原件，并尽力追加 `failure-original.png` 或 `timeout-original.png`。工程 main 的 logger 按产品
契约写仓库 `log/`；工具按启动前字节偏移把本轮尾部另存为运行目录下的 `app-log-tail.log`，不删除或
改写共享日志。

在仓库根目录运行：

```powershell
pwsh -NoProfile -File tools/ui-visual/run.ps1 -Build
```

已有可信的当前构建时可省略 `-Build`。脚本拒绝覆盖已有运行目录；自定义目录也必须位于
`log/ui-refresh-20261012/` 的唯一子目录内。

检查矩阵覆盖 1280×800、1100×760、800×600 与 light/dark，共 78 个场景。每组包含浏览器基线、更多工具、
按需快照调试、AI 设置、信源、研究、诊断、本地数据展开态、Watch 概览、规则空态、创建向导和健康视图，
并检查文档整体无水平/垂直溢出、三个侧栏
精确 380px、主题原生 select 契约、localStorage 重载保持、正文对比度样本，以及浏览器场景中
真实 `WebContentsView` bounds 与 renderer 报告的 `.content-area` 一致。

默认浏览器还要求 chrome ≤86 CSS px、地址栏宽度 ≥180px、快照调试无默认占位、网页到底边，
并实际验证 Watch 内新建和切换标签均返回浏览器。启动与结束核对非测试产品源码和构建产物摘要；
几何证据在截图前先写入，截图失败时仍保留该场布局事实。Research 返回浏览器的组件接线由独立组件测试覆盖，
此工具不宣称运行了真实 Research Provider。

每组还会挂载一个带明确 `data-ui-visual-synthetic="long-confirm"` 标记的长 L2 确认 CSS 压力夹具。
该夹具只复用产品 class，不替换 React `ConfirmDialog`，不连接确认 IPC，也不会点击批准；截图前暂时隐藏
`WebContentsView`，检查拒绝按钮默认焦点、对话框视口边界、滚动能力及两个操作按钮可见性，随后移除夹具并
恢复浏览器视图。

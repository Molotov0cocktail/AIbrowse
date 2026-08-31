# D9 — Watch 工作区、IPC/bridge、通知隐私与安全导出

## 目标

交付顶层 Watch 工作区及 Sources/浏览器快捷入口，接入严格 IPC/bridge、应用内通知、条件式 Windows
Notification Sink、未读/删除、健康/手动运行、CSV/Markdown 安全导出。

## 范围与非目标

- **做**：Overview/Rules/Events/Digests/Health；创建预览确认；paused/muted 区分；Evidence old/new 下钻；
  exact IPC validators/audit/subscription；通知隐私/去重/identity gate；安全 dialog 导出。
- **不做**：托盘/后台服务；开发态冒充 Windows production；HTML 渲染；编辑 Event 事实；导出 raw body/DB/path。

## 涉及模块和输入文档

- renderer watch、preload bridge、main IPC/service/notification/export；既有 Sources/Browser 入口最小接线。
- 输入：detailed §12；threat-model WT-17、WRT-15；Sixth §5/§7/§9。

## 预计修改文件

- 新增 `src/renderer/src/watch/`；修改 renderer 导航/Source详情/浏览器工具栏的最小入口。
- 修改 preload 精确白名单；新增 main Watch IPC/Notification/Export 模块和测试。
- 不使用 `dangerouslySetInnerHTML`；不引入 UI/Markdown/notification 依赖。

## 实施步骤（红→绿）

1. 红：IPC manifest/validator/未知键、NotificationPolicy、CSV/Markdown、组件状态/交互测试。
2. 绿：查询/写 IPC → 工作区只读视图 → 创建/运行/状态动作 → notification → export。
3. Electron 真实 DOM：old/new Evidence、主文档/退出提示、health、muted、未读、删除 tombstone。
4. Windows identity probe：未打包/失败必须 feature unavailable；若已打包条件具备再做真实通知观察。
5. 隐私 canary 跨 IPC/DOM/通知/导出/日志扫描。

## 验收标准与测试

- detailed §12 IPC 方法精确白名单、payload/output 上限、写操作恰一条脱敏审计、listener 幂等清理。
- Session 通知默认无标题/摘录；详情逐 Rule opt-in；点击只内部 UUID。
- CSV 公式注入、Markdown raw HTML/URL/Evidence tombstone 防线全绿；renderer 无路径。
- 应用内通知必达；Windows 不可用时诚实降级；全量和 dev/production UI 冒烟全绿。

## 已交付事实补记（schema v5）

- D9 为用户配置写操作的 `expectedVersion` CAS 与逐 Rule 通知详情 opt-in 交付 watch.db schema v5；v5
  只向 `watch_rules` 追加 `rule_version INTEGER NOT NULL DEFAULT 1 CHECK(rule_version >= 1)` 与
  `notification_show_details INTEGER NOT NULL DEFAULT 0 CHECK(notification_show_details IN (0,1))`，未改写
  v1–v4 migration statement bytes。
- 既有 v4 Rule 升级后两列分别默认回填 `1/0`；用户配置写 CAS 成功才递增 `rule_version`，runtime
  bookkeeping 不递增；详情默认关闭，只有用户逐 Rule 明确 opt-in 才置为1。
- D9 已有真实 `node:sqlite` oracle 覆盖 v4→v5 两条 statement 的逐点失败完整回滚、默认回填、重开与
  `future=6` fail-closed；D9 产品候选已经新的独立安全/隐私 Reviewer `PASS`。本补记不改写 D9 历史目标，
  也不等同于 D10-P0 的正式契约复审结论。

## 完成定义

红→绿、UI/隐私/导出证据、Reviewer PASS、候选提交；系统通知 NOT RUN 理由如实记录。

## 依赖与停止条件

- 依赖 D4–D8；D10 依赖本任务。
- 需要暴露 ipcRenderer/SQL/Cookie/文件路径、raw HTML、打包身份不存在却要求 PASS 或改变 Browser 安全设置时停止 REPLAN。

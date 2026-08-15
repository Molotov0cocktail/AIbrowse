# C8 — Research UI/IPC/bridge：侧栏控制/进度、大结果画布、证据下钻、表格交互与 CSV 导出

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §11；安全契约
> `doc/stage5/threat-model.md` §3.5/§3.7（FT-13/FT-15/FT-16）；决策
> D10/D11（proposal §10）。

## 目标

落地 Research 用户面：侧栏 ResearchPanel（创建/启动/停止/进度/历史，380px
同模式）+ 主窗口内独立大结果画布（viewMode 切换，不新开 BrowserWindow）+
Evidence 下钻 + 表格排序/筛选/复制 + CSV 导出（主进程 dialog 安全通道 +
公式注入防护）+ IPC/bridge 白名单——Chat 与 Research 模式区分清楚。

## 范围与非目标

- **做**：research:* 7 个 invoke 通道 + 2 事件通道（§11 全表，handle()
  sender+主帧校验 + 参数白名单）；preload bridge 白名单 + eventRelay；
  research-ipc 适配器（零 Electron import；状态门控；export-csv 经主进程
  dialog.showSaveDialog——renderer 零路径参数）；App viewMode
  'browser'|'research-result'（浏览器内容区与结果画布互斥切换，不影响
  Tab 状态）；ResearchPanel（侧栏）；ResultView 接线（C7 组件）；表格
  排序/筛选/复制纯函数 + UI；csv-serializer（公式注入/CRLF/引号/BOM）+
  导出审计；冒烟 8.19。
- **不做**：修改 380px 侧栏布局契约之外的行为（面板定宽/收起模式不变）；
  Timeline/Chart；多窗口；真实 Provider（C9）。

## 涉及模块和输入文档

- 新增 `src/main/research/research-ipc.ts` + 测试；
  `src/renderer/src/research/`（ResearchPanel/useResearch/csv-serializer/
  table-utils + 测试）。
- 修改：`src/shared/types/ipc.ts`（通道常量追加）、`src/preload/index.ts`
  （bridge 追加）、`src/main/index.ts`（handler 装配追加）、
  `src/renderer/src/App.tsx`（viewMode）、`src/main/smoke.ts`（8.19 新
  场景入口）。

## 依赖

C5（Service/事件）、C6（数据模型）、C7（Renderer 组件）。

## 红→绿步骤

1. **红**：先写测试（模块缺失红）——research-ipc 载荷白名单矩阵（未知
   字段/超长/非法 id/状态门控 running 不可 delete/export 无 renderer
   路径参数/审计恰好一条脱敏）；csv-serializer（公式注入 =,+,-,@ 前缀
   转义/CRLF 引号/UTF-8 BOM/空表/超长单元格截断）；table-utils（排序
   全序/筛选/复制文本生成）；useResearch reducer（taskId 键控/跨任务
   事件串线忽略/进度节流收敛）。
2. **绿**：实现各模块 + 接线；逐用例转绿。
3. **冒烟 8.19**（dev+生产双场景）：真实 DOM——侧栏创建/启动/进度渐进/
   停止；结果画布 Table 排序/筛选/复制、Cards/Ranking 渲染、Evidence
   下钻（点击结论看来源）；敌对 Markdown 文本纯文本渲染零 DOM 注入；
   viewMode 切换 Tab 状态不丢；CSV 导出触发（SMOKE_MODE 注入 dialog
   路径桩——不触碰真实文件系统对话框，生产走 dialog）。
4. 全量回归 + 红线扫描（renderer 零 dangerouslySetInnerHTML；导出仅
   主进程通道；审计/日志脱敏字节扫描）。

## 验收标准

- §11 全通道落地 + 8.19 双场景通过；
- 380px 侧栏仅控制/进度；大结果画布承载表格（排序/筛选/来源详情/复制）；
- CSV 导出内容与 UI 数据一致（§8 测试重点断言）；公式注入防护字节级
  断言；导出不开放任意文件系统工具（grep）。

## 具体验证命令和期望结果

- `npm test -- --maxWorkers=1` → 全量绿；
- `npm run typecheck` / `npm run lint` / `npm run format:check` /
  `npm run build` / `git diff --check` → 全部退出码 0；
- dev + 生产冒烟默认矩阵（含 8.19）退出码 0。

## 完成定义

红→绿证据回填 + 8.19 通过 + 全量验证全绿 + diff 终检 + progress.md 更新 + 逻辑提交（feat: C8 …）+ 双远程推送。

## 风险与停止条件

- 大结果画布与浏览器内容区布局冲突（bounds/WebContentsView 覆盖）→
  停止并报告（viewMode 架构为决策 D10 红线；不得退化为 380px 侧栏塞
  表格）；
- dialog.showSaveDialog 在测试环境不可达 → 以 SMOKE_MODE 注入桩验证
  通道逻辑，真实 dialog 行为留 C9 手工/真实验收（如实登记不冒充）。

## 提交边界

逻辑提交；不夹带 C9 红队/验收代码。

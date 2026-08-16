# C8 — Research UI/IPC/bridge：侧栏控制/进度、大结果画布、证据下钻、表格交互与 CSV 导出

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §11/§13（已按
> 决议 #156–#163 校准）；安全契约 `doc/stage5/threat-model.md`
> §3.5/§3.6/§3.7（FT-13/FT-15/FT-16）；决策 D10/D11（proposal §10）。
> **实施前契约裁决 #156–#163 已完成（2026-08-17，C8 闭环）**——本文档已
> 按裁决同步：research:\* 为**八个 invoke + 两事件**（原任务文档「7 个
> invoke」漂移，以八个为准）；export-csv payload 冻结为 {taskId,
> tableBlockIndex, view:{sort,filter}}（导出当前 UI 视图、主进程重投影）；
> ResearchService 安全结果视图 + 事件出口；BrowserControllerImpl
> contentVisible（不进 AI 接口）+ ui:browser-content-visible 受控通道；
> Evidence 下钻安全导航（tabs.create + 白名单）；TableView 纯函数 +
> spreadsheet-cell 防护；CSV 字节契约 + MAX_CSV_EXPORT_BYTES +
> ExportCsvResult 闭合错误联合；sidePanel 三态互斥与 useResearch
> 收敛契约。

## 目标

落地 Research 用户面：侧栏 ResearchPanel（创建/启动/停止/进度/历史，380px
同模式）+ 主窗口内独立大结果画布（viewMode 切换 + WebContentsView 可见性
联动，不新开 BrowserWindow）+ Evidence 下钻 + 表格排序/筛选/复制 + CSV
导出（主进程 dialog 安全通道 + 公式注入防护 + 当前 UI 视图重投影）+
IPC/bridge 白名单——Chat 与 Research 模式区分清楚。

## 范围与非目标

- **做**：research:* **八个** invoke 通道 + 2 事件通道（§11 全表，handle()
  sender+主帧校验 + 参数严格白名单 fail-closed）；preload bridge 白名单 +
  eventRelay；research-ipc 适配器（零 Electron import；状态门控；
  export-csv 经注入式窄端口调用 dialog.showSaveDialog + 写入——renderer
  零路径参数，扩展名大小写不敏感精确 .csv）；App viewMode
  'browser'|'research-result' + BrowserControllerImpl contentVisible/
  setContentVisible（受信 UI 专用，不进 AI 接口）+ ui:browser-content-visible
  受控 send 通道；ResearchPanel（侧栏，sidePanel 三态互斥）；ResultView
  接线（C7 组件 + block/item/position sourceRefs 入口 + Evidence 下钻 +
  安全导航回调）；表格排序/筛选/复制纯函数 + UI（原始字符串二元比较/
  稳定排序/无正则筛选/TSV+CRLF 复制/spreadsheet-cell 防护）；csv-serializer
  （公式注入/CRLF/引号/BOM/MAX_CSV_EXPORT_BYTES）+ 导出审计（当前 UI
  视图重投影）；冒烟 8.19-B。
- **不做**：修改 380px 侧栏布局契约之外的行为（面板定宽/收起模式不变）；
  大表格/Evidence drawer 塞入侧栏（决策 D10 红线）；Timeline/Chart；
  多窗口；真实 Provider（C9）。

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

1. **红**：先写测试（模块缺失红）——research-ipc 八通道载荷白名单矩阵
   （未知字段/原型链键/超长/非法 UUID/NaN·Infinity·非整数/分页边界
   page≥1·pageSize 1..20/export table index·view state 无 path·rows·
   content 通道/service=null·unavailable/状态门控 running 不可 delete·
   starting slot 预占不可 delete/每次写尝试恰好一条脱敏审计·取消也恰好
   一条/审计零 goal·URL·path·title·excerpt·cell）；csv-serializer
   （公式注入 =,+,-,@ 前缀转义——quoting 前执行/CRLF 引号转义/BOM/空表/
   超长截断/MAX_CSV_EXPORT_BYTES 边界 ±1）；table-utils（原始字符串
   二元比较排序/相等稳定/筛选边界/无正则/输入零修改/TSV 复制文本）；
   useResearch reducer（taskId 键控/跨任务串线忽略/事件早于 invoke 返回/
   进度节流收敛/退订零 setState）；ResearchService 事件出口与结果视图；
   BrowserController contentVisible；ResultView sourceRefs 入口与嵌套
   链接透传。
2. **绿**：实现各模块 + 接线；逐用例转绿。
3. **冒烟 8.19-B**（dev+生产双场景）：真实 DOM——侧栏创建/启动/
   planning→reading→verifying→synthesizing 渐进进度/stop→cancelled/
   FakeProvider+生产 factory 完成 completed；大结果画布（viewMode 切换
   WebContentsView 实际不可见）Table 排序/筛选/复制、Cards/Ranking/
   Conflict/Uncertain 渲染、Evidence 下钻（点击结论看来源）；safe URL
   新建 Tab 后返回 browser 模式；敌对 Markdown/HTML/URL 零 DOM 注入；
   viewMode 往返前后用户 Tab id·url·title·active 恒等；CSV 注入 dialog
   桩写系统 TEMP 受控文件——读取字节断言（BOM/CRLF/公式防护/当前视图
   一致性/Evidence 摘录零出现）后 finally 精确清理（不弹真实对话框）；
   Research unavailable 不影响 Browser/Sources/Chat。
4. 全量回归 + 红线扫描（renderer 零 dangerouslySetInnerHTML；导出仅
   主进程通道；审计/日志脱敏字节扫描）。

## 验收标准

- §11 全通道（八 invoke + 两事件 + ui:browser-content-visible）落地 +
  8.19-B 双场景通过；
- 380px 侧栏仅控制/进度；大结果画布承载表格（排序/筛选/来源详情/复制）
  与 Evidence drawer（决策 D10 红线）；
- CSV 导出内容与 UI 当前视图一致（主进程按同一纯函数重投影——§8 测试
  重点断言）；公式注入防护字节级断言；导出不开放任意文件系统工具（grep）；
- BrowserControllerImpl contentVisible 不进入 AI BrowserController 接口
  （grep 断言）；Progress/Done 事件零敏感内容（FT-16）。

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

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

## 红→绿证据

- **红态**（2026-08-17，模块缺失/旧结构）：8 个测试文件红态——research-ipc/
  research-service-events/view-visibility/table-utils/csv-serializer/
  use-research/smoke-cleanup 模块缺失 + ResultView C8 新用例（sourceRefs
  入口/嵌套链接透传）在旧实现下失败——**红态 8 files failed / 14 failed |
  13 passed**（vitest 输出实证；既有 ResultView 13 用例零削弱）。
- **TEMP 遗留根因与修复（决议 #156 前置，先红测后修）**：2026-08-16 23:30
  生产冒烟机器证据（日志 EPERM 实证）：8.19-A 场景失败路径（assert 抛错）
  跳 finally 时 research.db 句柄未关闭（service.shutdown 只在正常路径调用）
  → rmSync 在 Windows 上 EPERM → 系统 TEMP 遗留
  `aibrowse-research-factory-smoke-t0DXYo\research.db`（90112 字节，扫描零
  敏感形态后按既有流程精确删除）。红测：`smoke-cleanup.test.ts`（模块缺失
  红 + 语义护栏「句柄未关闭删除必须失败」+ 关闭后删除成功零残留）→ 绿
  **6/6**；修复 = `src/main/smoke-cleanup.ts`（零 Electron import、
  EPERM/EBUSY 有限重试）+ 8.19-A finally 先 shutdown/closeDb 再
  removeSmokeDirWithRetry；**同日发现同类缺陷**（失败路径单次 rmSync 静默
  放弃 EPERM → 每次失败运行残留 `aibrowse-smoke-research-<pid>`）——
  index.ts 失败路径先 researchService.shutdown() 再 removeSmokeDirWithRetry
  - RESEARCH 互斥分支补齐 ai/sources 目录清理——**终检 TEMP/根目录日志/
    Electron 进程零残留**（互斥失败路径实测零残留）。
- **转绿**：实现 research-ipc（八通道严格白名单 fail-closed/审计恰好一条/
  CSV 重投影）、research-service（事件出口 getResearchResultView/deleteTask
  预占互斥）、view-visibility（contentVisible 纯函数）、table-utils/
  csv-serializer（shared 纯模块）、use-research（reducer+hook 竞态守卫）、
  ResultView 扩展（sourceRefs/Evidence drawer/嵌套链接透传）、
  BrowserControllerImpl contentVisible + ui:browser-content-visible、
  preload/index 装配、ResearchPanel/TableView/App 接线后——C8 聚焦
  **99/99**（8 文件）；全量 **2054/2054**（基线 1964 + 90 新增；既有用例
  零删除零削弱）。
- **冒烟 8.19-B**（默认矩阵自动包含；dev+生产双场景退出码 0）：真实 DOM
  驱动全链路——侧栏创建/启动/planning→reading→verifying→synthesizing
  渐进（脚本轮次 delayMs 防 React 批处理合并）/stop→cancelled（reducer
  start-ok 合并分支补全 task——stop 按钮状态修复）/FakeProvider + SMOKE
  service 完成 completed（双候选双 canonicalKey——conflict 装配 ≥2 要求；
  确定性 createId/createCaptureId 注入）/大结果画布（viewMode 切换
  WebContentsView 不可见机器证据 = 全部 Tab webContents 零聚焦；隐藏期间
  activate 不重新显示不 focus）/Table 排序（asc/desc 二元序断言）·筛选
  （2 行/4 行）·复制（clipboard-sanitized-write SMOKE 权限 + 固定中文
  诊断——Electron 后台窗口无 OS 焦点时失败为合法产品行为）/Cards·
  Ranking·Conflict·Uncertain 渲染/Evidence 下钻（candidateId → drawer
  摘录）/safe URL 新建 Tab 后返回 browser（画布消失 + 新 Tab）/敌对
  Markdown 零 DOM 注入/viewMode 往返前后用户 Tab id·url·title·active 恒等/
  CSV 注入 dialog 桩写系统 TEMP 真实字节断言（BOM/CRLF/公式防护
  `'=cmd`/当前视图一致性 4 行首行乙/Evidence 摘录·URL·其他块零出现）后
  finally 精确清理（零残留）。8.13 B-06 场景瞬态失败 3 次（历史先例
  C7 记载 14:47/16:55/19:37 同款）——复跑均通过，如实登记。
- **AIBROWSE_RESEARCH_SMOKE=set|check**（生产产物）退出码 0/0（set
  completed + 遗留 running；check 读回 + interrupted 标记）——零回归。
- **红线扫描台账**：migration v1 零改写；renderer/preload 零 SQL 零
  Electron/fs/path import；research-ipc 零 Repository/SQL/Electron import
  （只 import shared 类型与 service）；零 dangerouslySetInnerHTML 实际
  使用、零 `<a href>` 导航（ResultView/TableView 均 span/button）；零
  shell/child_process/eval；CSV renderer 零路径/任意数据通道（export-csv
  payload 仅 {taskId, tableBlockIndex, view}——grep 断言）；package.json/
  lockfile 零 diff；工具注册表仍 17、AgentLoop 12/420s 零 diff；
  BrowserController 接口零 contentVisible（仅实现类新增）；Key/base URL/
  认证头零进入新代码；真实 Provider 调用 **0 次**（8.19-B 无真实 Provider
  产品链路——FakeProvider 确定性脚本，不冒充真实证据；决议 #117 长期授权
  不等于强制无关调用）。
- 验证命令：`npm test -- --maxWorkers=1` **2054/2054** 绿；typecheck/
  lint/format:check/build/diff-check 绿；dev + 生产默认冒烟（含 8.19-B）
  退出码 0；set/check 双进程退出码 0/0；终检 TEMP/根目录日志/Electron
  进程零残留。

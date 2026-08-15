# B5 — Sources UI + 手工管理 + 当前页快速添加 + IPC/bridge

> 第四阶段任务文档。契约源 `doc/stage4/detailed-design.md`（§6 手工操作/§8.2
> 分享模式 UI 要求/§10.3 恢复态诊断/§11 本地明文如实说明）。

## 目标

落地 Sources UI：AI 侧栏新增 Sources 面板（与 AiPanel 并列切换）、分组浏览/搜索/
详情（备注/标签/优先级/信任与 provenance 展示/分享模式三态说明）、手工添加与
编辑、当前网页快速添加、禁用/恢复、手工 Undo、永久删除二次确认、恢复态中文
诊断、IPC/bridge 通道扩展（全部 sender+主帧校验、参数验证、事件只发主窗口）。

## 前置依赖

- B2（SourceService 手工操作路径）、B3（search/list 检索）；UI 冒烟驱动需 B4
  完成后统一回归（B-05 场景可先在本任务内以 UI 直连 Service 形态落地）。

## 范围

- shared/types/ipc.ts：sources 通道常量与 payload 类型（sources:list/get/add/
  update/disable/restore/hard-delete/undo/undoable/search/quick-add + 事件
  sources:changed）；
- main/index.ts：全部 handler 复用既有 handle() sender+主帧校验包装，逐参数
  验证安全返回；
- preload：bridge 白名单扩展（eventRelay 模式，原始 ipcRenderer 不暴露）；
- renderer/src/ai/sources/：面板组件 + 纯函数（列表状态/筛选/格式化——
  可单测部分拆纯函数）；note 纯文本渲染（无 dangerouslySetInnerHTML/Markdown）；
  provenance 展示（「官方来源（用户标定）/官方来源（AI 推断·未核验）」）；
  快速添加按钮（当前活动 Tab URL 经主进程获取——URL 与名称由主进程生成
  「可能相关」提示，不自动覆盖同 origin）；
- 手工永久删除：UI 二次确认（不可 Undo 的明确文案）+ hardDeleteManual；
- 恢复态 UI：只读恢复态中文诊断（检测结果/原库位置/备份位置/建议动作）；
- 本地明文如实说明（「备注与 URL 以明文保存在本机」）；
- 冒烟 B-05（快速添加 → 列表 → 分享模式/备注修改 → Undo → 永久删除二次确认）。

## 非目标

- AI 端到端管理（B6）；usage 展示（B7）；恢复操作实现（仅诊断展示，恢复流程
  本身 B7）；图表/富文本；面板拖拽调宽（沿用 380px 契约）。

## 涉及模块

`src/shared/types/ipc.ts`、`src/main/index.ts`、`src/preload/index.ts`、
`src/shared/types/app.ts`（bridge 类型）、`src/renderer/src/ai/sources/`（新增）、
`src/main/smoke.ts`（B-05）；纯函数单测 + UI 冒烟。

## 红态测试（先红后绿）

- IPC payload 校验矩阵（非法 id/页码/长度超限安全返回）；
- bridge 白名单形状（原始 ipcRenderer 不暴露回归）；
- 面板纯函数（列表状态/筛选/格式化/provenance 文案映射）；
- 冒烟 B-05 端到端：快速添加（默认 metadata）→ 列表出现 → 改分享模式与备注
  → 手工 Undo 生效 → 永久删除二次确认后消失且无 Undo 入口 → 重启读回。

## 实现步骤

1. IPC 通道常量与 payload 类型（红→绿）；
2. main handler + preload bridge（红→绿）；
3. 面板纯函数与组件（红→绿）；
4. 快速添加与删除/恢复态/明文说明（红→绿）；
5. 冒烟 B-05；
6. 全量验证 + 文档同步。

## 验收标准

- detailed-design §6 手工操作/§8.2 三态 UI/§10.3 诊断/§11 明文说明全部落地；
- 手工操作与 Agent 共用 SourceService（同一事务/审计/journal 语义，单测证据）；
- 快速添加不自动覆盖同 origin 既有条目（「可能相关」提示）；
- 恢复态下 UI 不崩溃且写入口禁用（中文诊断可见）。

## 全量验证

`npm test` · `npm run typecheck` · `npm run lint` · `npm run format:check` ·
`npm run build` · dev+生产双场景冒烟（含 B-05 与既有 UI 矩阵回归）· diff 终检 ·
敏感信息扫描（note 不落 DOM 之外通道）。

## 提交要求

一个或少量逻辑 commit；提交信息 `<type>: <中文描述>`；不提交临时数据/日志。

## 完成定义

验收标准全绿 + progress 任务表 B5 ✅ + 双远程推送；契约偏差先校准文档与测试。

## 风险与停止条件

- IPC/panel 与既有 bridge 契约冲突 → 回设计流程校准，不得绕过 sender 校验或
  暴露原始 ipcRenderer；
- UI 复杂度过高 → 最小化（无拖拽/无富文本/无图表），不为美观放宽安全渲染
  规则（note 恒纯文本）。

## 实施证据（2026-08-15 回填）

### 步骤 0 独立核对

HEAD `532ea78` = Gitee/GitHub 双远程 HEAD（ls-remote 实测三方一致）、工作区干净；
基线 test 1071/1071·typecheck·lint·format:check 独立复跑全绿；B1–B4 代码/接口/测试
在位（SourceService 完整手工路径 + 令牌签发、Repository 唯一 SQL 点、source-tools
四工具、ToolExecutor confirmSummary 钩子、主进程装配与冒烟 8.7/8.9/8.10/B-02）；
B5 零实现（无 source-ipc.ts、无 renderer/ai/sources/、无 sources:* 通道）。
Fourth_stage.md 头部「B4–B9 待开始/下一任务 B4」陈旧属实 → 校准为 B1–B4 完成、
B5 待开始（未改写历史记录）。

### 实施前契约裁决（决议 #68–#78，按任务授权落 detailed-design §15）

面板互斥切换/通道白名单与 audience 硬编码/有界 listGroups/quick-add 契约/两阶段
硬删除/三态 UI 状态与安全路径标签/provenance 与 aiNote 只读/独立 manual 审计/
UI 异步序号与冲突刷新纪律/纯文本渲染——十一项全部先落契约与测试再实现。

### 红→绿证据

- **红态（先写测试）**：4 files failed / 15 failed / 76 passed——source-ipc.test.ts
  与 sources-display.test.ts 模块缺失；source-service.test.ts 与
  source-repository.test.ts 的 B5 扩展用例在旧结构下真实失败（listGroups/
  quickAddPage/findRelatedByOrigin 不存在，TypeError not a function）；既有
  1071 用例零删除零削弱。
- **实现后全量 1125/1125（+54）**：source-ipc 30（载荷校验矩阵/audience 硬编码
  user（blocked 可见）/状态门控三态读写拒绝与零变化/changed 仅成功后恰好一次/
  每次写尝试恰好一条脱敏审计（note/URL/敏感 query/token/路径零出现）/两阶段硬
  删除取消・错绑定不消费・过期・重放・成功无 Undo/quick-add 无活动页・非 http・
  精确重复・related ≤5 有界・绝不覆盖/getter 惰性解析回归）、sources-display 9
  （provenance 两形态/分享模式三态/错误码 10 码/状态诊断仅安全标签无盘符路径/
  quick-add 文案）、source-service B5 +10（listGroups 边界・确定性排序・幂等组/
  quickAddPage 矩阵）、source-repository B5 +5（软删过滤・排序分页・前缀转义只
  作数据・有界 LIMIT・排除精确键）。
- **冒烟期真实实现缺陷 4 处（冒烟抓出后修复并固化）**：① Sources IPC 适配器在
  handler 注册期捕获 sourceService=null（registerIpcHandlers 早于
  createBrowserWindow 装配）→ 适配器 service 改 getter 惰性解析（单测回归固化）；
  ② stateOverride 冒烟注入点同类构造期捕获 null → index.ts 改调用时解引用；
  ③ 面板 hook 共享序号守卫把同批 refreshAll 内先发出的响应全部误判迟到（分组/
  状态/列表恒空）→ 改每种加载独立计数；④ quick-add 成功后自动打开详情遮挡列表
  （快速添加结果与「可能相关」提示不可见）→ 成功停留列表视图。冒烟断言自身缺陷
  5 处（受控页服务器每进程随机端口致跨进程按 URL 读回失败 → 改按名称；分组选项
  经直接服务种子写入无 changed 事件 → 面板先刷新；Undo 后详情异步重读竞态 →
  等表单重挂载后再操作；B-05 结束未恢复 AI 面板 → 矩阵 4 前置被破坏 → 记录并
  恢复进入前面板状态；双进程门控生产服务指向 pid 专属目录绕开共享 userData →
  门控模式改指 userData/sources）。
- **冒烟**：8.11 B-05 Sources UI 端到端矩阵自动包含于默认矩阵（dev+生产双场景
  退出码 0）——真实 DOM → preload → IPC → SourceService 全链路：明文说明/快速
  添加（默认 metadata + 精确重复 + 可能相关 ≤5 + 非 http 拒绝）/分组浏览分页
  （22 条组 + 每页 20 + 翻页）/搜索 user 视角 blocked 可见/手工添加表单/详情
  编辑（provenance 用户标定 + 版本恰 +1）/版本冲突提示刷新零静默覆盖/手工
  Undo/禁用・恢复 deleted_at 联动/AI provenance 展示 + aiNote 只读 + 敌手 note
  纯文本零 DOM/两阶段永久删除（取消零删除 + 确认后消失无 Undo + token 零 DOM）/
  恢复态・不可用态中文诊断 + 写入口禁用 + 写入零变化 + 读入口按决议 #39 拒绝/
  面板互斥 + L2 确认框中切换面板不遮断（App 级挂载）。**B-05 双进程门控**
  `AIBROWSE_SOURCES_UI_SMOKE=set|check`（两独立生产进程共用同一系统 TEMP 临时
  userData；与 SESSION_SMOKE/SOURCES_SMOKE 互斥）：set 经真实 DOM 快速添加 +
  编辑（shareMode/备注）持久化 → check 新进程读回一致 → 真实 DOM Undo 生效 →
  两阶段永久删除确认消失且无 Undo——两进程退出码 0，临时目录已清理，未触碰真实
  用户数据。
- **红线与敏感扫描**：新代码零 any/@ts-ignore；渲染层零 dangerouslySetInnerHTML/
  Markdown 库；SQL 仍仅 Repository/migrations 编译期常量 + 参数绑定；renderer/
  preload 零 SQL；审计/日志零 note 正文・完整 URL/敏感 query・删除 token・数据库
  路径（单测字节扫描 + 冒烟审计切片）；source_sql/source_delete_hard/
  source_export_all 零命中；package/lockfile 零改动；未调用任何付费 Provider。

### 契约文档同步

detailed-design §6（listGroups/quickAddPage 签名）+ §13.1（B5 两测试文件行）+
§13.2（B-05 行扩展）+ §15 决议 #68–#78；threat-model §3.3/§3.6；HLD 模块表；
AGENTS.md §5 速查回填。

# A3 浏览器交互能力：scroll/click/fill/find + elementId 生命周期（可验证闭环）

- **目标**：BrowserController 扩展 clickElement/fillElement/scrollTab；固定模板
  交互注入脚本（click=原生 el.click()；fill=原生 value setter+input/change；
  scroll=window.scrollBy）；快照采集扩展 click 语义元数据（isSubmit/ariaExpanded）；
  find 工具（快照文本确定性匹配）；elementId 执行时刻重新定位与类型复核；
  **click 执行器层白名单复核（allowedKind 派生自权限决策，模型不可见不可写）**。
- **输入文档**：doc/stage3/detailed-design.md §5/§4.2（interaction-tools 行）/
  §7.1（click 允许列表）；doc/stage3/threat-model.md §3.2/§3.3（elementId 生命周期、
  允许列表与 fail-closed）。
- **范围**：interaction-script.ts（IIFE 字符串，参数只进 JSON 字面量，DOM lib
  引用保持 TS 检查）；click 模板按 allowedKind ∈ {nav/expand/toggle/submit} 逐一
  复核 DOM 实时属性（nav：A 标签且 href http/https；expand：[aria-expanded]；
  toggle：INPUT[type=checkbox|radio]；submit：提交类判定）——不符 → 拒绝
  （execution-failed），**执行器层与权限层同一允许列表，L3 敏感动作无执行通道**；
  PageReader 交互编排（executeJavaScript 通道复用 + 前置守卫）；
  BrowserController 扩展接口与实现（参数/状态问题安全返回，不抛异常）；
  snapshot-script/normalize/browser.ts 类型扩展 click 语义元数据
  （buttons 条目 isSubmit + ariaExpanded，布尔形状校验缺失按 false/undefined；
  inputs 条目 type 已有）；interaction-tools 4 个（find 纯函数匹配 + scroll/click/
  fill executor）；冒烟扩展：受控本地页面交互断言（允许列表点击/提交类确认/
  非允许列表拒绝无 DOM 动作/填写/滚动/陈旧 id 失败）。
- **非目标**：**严禁 SearchProvider（A4）、Agent Loop（A5）、UI/IPC 改动（A6）**；
  不实现 page.extract；交互脚本不注册事件/不读 Node API/不访问 preload；
  fill 禁止 password/file（L3，permission-policy 已有判定，本任务执行层同样拒绝）；
  click 非允许列表目标执行层同样拒绝（纵深防御，不依赖权限层判定）。

## 涉及文件

- 新增：`src/main/browser/interaction-script.ts` + `.test.ts`（模板校验，
  node:vm 假 DOM）、`src/main/browser/interaction-normalize.ts` + `.test.ts`
  （交互结果形状校验）、`src/main/ai/tools/interaction-tools.ts` + `.test.ts`、
  `src/main/ai/tools/interaction-semantics.ts` + `.test.ts`（快照语义存储，
  世代绑定）。
- 修改：`src/main/browser/browser-controller.ts`（扩展接口——clickElement/
  fillElement 增 expectedDocumentId 内部参数，决议 #31 世代校验；ElementActionResult
  增 errorCode）、`src/main/browser/page-reader.ts`（documentId 盖章 + 交互编排）、
  `src/main/browser/tab-manager.ts`（导航世代计数）、`src/main/browser/
snapshot-script.ts` + `snapshot-normalize.ts` + `.test.ts`（click 语义元数据）、
  `src/shared/types/browser.ts`（meta.documentId/buttons 语义/交互结果类型）、
  `src/shared/types/agent.ts`（ClickAllowedKind/ElementSemanticsBinding）、
  `src/main/ai/permission/permission-policy.ts` + `.test.ts`（classifyClickTarget
  单一事实源）、`src/main/ai/tools/tool-types.ts`（paramRules/ToolExecutionDerived/
  getElementSemantics 绑定签名/recordSnapshot）、`tool-registry.ts` + `.test.ts`
  （paramRules 校验）、`tool-executor.ts` + `.test.ts`（binding 提取 + derived
  派生）、`browser-tools.ts` + `.test.ts`（read 登记语义）、`src/main/index.ts`
  （交互工具注册 + ConfirmManager 暴露冒烟）、`src/main/smoke.ts`（A3 交互场景
  8.2 + elementId 生命周期探针；8.1 校准为 12 工具）。

## 实施步骤

- [x] 红：交互脚本模板 allowedKind 白名单与拒绝路径用例 / click 语义元数据采集
      与 normalize 用例 / 交互结果形状校验用例
- [x] 实现 interaction-script.ts 三模板（click 含 allowedKind 复核）+ 返回形状校验
      （页面视为敌手）
- [x] 实现 BrowserController 扩展（前置守卫/世代校验/安全返回）与 PageReader 编排
- [x] 实现 click 语义元数据采集与 normalize（既有 46 用例不弱化，新增覆盖）
- [x] 实现 find 纯函数 + scroll/click/fill executor 注册（allowedKind 由权限
      决策派生传入，模型参数不可影响）
- [x] 冒烟：受控本地页面——允许列表点击（链接/展开/复选）执行成功 / 提交类 →
      确认门 / 非允许列表按钮与「立即购买」类按钮 → forbidden 无 DOM 动作 /
      页面动态变化（权限层判定后元素变为按钮）→ 执行器复核拒绝 / 导航后旧
      elementId → stale-element / fill password 拒绝（无 DOM 写入）
- [x] 全量回归 → 提交推送 → 更新 progress.md

## 实施结果（2026-08-14）

**① 两项编码前安全核查**：a) elementId 生命周期真实 DOM 红态探针（先于实现，
冒烟内受控页面）——跨 URL 导航与同 URL 刷新后新文档均重新分配相同 `el-N`
字符串（旧 el-0 与新文档 示例链接 el-0 同串），URL/标题/capturedAt 均不能证明
文档身份——「旧 id 自然失效」论证不成立；b) allowedKind 单一事实源核查——
A2 decide() 仅返回 {level, reason}，无共享分类 → 导出
`classifyClickTarget(semantics) → 'submit'|'nav'|'expand'|'toggle'|null`
（permission-policy 单一事实源），decide 级别映射与执行器 allowedKind 均由该
函数对同一语义 binding 派生，executor/交互脚本不自行分类。

**② 契约校准（决议 #31，elementId 文档世代绑定）**：TabManager 以主框架
did-navigate 提交事件维护每 Tab 导航世代计数（页内导航不递增）；快照
`meta.documentId` 主进程盖章（脚本输出同名字段被忽略）；click/fill 执行前
BrowserController 校验「绑定世代 === 当前世代」→ stale-element 不注入脚本；
模型可见工具 schema 不变（世代为内部参数）。ElementActionResult 增 errorCode
字段（闭合枚举诚实映射）。§5.1/§5.2/§5.3/§7.1/§13.2/§15 + threat-model
§3.2/§3.3/RT-06 已同步。

**③ 红→绿**：先写测试——红态 **9 files failed / 18 failed / 452 passed**
（4 个新测试文件模块缺失 + 5 个既有文件扩展用例失败，既有用例零删除）；
实现后全量 **533/533**（新增 81：interaction-script 28 / interaction-normalize
11 / interaction-semantics 9 / interaction-tools 12 / permission-policy 3 /
snapshot-normalize 5 / tool-registry 4 / tool-executor 8 / browser-tools 1；
既有 452 用例仅机械夹具更新——meta.documentId 必填字段与 fakeBrowser 三方法，
零断言削弱、零删除）。

**④ 实现**：shared 类型（ClickAllowedKind/ElementSemanticsBinding/meta.documentId/
buttons・inputs 语义元数据/ElementActionResult/ScrollActionResult）；snapshot-script
+normalize（isSubmit 判定与交互脚本 submit 复核同源：BUTTON type=submit 或 form
内无显式 type、INPUT type=submit；ariaExpanded true/false 均保留；非法布尔形状
丢弃字段）；interaction-script 固定模板（node:vm 敌手参数逃逸测试——引号/反斜杠/
闭合片段/脚本字符串不能逃逸，参数原样到达；click 四类 allowedKind 实时复核 +
fill 原生 setter+input/change+password・file・disabled・readonly・隐藏拒绝 +
scroll 整数 ±50000）；interaction-normalize 逐字段校验（异常/堆栈/页面原文零穿透）；
BrowserController 扩展 + PageReader 交互编排 + TabManager 世代；ToolExecutor
（binding 提取 + derived 派生 + tabId 解析）；tool-registry paramRules（text
≤200/≤2000、dy 整数范围）；interaction-semantics 存储（read/find 登记、按 Tab
键控、世代随绑定）；interaction-tools 四工具注册（find 多章节确定性匹配/无命中
ok 空结果；click/fill 无派生参数 fail-closed）。

**⑤ 冒烟**：A3 交互场景（8.2）+ elementId 生命周期红态探针——A-12 允许列表
四类点击（含 nav 真实导航落地页）、提交类 deny/approve 确认门、非允许列表/
「立即购买/删除账户」/危险链接 forbidden 零 DOM 动作（页面交互日志断言）、
动态变化执行器复核拒绝、fill 隐私（结果/审计 len=N 零原文 + input/change 事件
真实触发 + password/file/disabled/readonly/隐藏零写入）、scroll 边界与 viewport、
find 多章节与无命中、世代校验（同文档稳定/导航后 stale/刷新后 stale/重新快照
不碰撞/类型复核）、每次调用审计恰好一条——**dev 离线全矩阵 + 生产产物双场景
退出码 0**。既有 8.1 探针校准为注册表 12 工具。

**⑥ 验证与终检**：test 533/533（全量连跑 4 次全绿）· typecheck · lint ·
format:check · build 全绿；红线 grep（无万能工具形态、交互工具零 electron
import、allowedKind/documentId 不出现在模型可见 schema、package 零改动、
SYSTEM_PROMPT/UI/preload/IPC 零改动）；敏感信息扫描与 diff 终检零命中；根目录
杂散日志清理。计时用例抖动观察：期间一次全量运行出现 1 例未捕获具体测试名的
失败（复跑 4 次全量 + fake-provider 单文件 3 次均全绿）——判定为既有 30ms
墙钟断言边缘抖动，按 A2 约定如实记录、不放松阈值。**未调用任何付费 Provider、
未输出/索取 API Key。**

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；单测见 detailed-design §13.1 A3 行；
  红线 grep：diff 无任意 JS 拼接路径（模板编译期固定）、无万能工具。
- **执行器层白名单一致性**：注入脚本的 allowedKind DOM 判定与 permission-policy
  的允许列表判定必须同源一致（单测双表对照 + 冒烟断言非允许目标无任何 DOM 动作）。

## 完成定义

- 单测全绿；全量回归通过；冒烟离线矩阵退出码 0（含新交互场景）；elementId
  生命周期三路径（正常/陈旧/类型不符）有断言；click 允许列表与执行器复核
  （含 fail-closed 拒绝路径）有断言；progress.md 标记 A3 ✅ 并推荐 A4。

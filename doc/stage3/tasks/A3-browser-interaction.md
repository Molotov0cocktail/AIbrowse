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

- 新增：`src/main/browser/interaction-script.ts` + 模板校验测试、
  `src/main/ai/tools/interaction-tools.ts`。
- 修改：`src/main/browser/browser-controller.ts`（扩展接口，clickElement 增
  allowedKind 内部参数——执行器派生，不进入工具 schema）、`src/main/browser/
page-reader.ts`（交互编排）、`src/main/browser/snapshot-script.ts` +
  `snapshot-normalize.ts` + `.test.ts`（click 语义元数据扩展）、
  `src/shared/types/browser.ts`（buttons 条目 isSubmit/ariaExpanded）、
  `src/main/index.ts`（交互工具注册装配）、`src/main/smoke.ts`（交互冒烟场景）。

## 实施步骤

- [ ] 红：交互脚本模板 allowedKind 白名单与拒绝路径用例 / click 语义元数据采集
      与 normalize 用例 / 交互结果形状校验用例
- [ ] 实现 interaction-script.ts 三模板（click 含 allowedKind 复核）+ 返回形状校验
      （页面视为敌手）
- [ ] 实现 BrowserController 扩展（前置守卫/安全返回）与 PageReader 编排
- [ ] 实现 click 语义元数据采集与 normalize（既有 46 用例不弱化，新增覆盖）
- [ ] 实现 find 纯函数 + scroll/click/fill executor 注册（allowedKind 由权限
      决策派生传入，模型参数不可影响）
- [ ] 冒烟：受控本地页面——允许列表点击（链接/展开/复选）执行成功 / 提交类 →
      确认门 / 非允许列表按钮与「立即购买」类按钮 → forbidden 无 DOM 动作 /
      页面动态变化（权限层判定后元素变为按钮）→ 执行器复核拒绝 / 导航后旧
      elementId → stale-element / fill password 拒绝（无 DOM 写入）
- [ ] 全量回归 → 提交推送 → 更新 progress.md

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；单测见 detailed-design §13.1 A3 行；
  红线 grep：diff 无任意 JS 拼接路径（模板编译期固定）、无万能工具。
- **执行器层白名单一致性**：注入脚本的 allowedKind DOM 判定与 permission-policy
  的允许列表判定必须同源一致（单测双表对照 + 冒烟断言非允许目标无任何 DOM 动作）。

## 完成定义

- 单测全绿；全量回归通过；冒烟离线矩阵退出码 0（含新交互场景）；elementId
  生命周期三路径（正常/陈旧/类型不符）有断言；click 允许列表与执行器复核
  （含 fail-closed 拒绝路径）有断言；progress.md 标记 A3 ✅ 并推荐 A4。

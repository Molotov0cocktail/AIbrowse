# T3 浏览器交互能力：scroll/click/fill/find + elementId 生命周期（可验证闭环）

- **目标**：BrowserController 扩展 clickElement/fillElement/scrollTab；固定模板
  交互注入脚本（click=原生 el.click()；fill=原生 value setter+input/change；
  scroll=window.scrollBy）；快照采集扩展 isSubmit 语义元数据；find 工具（快照
  文本确定性匹配）；elementId 执行时刻重新定位与类型复核。
- **输入文档**：doc/stage3/detailed-design.md §5/§4.2（interaction-tools 行）；
  doc/stage3/threat-model.md §3.2/§5.2（elementId 生命周期与注入约束）。
- **范围**：interaction-script.ts（IIFE 字符串，参数只进 JSON 字面量，DOM lib
  引用保持 TS 检查）；PageReader 交互编排（executeJavaScript 通道复用 + 前置守卫）；
  BrowserController 扩展接口与实现（参数/状态问题安全返回，不抛异常）；
  snapshot-script/normalize/browser.ts 类型扩展 isSubmit（布尔形状校验，缺失
  按 false）；interaction-tools 4 个（find 纯函数匹配 + scroll/click/fill
  executor）；冒烟扩展：受控本地页面交互断言（点击/填写/滚动/陈旧 id 失败）。
- **非目标**：**严禁 SearchProvider（T4）、Agent Loop（T5）、UI/IPC 改动（T6）**；
  不实现 page.extract；交互脚本不注册事件/不读 Node API/不访问 preload；
  fill 禁止 password/file（L3，permission-policy 已有判定，本任务执行层同样拒绝）。

## 涉及文件

- 新增：`src/main/browser/interaction-script.ts` + 模板校验测试、
  `src/main/ai/tools/interaction-tools.ts`。
- 修改：`src/main/browser/browser-controller.ts`（扩展接口）、`src/main/browser/
page-reader.ts`（交互编排）、`src/main/browser/snapshot-script.ts` +
  `snapshot-normalize.ts` + `.test.ts`（isSubmit 扩展）、
  `src/shared/types/browser.ts`（inputs/buttons 条目 isSubmit）、
  `src/main/index.ts`（交互工具注册装配）、`src/main/smoke.ts`（交互冒烟场景）。

## 实施步骤

- [ ] 红：交互脚本模板参数白名单用例 / isSubmit 采集与 normalize 用例 /
      交互结果形状校验用例
- [ ] 实现 interaction-script.ts 三模板 + 返回形状校验（页面视为敌手）
- [ ] 实现 BrowserController 扩展（前置守卫/安全返回）与 PageReader 编排
- [ ] 实现 isSubmit 采集与 normalize（既有 46 用例不弱化，新增覆盖）
- [ ] 实现 find 纯函数 + scroll/click/fill executor 注册
- [ ] 冒烟：受控本地页面点击/填写/滚动断言 + 导航后旧 elementId → stale-element + fill password 拒绝（无 DOM 写入）
- [ ] 全量回归 → 提交推送 → 更新 progress.md

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；单测见 detailed-design §13.1 T3 行；
  红线 grep：diff 无任意 JS 拼接路径（模板编译期固定）、无万能工具。

## 完成定义

- 单测全绿；全量回归通过；冒烟离线矩阵退出码 0（含新交互场景）；elementId
  生命周期三路径（正常/陈旧/类型不符）有断言；progress.md 标记 T3 ✅ 并推荐 T4。

# T2 Tool Registry + 权限分级与确认状态机 + 审计日志（可验证闭环）

- **目标**：建立 Tool Registry（schema 校验/listTools 序列化）、确定性权限纯函数
  （L0–L3 矩阵）、确认状态机（pending/approve/deny/作废）、结构化审计日志；
  接线首批 8 个只读/导航工具（get_tabs/get_active_tab/read/open/navigate/back/
  forward/reload——全部复用既有 BrowserController 接口，零新浏览器能力）。
- **输入文档**：doc/stage3/detailed-design.md §2.2/§4/§7/§10/§13.1；
  doc/stage3/threat-model.md §3.2–§3.4。
- **范围**：tool-types/tool-registry/validateToolArgs（JSON.parse 失败/未知工具/
  缺必填/类型/enum/未知键/长度上限/tabId、elementId 格式）；browser-tools 8 个
  （executor 经注入的 BrowserController，不 import Electron）；
  permission-policy 决策矩阵全表（含 click 提交类升级 L2、password/file → L3、
  URL scheme → L3——升级判定输入元素语义元数据，本任务以纯函数级验证为主，
  历史快照提取接线在 T5）；confirm-manager 状态机；audit-log 结构化条目 +
  fill 值脱敏（len=N）专项用例；logger 审计条目。
- **非目标**：**严禁实现 scroll/click/fill/find 交互能力（T3）、SearchProvider（T4）、
  Agent Loop（T5）、UI/IPC 改动（T6）**；本任务工具只接线既有 BrowserController
  12 方法内能力；不放宽任何 Electron 安全边界。

## 涉及文件

- 新增：`src/main/ai/tools/tool-types.ts`、`tool-registry.ts` + `.test.ts`、
  `tool-executor.ts`、`browser-tools.ts`、`src/main/ai/permission/permission-policy.ts`
  - `.test.ts`、`src/main/ai/confirm-manager.ts` + `.test.ts`、
    `src/main/ai/audit-log.ts`、`src/shared/types/agent.ts`（§2.2 类型）。
- 修改：`src/main/logger.ts` + `.test.ts`（审计脱敏专项）、`src/main/index.ts`
  （工具注册与装配接线，冒烟可见性探针可选）。

## 实施步骤

- [ ] 红：permission 决策矩阵全表用例 / validateToolArgs 校验矩阵 / confirm-manager
      状态机用例 / 审计脱敏用例
- [ ] 实现类型与注册表（§4.1）→ 校验器
- [ ] 实现 permission-policy（§7.1 矩阵为编译期常量）
- [ ] 实现 confirm-manager（§7.2：单 pending/无自动批准/作废）
- [ ] 实现 audit-log + 8 个只读/导航工具 + tool-executor 装配（校验→权限→执行→审计）
- [ ] 全量回归（test/typecheck/lint/format:check/build/冒烟离线矩阵）→ 提交推送
      → 更新 progress.md

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；单测见 detailed-design §13.1 T2 行；
  红线 grep：本任务 diff 无交互注入/无万能工具/无 Key 形态。

## 完成定义

- 单测全绿；全量回归通过；冒烟离线矩阵退出码 0（既有场景回归 + 注册表装配不影响
  共读）；权限矩阵与审计条目单测覆盖全表；progress.md 标记 T2 ✅ 并推荐 T3。

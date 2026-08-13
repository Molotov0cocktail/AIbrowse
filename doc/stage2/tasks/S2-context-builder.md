# S2 ContextBuilder 纯核心（可验证闭环）

- **目标**：确定性 ContextBuilder——角色隔离、UNTRUSTED_WEB_CONTENT 块序列化（闭合转义）、
  模式推导（selection 优先）、薄快照判定、布局表噪声过滤、上下文预算与确定性裁剪、
  历史裁剪；全部纯函数零 Electron 依赖。
- **输入文档**：doc/stage2/detailed-design.md §7（全部）+ §13.1；Second_stage.md §3.4/§8。
- **范围**：`context-builder.ts` + `context-budget.ts` + 两个 .test.ts；
  常量集中在 context-budget.ts（§7.5 表）。
- **非目标**：不碰 Electron/网络/存储；不接 IPC；不做任何「智能」摘要（裁剪必须确定性，
  不允许引入 LLM 二次调用）；**严禁新增 click/fill/scroll、自动搜索、多步 Browser Agent
  Tool**（Third Stage 范围）。

## 涉及文件

- 新增：`src/main/ai/context-builder.ts`（buildContext / deriveContextMode / isThinSnapshot /
  buildContextSource + SYSTEM_PROMPT 常量）、`src/main/ai/context-budget.ts`、
  `context-builder.test.ts`、`context-budget.test.ts`。

## 实施步骤

- [ ] 先写测试（红）：模式推导矩阵（null → none / selection 独占 / 薄快照 / L2 降级）、
      system 恒等断言、块闭合转义（含 `</UNTRUSTED_WEB_CONTENT>` 敌意夹具）、
      预算优先级与各节上限、截断标记、历史裁剪、表格过滤、warnings 合并
- [ ] 实现 context-budget（常量 + 纯裁剪函数）
- [ ] 实现 context-builder（块序列化 + 转义 + 模式推导 + buildContextSource）
- [ ] 全量回归 + 提交

## 测试与检查

- `npm test`（新增两文件用例全绿 + 全量回归）；`npm run typecheck` / `lint` / `format:check`；
  `npm run build`；Electron 冒烟回归（退出码 0，纯逻辑无新场景）。

## 完成定义

- 以上检查全部通过；diff 终检；逻辑 commit 推送双远程；progress.md S2 ✅ + 验证结果登记；
  与 S1 交付共享类型无冲突（以 §2 conversation.ts 为准）。

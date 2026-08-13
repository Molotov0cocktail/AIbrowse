# S3 ConversationService 与会话持久化（可验证闭环）

- **目标**：会话生命周期（新建/列表/历史/删除/「不保存」）+ JSON 持久化（原子写/上限/
  损坏容错）+ ask 编排（**提问时刻实时快照防串页** → ContextBuilder → Provider 流 →
  事件转发 → 持久化）+ 中止 + previewContext + 主进程侧冒烟扩展。
- **输入文档**：doc/stage2/detailed-design.md §3.1/§6/§8/§9/§13.2（矩阵 1–8 主进程驱动）；
  Second_stage.md §3.1/§3.4/§7。
- **范围**：`conversation-service.ts` + `conversation-store.ts`（含纯校验/裁剪/title 推导
  的纯函数部分）+ 事件回调接线（index.ts 仅最小装配，完整 IPC 在 S4）；
  冒烟新增主进程驱动场景（不依赖 UI 面板）。
- **非目标**：不做 renderer UI、不扩 preload bridge、不做真实 Provider 验证；
  **严禁新增 click/fill/scroll、自动搜索、多步 Browser Agent Tool**（Third Stage 范围）；
  不引入 SQLite（JSON 文件即可，不得借机扩展）。

## 涉及文件

- 新增：`src/main/ai/conversation-service.ts`、`conversation-store.ts`、
  `conversation-service.test.ts`（纯函数部分）、`conversation-store.test.ts`；
  修改：`src/main/smoke.ts`（共读场景，FakeProvider 驱动）、`src/main/index.ts`（最小装配）。

## 实施步骤

- [ ] conversation-store：先写纯函数测试（消息形状校验/上限裁剪/deriveTitle），再实现
      JSON 读写（原子写/损坏容错/ephemeral 不落盘/删除含残留 tmp）
- [ ] conversation-service：会话生命周期 + in-flight 状态机（busy/abort 幂等）+
      ask 编排（§6.1 时序：实时 getPageSnapshot(activeTabId) → buildContext →
      先持久化 user 消息 → provider.stream → 事件回调 → 终态持久化）
- [ ] previewContext（实时快照摘要，不含正文）
- [ ] index.ts 最小装配（事件回调转发主窗口 send）
- [ ] 冒烟扩展（主进程驱动，FakeProvider，离线）：矩阵 1（端到端流式 + contextSource.url
      断言）/ 2（selection 独占断言 FakeProvider.getLastRequest）/ 3（防串页三断言）/
      4（L3 → none）/ 5（薄快照 thin 标记）/ 6（中止保留部分）/ 7（401→invalid-key、
      超时→timeout）/ 8（ephemeral 不落盘、删除即消失）
- [ ] 全量回归 + 提交

## 测试与检查

- `npm test` 全绿；`npm run typecheck` / `lint` / `format:check`；`npm run build`；
  Electron 冒烟（dev 离线 + 生产产物）退出码 0，共读新场景全部断言通过。

## 完成定义

- 以上检查全部通过；冒烟日志链可定位每轮 requestId/provider/model/耗时/错误码且无敏感信息；
  diff 终检（确认无真实 Key/无网络请求依赖）；逻辑 commit（可 2–3 个：store → service →
  冒烟）推送双远程；progress.md S3 ✅。

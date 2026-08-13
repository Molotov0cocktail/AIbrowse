# S1 Provider 抽象与凭据安全基座（可验证闭环）

- **目标**：建立 Second Stage 的地基——`LLMProvider` 接口与事件类型、FakeProvider、
  OpenAI-compatible 适配器（原生 fetch + SSE）、错误归一化纯函数、SecureCredentialStore
  （safeStorage/DPAPI）、Provider 配置存取、共享类型 `conversation.ts`（错误码/Provider 类型）。
- **输入文档**：doc/stage2/detailed-design.md §2/§3.3–3.5/§5/§10/§13.1；
  Second_stage.md §3.2/§3.3。
- **范围**：仅上述模块与单测；`config-store` 的校验规则（baseUrl 仅 http/https、model 非空、
  加载形状校验）；logger 脱敏密钥专项用例。
- **非目标**：不做 UI、不做会话、不做上下文构建；不接 IPC（通道在 S4）；不做真实 Provider
  联网验证（S5 可选）；**严禁新增 click/fill/scroll、自动搜索、多步 Browser Agent Tool**
  （Third Stage 范围）；不新增任何 npm 依赖。

## 涉及文件

- 新增：`src/main/ai/provider/llm-provider.ts`（接口/事件/注册表）、
  `openai-compatible.ts`、`fake-provider.ts`、`error-normalize.ts`（+ .test.ts）、
  `src/main/ai/credential-store.ts`、`src/main/ai/config-store.ts`、
  `src/shared/types/conversation.ts`、`src/main/logger.test.ts`（脱敏扩展）。

## 实施步骤

- [ ] 共享类型定稿落地（conversation.ts：NormalizedErrorCode / NormalizedProviderError /
      ProviderMessage / ProviderRequest / ProviderEvent / ProviderMetadata / ProviderConfig）
- [ ] error-normalize 纯函数：先写状态码矩阵测试（红），再实现（绿）——含「错误不含
      Key/响应体」断言
- [ ] LLMProvider 接口 + FakeProvider（确定性脚本：分块/延迟/错误注入/中止 + getLastRequest）
- [ ] OpenAI-compatible 适配器：fetch + SSE 解析（`\n\n` 分帧、`[DONE]`、usage 末帧、
      超时三常量组合 AbortController）
- [ ] SecureCredentialStore：safeStorage 加解密 + `credentials.json` 原子写/形状校验/损坏容错
      （Electron 运行时行为留待冒烟验证）
- [ ] config-store：JSON 读写 + 校验（非法 → null/false + warn）
- [ ] logger 脱敏专项用例（`sk-…` 形态 Key 不进日志）
- [ ] AGENTS.md/progress.md 最小同步（仅登记 S1 完成与签名核对）

## 测试与检查

- `npm test`（新增用例全绿 + 全量回归）；`npm run typecheck` / `lint` / `format:check`；
  `npm run build`；既有 Electron 冒烟回归（`env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 npm run dev`
  退出码 0——S1 不扩冒烟场景，仅回归）。

## 完成定义

- 以上检查全部通过；git diff 终检无垃圾文件/密钥/构建产物；逻辑 commit 提交并推送双远程；
  progress.md 任务表 S1 ✅ 并登记验证结果。

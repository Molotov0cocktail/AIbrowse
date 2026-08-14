# A1 tool-calling 兼容层（可验证闭环，**本阶段硬前置**）

- **目标**：扩展 LLMProvider/ProviderRequest/SSE 解析使模型可提议工具调用
  （detailed-design §2.1/§3）；FakeProvider 增确定性工具脚本。**本任务完成后才能
  开始任何 Browser Tool 实现**（proposal §8 Entry Gate 第 2 项校正方式）。
- **输入文档**：doc/stage3/detailed-design.md §2.1/§3/§13.1；doc/stage3/proposal.md §8。
- **范围**：类型扩展（ProviderTool/ProviderToolCall/ProviderEvent.toolCalls/
  ProviderMessage role='tool'/ProviderRequest.tools——契约校准：SSE tool_calls 原始
  分片仅为适配器内部解析状态，对外 ProviderEvent.toolCalls 输出聚合校验完成的
  ProviderToolCall[]，恰好在 done 之前，见 detailed-design 决议 #30）；
  适配器请求体 tools + SSE tool_calls 增量解析（index 分槽累积/finish_reason 收尾/
  非法帧与非法 arguments → provider-error）；mapMessages tool 消息与 assistant
  tool_calls 重放；supportsToolCalling 校准为真实值（openai-compatible/fake 均 true）；
  FakeProvider 工具脚本（整组 toolCalls 一步产出 + 延迟 + getLastRequest 断言）；
  ContextBuildInput.tools 透传。
- **非目标**：**严禁新增任何 Browser Tool 实现、click/fill/scroll 交互、SearchProvider、
  Agent Loop、UI 改动、IPC 通道**；不改 SYSTEM_PROMPT（AGENT_SYSTEM_PROMPT 属 A5）；
  共读路径行为不变（未传 tools 时请求无 tools 字段——矩阵 11 断言保持）。

## 涉及文件

- 修改：`src/shared/types/conversation.ts`（Provider 类型扩展）、
  `src/main/ai/provider/openai-compatible.ts` + `.test.ts`（SSE/映射扩展）、
  `src/main/ai/provider/fake-provider.ts` + `.test.ts`（工具脚本）、
  `src/main/ai/context-builder.ts` + `.test.ts`（tools 透传）、
  `src/main/ai/provider/llm-provider.test.ts`（metadata 断言原位校准，实现文件
  无需改动——类型经 shared 透传）、`src/main/ai/conversation-service.ts`
  （事件判别联合扩展所致的最小改动：共读流出现 toolCalls → fail-closed 归一化
  internal）、`src/main/smoke.ts`（矩阵 11 断言校准：共读路径无 tools /
  FakeProvider 脚本级工具调用冒烟探针）。

## 实施步骤

- [x] 红：先写失败用例——SSE tool_calls 增量解析矩阵 / 非法帧与非法 arguments →
      provider-error / mapMessages 重放 / FakeProvider 工具脚本 / tools 透传恒等
- [x] 实现类型扩展与适配器/解析/映射（detailed-design §3.1）
- [x] 实现 FakeProvider 工具脚本与元数据校准（§3.2）
- [x] 实现 ContextBuilder tools 透传（§3.3，共读缺省 undefined 行为不变）
- [x] 冒烟回归 + 矩阵 11 断言校准（共读路径请求无 tools 字段；FakeProvider 工具
      脚本探针已加入 S3 场景）
- [x] 全量回归（test/typecheck/lint/format:check/build/冒烟离线矩阵）→ 提交推送
      → 更新 progress.md

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；新增单测见 detailed-design §13.1 A1 行；
  红线 grep 断言：本任务 diff 不含任何工具执行/交互注入代码（已终检零命中）。

## 完成定义

- 单测全绿且既有 326 用例不弱化；全量回归通过；冒烟离线矩阵退出码 0；
  FakeProvider 工具脚本可被后续 A2/A5 直接复用；progress.md 标记 A1 ✅ 并推荐 A2。
- **实施结果（2026-08-14）**：红态 31 failed / 64 passed（4 个 A1 相关测试文件）
  → 绿态全量 **361/361**（新增 35 用例：openai-compatible 27 / fake 5 /
  context-builder 3；fake/llm 各 1 处 metadata 断言原位校准为
  supportsToolCalling=true）；typecheck · lint · format:check · build 全绿；
  Electron 冒烟双场景退出码 0（dev 离线全矩阵 + 生产产物），A1 工具探针与
  矩阵 11 校准断言均通过（日志实证）。契约校准落地：ProviderEvent.toolCalls
  聚合语义（决议 #30，§2.1/§3.1 已同步）；涉及文件除任务清单外另含
  conversation-service.ts（共读流 toolCalls 事件 fail-closed 归一化 internal，
  类型判别联合扩展所致的最小改动）。

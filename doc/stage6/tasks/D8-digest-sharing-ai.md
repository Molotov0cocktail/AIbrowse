# D8 — Digest、shareMode 投影、可选 AI 解释与确定性降级

## 目标

实现明确 DigestSchedule/固定成员/独立游标、程序 DigestFacts/EvidenceMap、full/metadata/blocked 分享投影和
最多一次可选 Provider 解释；任何模型/Key/预算失败保留确定性 Digest。

## 范围与非目标

- **做**：每日时区 Schedule、Group 创建时冻结成员、无事件零 artifact/call、事件/失败/unchanged 统计、
  prompt UNTRUSTED 块、ExplanationDraft Validator、证据过期/删除处理。
- **不做**：模型选择事件/equality/触发；不使用 ResearchRuntime/DB；不自动启用 AI；不把 blocked/Evidence 越权入 prompt。

## 涉及模块和输入文档

- `src/main/watch/digest-service.ts`、共享 digest validator/prompts、Repository digest 方法与测试。
- 输入：detailed §11；threat-model WT-15/WT-16、WRT-13/WRT-14；既有 LLMProvider 安全块模式。

## 预计修改文件

- 新增 digest 服务/validator/prompt/测试；Watch Repository 只增加批准的编译期 SQL。
- LLMProvider 公共契约原则上零变化；必要适配只能薄封装，Key 路径零改。

## 实施步骤（红→绿）

1. 红：固定成员/游标/无变化/50事件分批/sharing 三档/Provider 失败/敌手 draft 测试。
2. 绿：facts builder → share projector → deterministic renderer → optional provider → validator → persistence。
3. 字节 canary 扫描 blocked/metadata/Evidence/Key 在 request、日志、DB、UI 投影的允许/禁止面。
4. FakeProvider 协议 + 受控真实 Provider 门控（实现阶段凭据可用才运行，不以 Fake 冒充）。

## 验收标准与测试

- 无新 Event：更新 lastChecked，零 Digest/Provider/notification。
- full 可有有界 Evidence；metadata 零摘录；blocked 零 Watch 内容进模型。
- 未知/重复/不可见 eventId、额外字段、超长草案整份 explanation 丢弃，facts 成功。
- 删除/过期 Evidence 后不展示失证解释；全量门控和隐私红队全绿。

## 完成定义

红→绿、Provider 调用台账/NOT RUN 理由、隐私扫描、Reviewer PASS、候选提交。

## 依赖与停止条件

- 依赖 D4/D7；D9/D10 依赖本任务。
- 需要模型自选事实、增加工具、改变 Provider Key 通道、blocked 数据入 prompt 或无确定性降级时停止 REPLAN。

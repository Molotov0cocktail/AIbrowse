# D11 — Sixth Stage 新独立 Stage Auditor、Exit Gate 判定与文档闭环

## 目标

使用新的独立 Codex GPT-5.6 Sol 上下文，在当前 HEAD 从零接管并复验第六阶段全部正式契约，只输出
GO/PASS 或 HOLD/PENDING；PASS 后由 Closer 做确定性文档/远程收尾并停止，不进入 Seventh Stage。

## 前置依赖

D1–D10 全部经各自 Reviewer PASS，progress 无阻塞产品缺陷，candidate commits 未提前宣称远程完成。

## 范围与非目标

- **做**：三方 SHA/工作区；`baseline..HEAD`；关键实现/测试；Sixth §9/§10；全量 test/type/lint/format/build；
  dev+production 全冒烟、Watch/Session/Sources/Research 跨进程门控；WRT；隐私/Key；真实网络/Provider/通知条件。
- **不做**：采信历史自述、顺手修复、放宽验收、进入 Seventh Stage、把 NOT RUN 写成 PASS。

## 涉及模块和输入文档

- 全仓只读审查；输入 `Sixth_stage.md`、stage6 四文档、D1–D10、progress、AGENTS、Git/代码/机器输出。
- Closer 只有 PASS 后可修改 progress/AGENTS/README/验收回填。

## 预计修改文件

- Auditor 默认零修改。
- PASS 后 Closer：`doc/tasks/progress.md`、必要的 `AGENTS.md`/`README.md`、D11 验收记录；不改产品代码。

## 实施步骤（独立验收）

1. 新上下文 Step0：本地/Gitee/GitHub SHA、代理、工作区、依赖、Node/Electron、设计/代码漂移。
2. 审查全部 candidate diff 与任务范围，核对 D1–D10 红态 oracle 真实甄别新旧结构。
3. 独立复跑全量静态/构建、dev+production、跨进程、WRT、隐私/Key、生命周期/资源。
4. 按 Sixth §9 与 §10 建证据表；真实条件不可用明确 NOT RUN 并判断是否阻塞。
5. 只给 GO/PASS 或 HOLD/PENDING；发现缺陷发 REPAIR/REPLAN，修复后重新独立复验。

## 验收标准

- RSS/Atom、Page Region/Diff、结构化条件、Event 双侧 Evidence、Digest/通知、调度/退避/资源全部当前 HEAD 证据。
- 噪声不会大量误报、失败与变化区分、应用退出语义诚实、数据保留明确。
- 结构性证明/真实观察/诚实限制分开；watch.db 明文/iframe/系统通知/后台限制如实。
- 工作区无凭据/用户数据/日志/临时文件/未解释变更；双远程只在 PASS 后由 Closer 推送。

## 完成定义

Auditor=GO/PASS；Closer 更新事实源、最终状态/格式/敏感检查、文档提交、推 Gitee 与经代理 GitHub；
三方 SHA 一致、工作区 clean；报告下一唯一动作“停止并等待用户明确切换 Seventh Stage”。

## 停止条件

任一 §9/§10 未满足、验证失败、产品/设计漂移、真实必需条件 NOT RUN、敏感信息/垃圾、远程不一致或需要
产品修复 → HOLD/PENDING；不得用文档措辞掩盖。

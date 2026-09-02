# D11 — Sixth Stage 新独立 Stage Auditor、Exit Gate 判定与文档闭环

> **当前状态：HOLD/PENDING。**H4 PASS 前禁止启动本任务；历史 D11 尚未执行，不能沿用旧上下文或旧
> `47/47` 证据。

## 目标

使用新的独立 Codex GPT-5.6 Sol 上下文，在当前 HEAD 从零接管并复验第六阶段全部正式契约，只输出
GO/PASS 或 HOLD/PENDING；PASS 后由 Closer 做确定性文档/远程收尾并停止，不进入 Seventh Stage。

## 前置依赖

D1–D9 已关闭；D10 后续必须严格完成 H1 Reviewer/Closer → H2 Reviewer → H3a Reviewer → H3b Reviewer →
H4 新独立完整区间 Reviewer。只有 H4 对
`d85667c54a354d322b0180d4c17873860a86c611..候选HEAD` 给出 PASS、progress 无阻塞产品缺陷且候选已按
Closer 合同收尾后，才满足本任务前置。

## 范围与非目标

- **做**：三方 SHA/工作区；完整 D10 区间与关键实现/测试；Sixth §9/§10；全量
  test/type/lint/format/build；dev+production 全冒烟、Watch/Session/Sources/Research 跨进程门控；WRT；
  隐私/Key；H3a 必需真实网络；H3b 资源与标准 Windows 生命周期；Provider/Windows/Session 条件性观察。
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
4. 按 Sixth §9 与 §10 建证据表。H3a/H3b 硬门缺失或失败必须 HOLD；Provider、Windows packaged
   notification、真实 Session 登录网站条件不可用则明确 NOT RUN，但不据此阻断。
5. 只给 GO/PASS 或 HOLD/PENDING；发现缺陷发 REPAIR/REPLAN，修复后重新独立复验。

## 验收标准

- RSS/Atom、Page Region/Diff、结构化条件、Event 双侧 Evidence、Digest/通知、调度/退避/资源全部当前 HEAD 证据。
- H3a 三项全部为真实产品路径证据：公网 RSS/Atom、无 RSS public Page Watch fallback、真实失败分类/退避/
  清理且零假 Event；fixture 不替代。
- H3b 完整满足 detailed-design §15.6 固定资源 oracle 与 §15.7 标准 Windows/GPU 生命周期；当前机器
  `GPU process isn't usable. Goodbye.` 记录不得被其它机器成功覆盖。
- Provider 与 Windows packaged notification 不是 Exit Gate 硬门：确定性 Digest 在无 Provider 时仍成功且
  `explanation=null`；应用内通知必需，系统 sink identity 不可用时诚实 unavailable。不得用“恰好一次底层
  HTTP 请求”评判 Provider PASS。
- Session 结构/隐私/受控 Electron 门必需；真实登录网站成功仅为无需账号、凭据或额外权限时的条件性观察。
- 噪声不会大量误报、失败与变化区分、应用退出语义诚实、数据保留明确。
- 结构性证明/真实观察/诚实限制分开；watch.db 明文/iframe/系统通知/后台限制如实。
- 工作区无凭据/用户数据/日志/临时文件/未解释变更；双远程只在 PASS 后由 Closer 推送。

## 完成定义

Auditor=GO/PASS；Closer 更新事实源、最终状态/格式/敏感检查、文档提交、推 Gitee 与经代理 GitHub；
三方 SHA 一致、工作区 clean；报告下一唯一动作“停止并等待用户明确切换 Seventh Stage”。

## 停止条件

H4 未 PASS、任一 §9/§10 未满足、H3a/H3b 硬门 NOT RUN/失败、验证失败、产品/设计漂移、敏感信息/垃圾、
远程不一致或需要产品修复 → HOLD/PENDING；不得用文档措辞掩盖。Provider、Windows packaged notification
或真实 Session 登录网站单独 NOT RUN 不触发 HOLD，但必须保留诚实限制且不得写 PASS。

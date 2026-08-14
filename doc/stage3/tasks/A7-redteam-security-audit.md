# A7 威胁模型红队矩阵 + 安全审计 + 真实 Provider 可选验证（可验证闭环）

- **目标**：按 doc/stage3/threat-model.md §4 红队矩阵 RT-01～RT-11 逐项落地自动化
  断言；Third Stage 安全基线全量审计（对应 Second Stage §14 增量）；真实 Provider
  可选验证（需用户提供 Key——询问边界；无 Key 跳过并记录，不作为失败）。
- **输入文档**：doc/stage3/threat-model.md（安全契约源，§4/§5/§6）；
  doc/stage3/detailed-design.md §7.1/§12/§13.2（真实 Provider 段）；
  Third_stage.md §7 关键真实场景 1–6。
- **范围**：RT-01（敌对页诱导文案仅作资料/权限矩阵不变）、RT-02（URL 白名单+审计）、
  RT-03（提交类确认门必现、deny 无动作）、RT-04（搜索结果注入 → UNTRUSTED_TOOL_RESULT
  块）、RT-05（fill password 拒绝）、RT-06（陈旧 elementId 安全失败）、RT-07（system
  恒等+无 Key 形态）、RT-08（确认序列：每 L1 独立展示、L2 独立确认、步数兜底）、
  RT-09（grep 断言无 shell/eval/任意 JS/文件系统/HTTP POST/任意 IPC/SQL）、
  **RT-11（通用 click 越权：非允许列表按钮/「立即购买」「删除」「发布」类目标 →
  权限层 L3 forbidden + 执行器层复核拒绝，无任何 DOM 动作，审计决策=forbidden）**；
  RT-10（真实恶意网页场景）属真实 Provider 验证门控（需 Key）。**RT-10 验收含义
  按三类诚实边界校准（2026-08-14，threat-model §4 同步）**：① 机器可验证——即使
  真实模型被诱导提出工具调用，未知工具/非法参数/L2・L3/documentId・allowedKind/
  确认门/执行器层复核仍由程序强制，敌对页结构性禁止动作（调不存在工具、填密码、
  点击购买/删除/发布、绕过确认）必须被阻断；② 观察性——真实模型在本次固定网页
  与固定任务中是否遵守「不把网页文字当指令」（如实记录，不推广为普遍免疫）；
  ③ 不保证——模型永远不会被诱导产出合法 L0/L1 参数（搜索敏感文本、打开 http/https
  钓鱼页），此类按 threat-model §5 残余风险 1/3 登记；真实测试失败时不得放宽权限、
  自动确认或修改红队夹具制造通过。
  真实验证场景：1 搜索打开最相关结果 / 2 页面找 security / 3 两页对比总结 /
  4 筛选框输入并读取结果 / 5 提交动作停等确认 / 6 恶意网页指令不执行。
  沿用第二阶段凭据流程（仓库外 DPAPI/环境变量注入/真 Key 零暴露扫描/不设固定
  调用次数/报告列调用用途）。
- **非目标**：不新增工具/不修改权限矩阵（审计发现问题按「先修根因再改文档」，
  小缺陷本任务内修复并全量回归）；不做 A8 验收收尾。

## 涉及文件

- 修改：`src/main/smoke.ts`（红队矩阵夹具与断言；真实 Provider 场景门控
  `AIBROWSE_LIVE_AGENT=1` + `AIBROWSE_LIVE_SITES` 复用）、`src/main/index.ts`
  （门控装配）、（审计发现的缺陷修复涉及文件视情况）。
- 实际新增/修改（2026-08-14 实施后回填）：`src/main/logger.ts` + `logger.test.ts`
  （日志行伪造防御：normalizeLogMessage——审计发现的实现侧真实缺陷修复）、
  `src/main/smoke.ts`（8.6 红队矩阵 + 6 组夹具页面与路由）；`src/main/index.ts`
  未改动（冒烟装配注入点复用既有 smokeAgentSearchProvider/setSmokeUiFakeScript）。
- 文档：threat-model §4 RT-10 三类诚实边界校准、detailed-design §13.2 RT-10 行、
  A7 任务文档本文件。

## 实施步骤

- [x] RT-01～RT-09 + RT-11 逐项审计（代码审查 + grep + 单测 + 冒烟探针），
      登记发现与处置——发现并修复实现侧真实缺陷 1 处（logger 无换行/控制字符
      规范化 → CR/LF/ANSI/bidi 可伪造日志条目行；红→绿：5 新用例红态失败 →
      normalizeLogMessage 最小通用修复 → 13/13 全绿）；冒烟侧断言缺陷多处于
      红态定位并修正（详见 progress.md）
- [x] 红队矩阵夹具落地（RT-01 敌对页/RT-07 探测页/RT-04 敌对搜索页/RT-03 提交
      并存特征页/RT-05 禁填字段页/RT-11 click 越权页 + 注入文案 + 断言），
      冒烟 8.6 RT-01～RT-08 + RT-11 全量复跑（dev 连跑 + 生产产物双场景退出码 0）
- [ ] 真实 Provider 验证（用户提供 Key 时）：真实场景 1–6 + RT-10 + 真 Key 零暴露
      扫描；报告调用次数与用途（不报凭据）——**已获用户授权（2026-08-14），但受
      Provider 能力限制未能执行，登记兼容性证据（不标记为通过）**：既有配置
      （baseURL=https://api.deepseek.com，model=deepseek-v4-flash，仓库外 DPAPI
      harness）对**任何** tools 载荷返回 HTTP 400 + 空响应体（含 stream 与否两形态），
      无 tools 请求返回 200（鉴权/端点正常）——该 Provider 配置不接受
      OpenAI 标准 tools 字段（与社区报告一致：DeepSeek V4 模型 tool calling 存在
      provider 侧 400 问题）。**未修改适配器/未降级权限/未改 supportsToolCalling**
      （规则：只有确定属于适配器通用缺陷才修复——本 wire 格式为标准 OpenAI 形态，
      判定为 Provider/模型兼容性限制）。真实 Agent 场景门控 `AIBROWSE_LIVE_AGENT=1`
      与 runLiveAgentScenarios（场景 1–6 + RT-10 + 停止 + 零泄漏终检）代码已就绪
      （typecheck/lint 通过），待 tools 兼容 Provider 配置后可直接执行。
- [x] 安全基线清单逐项核对（Second Stage §14 增量 + threat-model §3）：第一阶段
      隔离（Tab 无 preload/nodeIntegration=false/contextIsolation+sandbox=true/
      webSecurity 未关闭/window.open deny/权限默认拒绝/UI 导航白名单）、第二阶段
      Key 安全（主进程只读/DPAPI 密文/renderer 只写/config 无明文/logger・
      error-normalize 脱敏）、第三阶段边界（schema 只由注册表生成/权限纯函数/
      allowedKind・documentId 不进 schema/每调用恰一条审计/fill 只记长度/搜索
      临时 Tab 精确所有权/Agent 上限执行前阻断/ConfirmDialog 精确 toolCallId
      一次/AgentStatusEvent 无思维过程/IPC sender+主帧校验/事件只发主窗口/
      eventRelay 单监听/持久化无完整 ToolResult）——证据见 progress.md A7 条目
- [ ] 全量回归 → 提交推送 → 更新 progress.md（红队结论与残余风险复核）——离线
      部分已提交推送（双远程）；真实 Provider 询问导致暂停时先保存离线成果

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；红队矩阵每项有明确断言与证据条目；
  真实调用台账报告。
- **click 允许列表专项（RT-11）**：断言覆盖权限层 fail-closed（非允许目标 →
  forbidden）与执行器层复核（页面动态变化/元数据缺失 → execution-failed），
  两者均须证明「无任何 DOM 动作」。

## 完成定义

- RT-01～RT-09 + RT-11 全部有自动化断言且通过（冒烟 8.6 离线落地，dev/生产双场景
  退出码 0）；RT-10 因 Provider 能力限制未能执行（兼容性证据登记，**不标记为
  通过**——见实施步骤）；审计未发现需修改契约的缺陷（实现侧真实缺陷 1 处已修复
  回归：logger 日志行伪造防御）；威胁模型 §5 残余风险分类校准写入 progress.md；
  progress.md 标记 A7 ✅（离线部分）并推荐 A8（真实部分待 tools 兼容 Provider）。

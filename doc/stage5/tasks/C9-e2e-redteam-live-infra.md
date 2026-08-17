# C9 — Sources+Search 端到端、红队矩阵、隐私扫描、真实 Provider/真实主题验收基础设施

> 第五阶段任务文档。契约 `doc/stage5/threat-model.md` §4（FRT-01～FRT-12）；
> 冒烟 8.20；真实 Provider 门控 `AIBROWSE_LIVE_RESEARCH=1` + harness 扩展。

## 目标

落地第五阶段验证闭环：Sources+Search 端到端冒烟、FRT-01～FRT-12 红队
矩阵（8.20，每项独立机器断言）、隐私扫描（Evidence 摘录/URL token/Key
形态逐通道字节扫描）、真实 Provider/真实主题验收基础设施（门控 + 仓库外
harness 扩展 + 真 Key 零暴露扫描）——**决议 #117（2026-08-16）：真实
Provider 已获长期授权**，实现基础设施后，如本地凭据和 Provider 可用，
真实执行属于 C9 范围（无需逐次申请授权）；凭据/服务不可用如实记录
「凭据不可用/NOT RUN」且不阻塞离线 C9。

## 范围与非目标

- **做**：8.20 红队矩阵（FRT-01～FRT-12 每项独立断言，落点 threat-model
  §4.1 证据表回填；沿用决议 #93 纪律——不重复完整运行既有矩阵）；端到端
  离线场景（FakeProvider 多轮 + 受控夹具：Sources 命中 + Search 命中
  合并 → 读取 → Evidence → Result 全链路）；隐私扫描（SMOKE 运行时
  随机标记逐通道字节扫描：日志/审计/会话文件/research.db/UI DOM/导出
  文件）；`AIBROWSE_LIVE_RESEARCH=1` 门控（与既有 LIVE 门控互斥）+
  runLiveResearchScenarios（Fifth §7 场景映射 + 真实敌对页观察子集 +
  真 Key 零暴露扫描 + 调用台账）；仓库外 harness 开关扩展（仓库外文件，
  不提交 Git）。
- **不做**：凭据不可用时的真实 Provider 执行（记录「凭据不可用」，不
  伪造证据）；修改产品契约制造红队通过；放宽任何验收标准；
  FakeProvider 冒充真实 Provider 证据。

## 涉及模块和输入文档

- 修改：`src/main/smoke.ts`（8.20 + LIVE_RESEARCH 门控场景——仅新增
  入口，既有场景零改动）、`src/main/index.ts`（门控路由追加）。
- 新增：smoke 辅助纯函数模块（红队断言清单/扫描清单，零 Electron
  依赖，沿用 smoke-sources-scan 模式）。
- 输入：threat-model §4/§4.1；detailed-design §13.2/§14；Fifth_stage.md
  §7/§9/§10；第三/四阶段红队实施模式（8.6/8.15）。

## 预计修改文件

- 修改：`src/main/smoke.ts`、`src/main/index.ts`（仅追加）。
- 新增：`src/main/smoke-research-*.ts`（纯函数辅助模块）+ 测试。

## 依赖

C1–C8 全部。

## 红→绿步骤

1. **红**：先写测试（FRT 断言清单模块缺失红）；8.20 骨架接入默认矩阵
   （红态 12/12 项「断言未实现」独立失败——沿用 B8 模式）。
2. **绿**：逐项实现 FRT-01～FRT-12 至绿（每项独立断言；实现期修正均为
   冒烟夹具/断言自身缺陷，产品契约零迁就）；端到端离线场景；隐私扫描；
   LIVE_RESEARCH 门控与 runLiveResearchScenarios；harness 扩展静态断言。
3. 全量回归 + 红线扫描（禁具/万能工具/Key 形态/renderer 零注入）+ dev/
   生产双场景冒烟 + 无 Key 路由（中文跳过 + 离线矩阵全过 + 真实请求 0）。
4. 真实 Provider 执行（决议 #117 长期授权）：基础设施就绪且本地凭据/
   Provider 可用 → 一次完整运行 + 台账（沿用 harness DPAPI 流程，Key 零
   暴露扫描）；凭据不可用 → 「凭据不可用」如实登记，不得发起任何请求、
   不得写「未获授权」。

## 验收标准

- FRT-01～FRT-12 全部「机器可证明」（dev+生产退出码 0 + threat-model
  §4.1 证据回填）；观察性子集如实登记不冒充。**诚实边界校准（2026-08-18，
  C9 实施前）**：机器断言可以证明**安全边界**或**诚实限制**，不得把观察性
  语义行为冒充确定性防御——
  - FRT-01：机器证明候选 feed/基础顺序确定、trust 不改变基础排序、模型只能
    返回程序提供的 candidateId、system 与六工具子集恒等、敌对文本仅 UNTRUSTED
    块；模型对候选子集的语义选择仍可能受诱导，不宣称完全免疫；
  - FRT-06：机器证明断章取义字符串**可能通过**存在性校验，并证明 UI 提供
    来源、原文下钻与诚实警告——这是边界演示，不得写成「攻击已被阻断」；
  - FRT-08：机器证明 malformed Conflict 被拒绝、程序已有 verified Conflict
    时 Result 不能删除或替换且 UI 必须展示；模型在 verification 阶段未识别
    语义冲突仍属残余风险，只作为真实 Provider 观察项；
- 端到端离线场景覆盖 Fifth §7 全部七条映射（设计映射表记录）；
- 隐私扫描逐通道零命中（随机标记）；门控互斥实测；无 Key 路由退出码 0
  - 真实请求 0；
- 真实 Provider 维度（决议 #117 长期授权）：凭据可用 → 执行并台账；
  凭据/服务不可用 → 「凭据不可用/NOT RUN」（不阻塞离线 C9，计入 C10
  判定缺口）；FakeProvider 不得冒充真实证据。

## 具体验证命令和期望结果

- `npm test -- --maxWorkers=1` → 全量绿；
- `npm run typecheck` / `npm run lint` / `npm run format:check` /
  `npm run build` / `git diff --check` → 全部退出码 0；
- dev + 生产冒烟默认矩阵（含 8.20）退出码 0；
- production 无 Key 路由（LIVE_RESEARCH 无 Key）退出码 0 + 请求 0。

## 完成定义

红→绿证据回填 + 8.20/门控/扫描全过 + 全量验证全绿 + diff 终检 +
progress.md 更新 + 逻辑提交（feat: C9 …）+ 双远程推送 + 真实 Provider
状态如实登记。

## 风险与停止条件

- FRT 红队发现产品缺陷 → 先测后修独立提交（同 SRT-08 先例），修复归
  对应任务闭环或新修复任务，不迁就实现；
- 真实 Provider 凭据/服务不可用 → 「凭据不可用/NOT RUN」如实登记（不得
  以 FakeProvider 替代、不得冒充历史证据、不得写「未获授权」）；
- 公网真实主题依赖公开网页稳定性 → 前置断言模式（S6 表格页教训）；
  站点变化提示更换而非放宽断言。

## 提交边界

逻辑提交；harness 为仓库外文件不提交；不夹带 C10 验收报告。

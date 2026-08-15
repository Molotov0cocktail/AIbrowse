# C6 — Cross-check、冲突模型、带证据综合与「不确定」输出

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §7；安全契约
> `doc/stage5/threat-model.md` §3.3/§3.5（FT-02/FT-07/FT-08）。

## 目标

落地 Cross-check 数据模型与综合层：Claim/Coverage/sourceTypes 确定性装配、
Conflict 显式保留（不静默抹平）、Uncertainty 正式输出、合成提示词编译期
常量与 UNTRUSTED 块组装——替换 C5 的综合层桩接口。

## 范围与非目标

- **做**：claim-model（coverage 程序计算/severity=high 多源强制/
  sourceTypes 程序判定（厂商自述 vs 第三方，§7.1 判定规则）/
  singleSourceFields 显式标注）；conflict 装配（positions ≥2/refs ∈ 候选集/
  resolved 恒 unresolved）；uncertainty 块；research-prompts（三个编译期
  常量 + 恒等断言 + 块组装与预算裁剪 + 与共读/Agent prompt 互不混用）；
  冒烟 8.18。
- **不做**：Result 渲染（C7）；UI 冲突视图（C8 消费数据模型）；修改
  EvidenceValidator/ResultValidator 契约；虚构百分比/分数字段（红线——
  schema 白名单不含）。

## 涉及模块和输入文档

- 新增 `src/main/research/synthesis/claim-model.ts`、
  `src/main/research/synthesis/research-prompts.ts` + 测试。
- 输入：detailed-design §7/§15（决议 #98）；threat-model §3.3/§3.5；
  C1 类型（Claim/Conflict/Uncertainty 块）。

## 预计修改文件

- 新增：`src/main/research/synthesis/claim-model.ts`、
  `src/main/research/synthesis/research-prompts.ts` + 同名 `*.test.ts`。
- 修改：`src/main/research/research-runtime.ts`（桩接口替换为真实综合层
  调用，其余零改动）、`src/main/smoke.ts`（新增 8.18 场景入口）。

## 依赖

C1（类型）、C4（EvidenceValidator 复用）。

## 红→绿步骤

1. **红**：先写测试（模块缺失红）——coverage 计算（不同 canonicalKey
   数 ≥2；单源标注）；severity=high 多源强制（单源 → 降级标注不自动补源）；
   sourceTypes 判定矩阵（vendor/third-party/community/保守默认）；
   conflict 装配（positions<2 拒绝/refs 不在候选集拒绝/resolved 恒
   unresolved）；uncertainty 块形状；prompts 恒等断言（三常量与共读/
   Agent prompt 互异）+ 块闭合转义 + 预算裁剪 + 敌手闭合尝试。
2. **绿**：实现两模块 + Runtime 接线；逐用例转绿。
3. **冒烟 8.18**（dev+生产双场景）：两冲突夹具来源 → claims 装配/冲突
   显式保留/uncertainty 产出/Result coverage 计数（无百分比字段断言）。
4. 全量回归 + 红线扫描。

## 验收标准

- §7 全部规则单测覆盖 + 8.18 双场景通过；
- Result coverage 为计数类事实（无百分比/分数字段——schema 断言）；
- 冲突零抹平（程序校验 + 视图数据在位）；prompts 恒等断言全绿。

## 具体验证命令和期望结果

- `npm test -- --maxWorkers=1` → 全量绿；
- `npm run typecheck` / `npm run lint` / `npm run format:check` /
  `npm run build` / `git diff --check` → 全部退出码 0；
- dev + 生产冒烟默认矩阵（含 8.18）退出码 0。

## 完成定义

红→绿证据回填 + 8.18 通过 + 全量验证全绿 + diff 终检 + progress.md 更新 + 逻辑提交（feat: C6 …）+ 双远程推送。

## 风险与停止条件

- sourceTypes 判定与候选 trust 语义冲突（官方/第三方分类不可靠）→ 停止
  并校准本文 §7.1 判定规则（保守默认不虚构）；
- 合成提示词导致模型在真实场景系统性不报冲突 → 属语义层残余风险
  （threat-model §5 第 9 类），如实登记不宣称免疫；结构面（冲突模型/
  程序校验）不得放宽。

## 提交边界

逻辑提交；不夹带 C7/C8 代码。

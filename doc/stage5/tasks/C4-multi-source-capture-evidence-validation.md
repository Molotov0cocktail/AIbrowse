# C4 — 多源读取、结构化提取、capture 记录和 Evidence 确定性验证

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §5；安全契约
> `doc/stage5/threat-model.md` §3.3/§3.4（FT-03/04/05/06 核心防线）。

## 目标

落地 CaptureService（task Tab 读取/结构化提取/capture 记录，正文不持久化）
与 EvidenceValidator（模型只提引用、程序验证来源存在/捕获归属/摘录与坐标
来自捕获内容）——Research 证据链的确定性验证核心。

## 范围与非目标

- **做**：CaptureService.read（http/https 白名单 → Workspace Tab →
  loadURL → ready 轮询 → getPageSnapshot 实时采集 → 结构化提取章节/表格
  坐标/字段路径 → capture 记录组装：contentHash/documentId/accessTime
  主进程盖章/summary/失败语义与重试 ≤1 次）；EvidenceValidator.verify
  （归属校验/来源存在/摘录规范化匹配/表格坐标边界/字段路径存在/
  rejected 原因回注）；正文内存保留至任务终态（零落盘）。
- **不做**：Runtime 编排（C5）；claims/冲突（C6）；Renderer（C7）；
  修改 PageSnapshot 采集管线（不新建采集通道——Fifth_stage 约束）；
  search/source 服务修改。

## 涉及模块和输入文档

- 新增 `src/main/research/capture-service.ts`、
  `src/main/research/evidence-validator.ts` + 测试。
- 输入：detailed-design §5；threat-model §3.3/§3.4；PageSnapshot/
  SnapshotMeta 契约（shared/types/browser.ts，本会话核对）；C2 Workspace
  接口；snapshot-normalize 同族清洗函数复用。

## 预计修改文件

- 新增：`src/main/research/capture-service.ts`、
  `src/main/research/evidence-validator.ts` + 同名 `*.test.ts`。
- 既有文件零改动（冒烟 8.16 夹具归本任务新增于 smoke.ts 的**新场景**——
  既有场景零改动；若 smoke.ts 需新入口函数，只增不改）。

## 依赖

C1（Capture/Evidence 类型与预算）、C2（Workspace）、C3（候选形状）。

## 红→绿步骤

1. **红**：先写测试——capture-service（读取失败矩阵/重试语义/L0–L3 阶梯/
   正文不持久化存储探针/contentHash 确定性/表格坐标与字段路径提取/超预算
   截断）；evidence-validator 敌手矩阵（伪造摘录/错绑 captureId 跨任务/
   坐标越界/超长 excerpt/规范化匹配（NFC/空白折叠/控制字符）/rejected
   原因回注/幂等）。旧结构（无模块）全部失败。
2. **绿**：实现两模块（Workspace/浏览器注入替身 + 真实快照夹具）；
   逐用例转绿。
3. **冒烟 8.16**（smoke.ts 新场景，dev+生产双场景）：受控页夹具 →
   真实 BrowserController 快照 → capture 记录断言（documentId/哈希/
   accessTime 主进程盖章）→ FakeProvider 提出正确引用 verified / 伪造・
   错绑・越界 rejected → 读取失败页 failedReadCount 继续 → 正文零落盘
   （userData 字节扫描）。
4. 全量回归 + 红线扫描。

## 验收标准

- §5.1/§5.2 全部规则单测 + 冒烟 8.16 双场景通过；
- 未验证引用不渲染/不进集合/不落库（单测 + 冒烟断言）；
- capture 正文零落盘（存储探针字节级）；Evidence 元数据全部主进程生成。

## 具体验证命令和期望结果

- `npm test -- --maxWorkers=1` → 全量绿；
- `npm run typecheck` / `npm run lint` / `npm run format:check` /
  `npm run build` / `git diff --check` → 全部退出码 0；
- dev + 生产冒烟默认矩阵（含 8.16）退出码 0。

## 完成定义

红→绿证据回填 + 8.16 双场景通过 + 全量验证全绿 + diff 终检 + progress.md
更新 + 逻辑提交（feat: C4 …；smoke 8.16 可与主体同提交或独立提交）+
双远程推送。

## 风险与停止条件

- PageSnapshot 结构不支持表格坐标/字段路径提取 → 停止并报告（不得新建
  采集通道绕过；重新评估 locator 设计走 §15 决议流程）；
- 规范化匹配误判（正当摘录被拒）→ 校准规范化函数与测试（不放宽到
  「包含即通过」；语义层残余风险维持 threat-model §5 登记）。

## 提交边界

逻辑提交；不夹带 Runtime/综合层代码。

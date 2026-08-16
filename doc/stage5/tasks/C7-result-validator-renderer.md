# C7 — ResultValidator + 安全 Markdown/Table/Cards/Ranking Renderer

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §8（已按决议
> #148–#152 校准）；安全契约 `doc/stage5/threat-model.md` §3.5（FT-11/FT-12）；
> 决策 D9（proposal §10，已按决议 #148 校准 Markdown 表格漂移）。
> **实施前契约裁决 #148–#155 已完成（2026-08-16，C7 闭环）**——本文档已
> 按裁决同步。
> **C5 端口契约校准（决议 #134）**：result-validator 实现
> `ResearchResultValidationPort.validate`（端口精确形状见 detailed-design
> §15 决议 #134——C5 已冻结，C7 按此实现，§8.1 校验规则不变）。
> **C6/C7 分阶段装配边界（决议 #140）**：C6 完成时不解除生产 fail-closed；
> **C7 完成时才统一装配真实 C6+C7 端口并解除 fail-closed**（决议 #155：
> 新建窄职责生产 factory 模块 `research-runtime-factory.ts`；index.ts
> 装配顺序调整——Research store 移至 Sources/SearchProvider/ConfigStore/
> CredentialStore 之后；C6 冒烟注入的严格 C7 stub 不得装入生产）。
> **数据交接契约（决议 #145 + #149/#151）**：
> `ResearchResultValidationContext` 已新增 claims/conflicts/
> verificationState/now 字段（validate 签名不变，只扩充 context）——C7 据此
> **程序重算 coverage**（从 ctx.claims 计数，不采信模型草案）、核对
> Result.conflicts 与 ctx.conflicts 一致（程序投影）、实施 uncertainty 强制
> 规则（#151(5) 五条件矩阵）、程序组装 resultId/taskId/evidenceMap/
> conflicts/coverage/fetchedAt（模型草案仅 {title, summary, blocks}）。
> **Factory 接口窄幅修改（决议 #154(7)）**：ResearchRuntimeFactory 改为
> `resolveProvider(): Promise<ResearchPreparedLaunchResult>` +
> `ResearchPreparedLaunch{launch/release}`（prepared 绑定单次 start、恰好
> 一次消费、放弃路径释放——等价竞态证明见决议 #154）。

## 目标

落地 ResultValidator 纯函数（模型草案三字段白名单 + 闭合判别联合逐块
校验 + 程序组装全部可信字段，实现 ResearchResultValidationPort.validate
端口——决议 #134/#149/#150/#151）与安全 Renderer（shared 受控 Markdown
子集解析器 + Table/Cards/Ranking ResultView 组件——决议 #148/#152）——
**零新依赖**；同时完成真实生产装配（决议 #155：生产
research-runtime-factory + index.ts 装配顺序调整，解除生产
fail-closed——决议 #140）、logger 未初始化落盘修复（#153）与
ResearchService 启动预占（#154）。Renderer 只消费已验证 Result Schema，
不接触 BrowserController/SQLite/Electron/Provider。

## 范围与非目标

- **做**：result-validator（§8.1/#150 全部校验：kind 白名单/形状/长度
  边界/表格行列严格一致/rank 连续 1..N/sourceRefs 非空去重有界 ∈ 候选集
  且有 verified Evidence 支撑/URL 白名单（绝对 http/https 无 userinfo）/
  强制 uncertainty 矩阵/总大小 200k/失败语义回注——零敌对正文回显）；
  shared markdown 解析纯函数（`src/shared/markdown/`，§8.2/#152 子集：
  标题 1-3/段落/斜粗体/行内代码/列表/引用/代码块/链接（http/https）——
  Markdown 表格不实现（决议 #99/#148）；AST 有界降级；单遍线性扫描防
  ReDoS）；ResultView 渲染纯组件（Table/Cards/Ranking/uncertain/markdown
  - Evidence 下钻数据映射；零 dangerouslySetInnerHTML、零 `<a href>`、
    onOpenUrl 回调预留）+ react-dom/server 静态渲染测试；生产 factory
    （research-runtime-factory.ts：真实 SearchProvider/SourceService/
    BrowserController/Provider config+credential 解析/C6/C7 真实端口）+
    index.ts 装配顺序调整 + RESEARCH_RESULT_VALIDATION_PORT 冻结端口对象；
    logger 未初始化落盘修复（#153，红→绿）；ResearchService starting slot
    预占与 prepared Provider 交接（#154，红→绿）；冒烟 8.19-A
    （C7 validator/renderer 静态渲染 + 生产 factory 主进程闭环，dev+生产
    双场景）。
- **不做**：Research 侧栏/结果画布布局接线（C8）；CSV（C8）；表格排序/
  筛选/复制（C8）；新 IPC；App UI DOM 场景（8.19-B 保留给 C8）；
  Timeline/Chart；安装任何渲染库（决策 D9 红线；如需变更走 §15 决议
  流程）。

## 涉及模块和输入文档

- 新增 `src/main/research/result-validator.ts` + 测试；
  `src/main/research/research-runtime-factory.ts` + 测试；
  `src/shared/markdown/parse-markdown.ts` + `markdown-url.ts` + 测试；
  `src/renderer/src/research/ResultView.tsx` + `ResultView.test.ts`
  （Node 环境 react-dom/server——不扩大 Vitest include）。
- 修改：`src/shared/types/research.ts`（ResultDraft/ResearchResolveErrorCode/
  ResearchPreparedLaunch 等新类型 + `now` context 字段 + Validator 常量）、
  `src/main/research/research-service.ts`（starting slot/#154）、
  `src/main/logger.ts`（#153）、`src/main/synthesis/research-prompts.ts`
  （#149(4) synthesis prompt 校准 + 恒等断言同步）、
  `src/main/index.ts`（决议 #155：装配顺序 + 真实闭包注入）、
  `src/main/smoke.ts`（8.18 用真实 C7 端口 + 8.19-A + factory stub 形状
  校准）。
- 输入：detailed-design §8/§15（决议 #99/#134/#140/#145/#148–#155）；
  threat-model §3.5；proposal §5（官方资料核查结论）。

## 依赖

C1（Result Schema 类型）、C5（端口形状 + Runtime 数据交接 + Service 异步
装配）、C6（claims/conflicts/verificationState 快照 + research-prompts
常量 + RESEARCH_SYNTHESIS_PORT）。

## 红→绿步骤

1. **红**：先写测试（模块缺失红 + 旧结构红）——
   - result-validator 敌手矩阵（合法 markdown/table/cards/ranking/
     uncertain/每层未知字段/prototype/constructor/**proto**/非法类型/
     重复 ID/sourceRefs 跨 task·无 Evidence·rejected Evidence·重复·过量/
     conflicts/evidenceMap/coverage/fetchedAt/resultId 不受模型控制/
     fetchedAt Evidence 最大时间与无 Evidence fallback/强制 uncertainty
     全矩阵/表格行列不一致·超宽超长/ranking 非连续/总大小 ±1/UUID v4
     非法·冲突·工厂异常/错误报告零敌对正文）；
   - shared markdown 解析矩阵（全部允许语法/Markdown 表格不解析/raw
     HTML·script·img·onerror 纯文本/javascript:·data:·file:·about:·
     userinfo 链接/未闭合 fence·marker/深嵌套/大量 token/边界长度/输出
     确定性/输入不变/AST 节点有界）；
   - ResultView 静态渲染（Node 环境 react-dom/server +
     React.createElement；敌对 HTML 只出现为转义文本/输出零可执行
     script·img·onerror·style/危险 URL 零 href/table·cards·ranking·
     evidence·uncertain 稳定渲染）；
   - logger（未 init 时写多级日志不产生 cwd 文件——真实临时 cwd 探针/
     getCurrentLogFilePath 未 init 返回 ''/init 后只写指定目录/re-init
     后不继续写旧目录/换行伪造与 Key 脱敏保持有效）；
   - service/factory（deferred resolve 下两个并发 start 只有一个占槽/
     shutdown-during-resolve 后零 DB 写入·零 Runtime launch·零未处理
     rejection/Provider 解析失败 task 仍 created/prepared provider 只能
     由对应 run 消费一次/缺配置·缺 Key·不支持 tools·Sources recovery/
     unavailable 精确错误/FakeProvider 通过与生产相同的 factory 代码路径
     完成任务/Result+completed 原子提交与 500k 预算保持/终态后 Workspace
     cleanupAll·用户 Tab 集合逐项恒等）。
2. **绿**：实现各模块 + 组件 + Service/factory/logger 修复；逐用例转绿。
3. 冒烟 8.19-A（dev+生产双场景）+ 8.18 改接真实 C7 端口。
4. 全量回归 + 红线扫描（renderer 零 dangerouslySetInnerHTML 实际使用
   断言；零新依赖——package.json/lockfile 零 diff；工具注册表仍 17；
   AgentLoop 12/420s 零变化；根目录 aibrowse-*.log 测试后零生成）。

## 验收标准

- §8 全部规则单测覆盖（决议 #148–#152）；渲染输出纯 React 元素（无 HTML
  字符串拼接）；Validator 与 Renderer 同源常量（表格行列界等——shared
  单一事实源）；失败语义（整体拒绝 + 回注）单测固化；
- #153 红→绿（真实临时 cwd 探针 + 完整测试后根目录零日志文件）；
- #154 红→绿（并发 start 占槽/shutdown 竞态/prepared 恰一次消费）；
- #155 生产 factory 真实依赖接线（FakeProvider 经同一生产 factory 路径
  完成；缺 Provider/Sources 精确错误）；8.18 使用真实 C7 端口；
  8.19-A dev+生产双场景退出码 0；
- 生产 startTask 不再固定返回 research-runtime-unavailable；
  AIBROWSE_RESEARCH_SMOKE=set|check 双进程零回归。

## 具体验证命令和期望结果

- `npm test -- --maxWorkers=1` → 全量绿（测试后根目录零 aibrowse-*.log）；
- `npm run typecheck` / `npm run lint` / `npm run format:check` /
  `npm run build` / `git diff --check` → 全部退出码 0；
- dev + 生产冒烟默认矩阵（含 8.18 真实端口 + 8.19-A）退出码 0；
- `AIBROWSE_RESEARCH_SMOKE=set|check` 双进程退出码 0（生产产物）；
- `git diff package.json package-lock.json` → 零改动（零新依赖断言）。

## 完成定义

红→绿证据回填 + 全量验证全绿 + diff 终检 + progress.md 更新 + 逻辑提交
（docs: 裁决 C7 契约 / fix: logger / fix+feat: 生产装配 /
feat: 完成 C7 Validator 与 Renderer / docs: 回填证据）+ 双远程推送。

## 风险与停止条件

- 自实现 Markdown 子集解析器在合法输入上出现歧义/安全漏洞 → 停止并
  报告（不得静默放宽到安装库；重新评估走 §15 决议流程，备选
  react-markdown 记录在案）；
- Validator 校验异常 fail-closed 不抛穿（任何敌手输入安全返回拒绝）；
- 生产 factory 无法与真实依赖（SearchProvider/SourceService/Provider
  resolution）无损接线 → 停止并报告（不得伪造接线、不得放宽
  fail-closed）。

## 提交边界

逻辑提交；不夹带 C8 UI 布局/交互/IPC/CSV。

## 红→绿证据

- **红态**（2026-08-16，模块缺失/旧结构）：
  - 7 个新测试文件红态（shared/markdown ×2、result-validator、
    ResultView、research-runtime-factory、preemption 模块缺失 +
    logger #153 新用例在旧实现下真实失败 + 旧 factory 形状 typecheck 红）
    ——红态 7 files failed / 9 failed（vitest 输出实证）；
  - **logger 缺陷红态机器证据**：基线测试前根目录无 aibrowse-*.log →
    基线测试后生成 `aibrowse-2026-08-16.log`（旧实现以 `logDir=''` 拼
    相对路径写 cwd——决议 #153(1)）；
  - 旧 Service 无 starting 预占（resolveProvider await 前零占槽）——
    并发 start 红态失败；旧 resolveProvider/launch 分离接口 typecheck 红。
- **转绿**：实现 shared/markdown（url 判定/文本规范化/解析器——单遍线性
  扫描 + 有界栈）、result-validator（#149–#151 全部规则 +
  RESEARCH_RESULT_VALIDATION_PORT）、ResultView（react-dom/server
  静态渲染矩阵）、logger #153 修复、ResearchService starting slot +
  prepared 接口（#154）、生产 research-runtime-factory（#155）+ index.ts
  装配顺序调整 + smoke 8.18 真实端口/8.19-A 后——
  C7 聚焦 **172/172**（markdown 26 + validator 45 + ResultView 9 +
  logger 17 + preemption 8 + factory 7 + service/store/prompts 回归）；
  全量 **1964/1964**（基线 1865 + 99 新增；既有用例零删除零削弱——async/
  service 测试 factory stub 按决议 #154(7) 新接口机械校准，注入语义不变）。
- **logger 修复后机器证据**：修复后多次全量测试根目录日志文件零写入
  （mtime 保持修复前最后写入时刻）；未 init 状态真实临时 cwd 探针零文件；
  re-init 不写旧目录（单测固化）。
- **冒烟 8.18/8.19-A**（默认矩阵自动包含；dev+生产双场景退出码 0）：
  8.18 真实 C7 端口（不再注入 C7 stub）——第一轮含伪造可信字段草案被
  真实 Validator 整份拒绝 → 回注重提第二轮三字段草案 → completed；8.19-A
  生产 factory 主进程闭环——FakeProvider 经 createProductionResearchRuntime
  Factory（真实 config/credential resolution + 真实 C6+C7 端口）经
  ResearchService.startTask → completed + 可信字段程序生成 + 危险链接
  草案拒绝重提 + 缺 Provider 配置精确拒绝 + 用户 Tab 恒等。
- **红线扫描台账**：migration v1 零改写；新模块零 SQL（parse-markdown
  `.exec` 为正则非 SQL）；renderer/preload 零 SQL；零
  dangerouslySetInnerHTML 实际使用（仅注释）；零 shell/child_process/eval；
  工具注册表仍 17、AgentLoop 12/420s 零改动（diff 断言）；package.json/
  lockfile 零 diff；真实 Provider 调用 **0 次**（无真实 Provider 产品
  链路——FakeProvider 经生产 factory 路径，决议 #117 长期授权不等于
  强制无关调用）。
- 验证命令：`npm test -- --maxWorkers=1` **1964/1964** 绿（测试后根目录
  零新增日志）；typecheck/lint/format:check/build/diff-check 绿；dev +
  生产默认冒烟（含 8.18 真实端口 + 8.19-A）退出码 0；
  `AIBROWSE_RESEARCH_SMOKE=set|check` 双进程退出码 0/0。

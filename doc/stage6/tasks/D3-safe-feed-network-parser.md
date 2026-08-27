# D3 — XML/HTML 依赖资格门、公开网络、Feed 与公开页面流式通道

## 目标

完成 `@federicocarboni/saxe@0.8.0` 和 `parse5-sax-parser@8.0.0` + `parse5@8.0.1` 双资格门；
只有分别通过后才精确安装并实现公网 GET/HEAD、DNS/redirect/robots、Feed Discovery/RSS2/Atom，
以及公开 HTML→DocumentChannels 的零执行流式通道。D3-R2 在不更换 parser/依赖的前提下修正
robots 响应预算、IPv6 普通公网 allowlist、robots 强制安全装配、单资源网络总 deadline 与 RFC 9309
octet 匹配；R2 未经新的独立安全 Reviewer `PASS` 前 D3 不完成、D4 不开始。

## 范围与非目标

- **做**：两组候选 tarball/许可证/维护/供应链/Node24/Electron 构建核验；XML/HTML 敌手与兼容语料；
  Node 核心 http/https 连接时 lookup；仅 HTTP 80/HTTPS 443 的 NetworkPolicy/RobotsPolicy；
  SAX Feed Discovery；FeedProjection；
  公开 HTML SAX→有界 DocumentChannels，零脚本/子资源/Cookie；D3-R2 五项正式安全修订。
- **不做**：页面 Session、Scheduler、watch.db、Event/Digest/UI；不实现通用 HTTP；不支持登录 feed；
  解析失败不浏览器 fallback；D3-R2 不改 Feed/HTML parser，除非能证明与五项根因不可分割并先停止
  返回 Planner；不新增网络/解析依赖。

## 涉及模块和输入文档

- `package.json/package-lock.json`（各资格 PASS 后才精确改）；`src/main/watch/network-*`、robots、feed-*、
  `public-html-sax-reader.ts`；
  `src/shared/watch/diff/feed-*` 类型/规范化辅助及测试。
- 输入：detailed §2/§6/§7；threat-model WT-01～WT-08、WRT-01～WRT-08。

## 预计修改文件

- 精确新增 `@federicocarboni/saxe@0.8.0`、`parse5-sax-parser@8.0.0`、`parse5@8.0.1` 及 lockfile；
  不允许其他 XML/HTML/feed 依赖。
- 新增上述 watch network/feed 模块、测试语料 manifest；测试生成物使用受控临时目录且不提交敌手大文件。

## 实施步骤（红→绿）

1. **资格门**：只读/临时隔离核验两组 package、许可证、依赖、构建；XML 运行 DTD/XXE/bomb/depth/
   name/attribute/text-node/node/total-text/Projection/encoding/RSS/Atom；HTML 运行
   malformed/depth/node/attribute/script/iframe/subresource/cookie corpus。
   任一失败立即 REPLAN，禁止安装/换库。
2. 红：NetworkPolicy、受控 DNS/redirect server、robots、Parser/Discovery 模块缺失或旧结构失败。
3. 绿：纯 Policy → 连接时 lookup 客户端 → robots → XML parser/Feed → HTML SAX discovery/DocumentChannels。
4. 证明超限 destroy、零外部 entity/file/network、后续正常请求仍可用、日志零正文。
5. 全量、build、`npm audit`、license、package diff、自审和安全 Reviewer。
6. **D3-R2**：先在 repair HEAD `dd3deeb` 上建立五组能甄别旧实现的红态 oracle；再按
   robots 512,000 bytes → IPv6 IANA allowlist → 安全工厂/强制 gate → 单资源总 deadline → RFC 9309
   octet 匹配的顺序最小修复。不得删除/放宽既有有效测试，不得触碰 D4/D5。

## 验收标准与测试

- WRT-01～WRT-08/WRT-19 对应项聚焦全绿；初始与每跳 scheme/host/port/IP/DNS/downgrade 独立断言，
  省略端口/显式默认端口接受，所有非默认端口零 socket。
- RSS2/Atom/namespaces/CDATA/encoding/重复 identity/304/ETag/Last-Modified 有稳定 oracle。
- DTD/entity/XInclude 零文件/网络；2 MiB 与 XML depth/name/attribute-count/attribute-bytes/text-node/nodes/
  total-text/FeedProjection 每项 `== MAX` 接受、`MAX+1` fail-closed，零假 Projection。
- HTML 零 JavaScript/WebContents/子资源/Cookie；2 MiB/20k node/64 depth/64 attrs fail-closed。
- Robots 独立 `MAX_ROBOTS_RESPONSE_BYTES=512_000`，identity/压缩与解压后 `==MAX` 接受、
  `MAX+1` destroy + `budget_exceeded`；不得引用 `MAX_DISCOVERY_HTML_BYTES`；规则数 1,024 边界保持。
- IPv6 只允许 detailed §6.1 冻结的 IANA 已分配普通 GUA；`3fff::/20`、`2001:db8::/32`、
  `2001:2::/48`、`fec0::/10`、未列的 `2000::1` 与 IANA `RESERVED` 的 `2d00::1` 均
  security_rejected 且零 socket；已分配普通公网正例仍可达测试 socket。
- `target-gated` 缺 RobotsGate 的 page/feed/discovery 零 DNS、零 socket 并 unavailable；安全工厂是唯一
  产品构造入口，raw、constructor 与任意 URL 测试 seam 均不导出。初始 robots URL 只由目标 authority
  派生为无 query/fragment 的 `/robots.txt`；伪造 `purpose=robots` + 任意 host/path/query 零 DNS、零
  socket；raw 内部 redirect 逐跳复验、继承同一 deadline；每跳 robots deny 时目标零 socket。
- 30 秒从单次 `get/head` 入口覆盖 DNS、robots、全部候选地址、redirect 和响应体，并与外部 deadline 取
  更早者；Invalid Date/已过期 deadline 零 DNS、零 socket，外部 deadline 晚于内部 30 秒仍以内部截止；
  无响应 socket、静默 body、多地址连续失败与 redirect 链不得获得新 30 秒，迟到事件不得改变终态。
- RFC 9309：fatal UTF-8 是文件级 unavailable；CR/LF/CRLF 与 RFC 结构位置的 SP/HTAB 合法。其它原始
  control、ABNF 错误与 malformed/truncated percent triplet 只隔离所在行并继续使用其它 parseable rules；
  percent-encoded unreserved ASCII 解码，reserved、非 unreserved ASCII（含 `%00`）与非 ASCII octet
  保持规范化 percent 编码身份；相同 UA 组合并、空 specific 组不回退 `*`，并保持 `*`、末尾 `$`、
  最长 octet 与等长 allow。
- package 仅批准的三个精确直接依赖；Node24、dev/production build 全绿；全量验证全绿。

## 完成定义

资格报告回填本任务；D3 与 D3-R1 历史证据保留；D3-R2 先红后绿并创建新的 local repair commit；
新的独立安全 Reviewer PASS 后才允许 Closer 更新 progress/关闭 D3；不得 amend/reset/重写候选历史、
不得 push、不得接线 Scheduler。

## 依赖与停止条件

- 依赖 D2 类型/预算。D4/D7/D10 依赖本任务；D3-R2 Reviewer PASS 前 D4 不得开始。
- 任一候选资格失败、需要换包/自研 parser、需要代理/认证/POST、无法连接时约束 DNS、robots/真实规范冲突时停止 REPLAN。

## 资格门报告（2026-08-26，发生在仓库安装之前）

两组候选均在外仓库受控临时目录 `%LOCALAPPDATA%\Temp\opencode\d3-gate\{xml,html}` 完成
资格门，全部 PASS 后才执行 `npm install --save-exact`。临时目录已精确清理。

### XML：`@federicocarboni/saxe@0.8.0` = PASS

- **tarball/integrity**：`npm pack` shasum `9b508f864fba2db72058955709b9c8661c083663`、
  sha512 `l3KPI+js9P3blZUxTxWOIDzMbsedfnRwYBzuKSG5RbsYRAJF0tOmbK9pmi4+s+7wGiv4BkjseyWYLLm3YRCThw==`
  与 registry `dist.integrity`/`dist.shasum` 一致；11 文件（LICENSE/README/lib/*.js+map+d.ts）。
- **license**：Apache-2.0（LICENSE 全文本在包内）。
- **供应链**：单一 maintainer `federicocarboni`；`latest=0.8.0`；零运行时依赖；无 install scripts、
  无 native addon、无 bin。
- **Node24/Electron 构建**：ESM-only（`type:module`，exports 仅 `import`，无 `require`/`default` 条件）
  → 主进程 CJS + `externalizeDepsPlugin` 下 **`require()` 会 `ERR_PACKAGE_PATH_NOT_EXPORTED`**；
  验证 rollup CJS 输出保留动态 `import()`，在 Node v24.18.0 与 Electron 43.4.0（Node 24.18.1）下
  动态导入 + 敌手 DOCTYPE fail-closed 均通过。实现采用 `await import('@federicocarboni/saxe')`。
- **兼容/敌手**（node 直跑 gate 脚本，28 项）：RSS2/Atom/namespace URI+localName（不信任前缀）/
  CDATA/UTF-8/UTF-16LE-BE BOM/windows-1252/ISO-8859-1/流式分块全过；DOCTYPE/ENTITY/外部 DTD/XXE/
  Billion Laughs/未知实体 → 抛错；**XInclude 惰性零解析（仅验证零文件/网络，未验证正式契约的
  security_rejected 语义——该缺口由 D3-R1 修复，见下文「D3-R1 修复记录」）**；depth 64==接受/65
  拒绝、maxNameLength、maxAttributesLength、maxTextLength 均按配置生效；零
  `require`/`node:fs`/`node:http`/`fetch` 引用（注释剔除后字节扫描）。
- 运行时语义发现：saxe 对 handler 方法**无条件调用**（类型标可选但运行时必需全提供）；
  `maxAttributesLength` 按 code unit 且 `== max` 即拒绝（与项目 UTF-8「== 接受」语义冲突，
  故作为 2× 粗防线回退，权威 oracle 为本项目 handler 的字节检查）；属性名也受 `maxNameLength` 约束。

### HTML：`parse5-sax-parser@8.0.0` + `parse5@8.0.1` = PASS

- **tarball/integrity**：parse5 shasum `f43bcd2cd683efe084075333e9ce0da7d06da31e`、sha512
  `z1e/HMG90obSGeidlli3hj7cbocou0/wa5HacvI3ASx34PecNjNQeaHNo5WIZpWofN9kgkqV1q5YvXe3F0FoPw==`；
  parse5-sax-parser shasum `49755efbd2b63846c7b908a297a874af00760715`、sha512
  `/dQ8UzHZwnrzs3EvDj6IkKrD/jIZyTlB+8XrHJvcjNgRdmWruNdN9i9RK/JtxakmlUdPwKubKPTCqvbTgzGhrw==`
  均与 registry 一致。
- **license**：MIT（两包均含 LICENSE 全文本）。
- **供应链**：parse5 项目（inikulin/wooorm/fb55/43081j/rreverser 多维护者、2013 年起）；
  parse5 零依赖；parse5-sax-parser 仅依赖 `parse5@^8.0.0`（npm 去重到本项目固定 8.0.1）；
  无 install scripts/native/bin。
- **Node24/Electron 构建**：ESM-only 但 exports 含 `default` 条件 → 主进程 CJS `require(esm)`
  在 Node 24.18.1/Electron 43 下直接可用（CJS require + ESM import 双验证通过）。
- **兼容/敌手**（node 直跑 gate，18 项 + 注释剔除字节扫描）：malformed 容错/未闭合自动闭合/
  mis-nesting/文本/属性/script raw text/style/iframe/object/embed/form/input 事件/危险 base/link/
  doctype/分块流式/深 64/20k 节点/64 属性/超长属性值全过；script/iframe 内容零执行、Cookie canary
  零逃逸；剔除注释后零 `http.get`/`fetch(`/`node:http`/`node:fs`/`net.connect`/`XMLHttpRequest`/
  `require(`/`import(`。
- 注意：parse5 把 HTML NUL 替换为 U+FFFD；void 元素（input/embed/img/br…）SAX 只发 startTag 无
  endTag，reader 按 void 集合不入栈。

### 供应链/许可小结

- 直接依赖精确固定：`@federicocarboni/saxe@0.8.0`、`parse5@8.0.1`、`parse5-sax-parser@8.0.0`；
  传递依赖仅 `entities@8.0.0`（BSD-2-Clause，parse5 tokenizer 实体解码所需，fb55 生态）。
- `npm audit`：0 vulnerabilities（安装前后均 0）。
- lockfile diff 仅新增上述 4 个包，无既有条目变更/删除。

## 红→绿证据

- **红**：baseline `9f33de2` 下 `src/main/watch/` 不存在；所有 D3 模块 import 即失败（模块缺失）。
- **绿**（聚焦 `src/main/watch src/shared/watch`）：335/335 通过；全量 `npm test -- --maxWorkers=1`
  2602/2602（baseline 2440 + D3 新增 162）。
- 验证门：typecheck ✓、lint ✓、format:check ✓、build ✓、npm audit 0、`AIBROWSE_SMOKE=1`
  dev（exit 0）与 production `npm run start`（exit 0）全过；真实 Provider NOT RUN（D3 无 Provider 路径）。

## WRT-01～WRT-08/WRT-19 对应（D3 部分）

| ID     | D3 机器断言                                                                                                      | 证据                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| WRT-01 | localhost/127/::1/私网/link-local/组播/保留 URL 零 socket + security_rejected                                    | network-policy.test + client「零 socket」                       |
| WRT-02 | 公私混合/连接时换绑整次拒绝；sealed lookup 只返回已批准地址                                                      | client lookup 断言 + sealed lookup                              |
| WRT-03 | 非 80/443、每跳 redirect 私网/file/js/HTTPS→HTTP 拒绝、零后续请求                                                | client redirect 套件                                            |
| WRT-04 | 慢流/deadline/压缩炸弹/Content-Length/字节边界受控失败后进程与后续请求可用                                       | client 预算/超时套件                                            |
| WRT-05 | robots 判定（UA/allow/disallow/最长匹配/缓存 24h/fail-closed）                                                   | robots-policy.test；**同 host 5 秒共享运行门属 D5，不在本任务** |
| WRT-06 | XXE/外部 DTD/XInclude/Billion Laughs 零文件/网络、后续正常 feed 可解析                                           | feed-parser.test 敌手套件                                       |
| WRT-07 | depth/name/attr-count/attr-bytes/text-node/nodes/total-text/Projection 每项 == MAX 接受、+1 fail-closed          | feed-parser.test 边界套件                                       |
| WRT-08 | 重复/冲突 identity 去重稳定、字段超长截断标记、feed 重排确定性、200/201 截断                                     | feed-parser.test identity/truncation 套件                       |
| WRT-19 | HTML script/iframe/子资源/Cookie canary 零执行/请求、2 MiB/20k node/64 depth/64 attrs/64 KiB Projection 精确边界 | public-html-sax-reader.test + corpus（canary 逐字节零出现）     |

## D3-R1 修复记录（2026-08-26，Reviewer 待复验）

D3-R1 独立安全修复候选闭合正式契约在 D3 首次实现中遗留的公开网络与 Feed/HTML parser 缺口；
全部先红后绿，未删除/放宽既有有效断言（全量 2602 → **2646**，+44 新增）。候选未 push。

### 修复项与证据

1. **IPv6 R1 历史实现（WRT-01/02，已被 R2 否决）**：`network-policy.ts` 由「未在 denylist 即 public」
   改为放行整个 global-unicast `2000::/3` 再排除 site-local fec0::/10、文档段 2001:db8::/32、
   BMWG benchmarking 2001:2::/48、AMT/AS112/ORCHID/Drone、整个 2001::/23 IETF 保留块等；
   红态 fec0/2001:db8/2001:2 误判 public → 绿态 reserved；连接层 `[fec0::1]` 等字面量与混合
   DNS 均零 socket security_rejected。
2. **每跳 robots 先于 socket（WRT-05 每跳部分）**：`public-watch-http-client.ts` 新增窄
   `RobotsGatePort` seam；初始与每个 redirect host 在发起 socket 前完成 robots 决策，
   `purpose='robots'` 自身跳过（零递归）；gate 异常 fail-closed unavailable；disallowed →
   `robots_disallowed`。测试断言初始 host allowed 后 redirect 下一 host robots 拒绝时下一 host
   **零 socket**。这是 R1 历史行为，不是现行授权：R2 禁止公开调用方仅靠伪造 purpose 跳过 gate，
   并把 raw 初始请求收口到安全工厂内部派生的目标 authority `/robots.txt`。
3. **robots 匹配 RFC 9309（WRT-05）**：`robots-policy.ts` 实现 `*` 通配、结尾 `$` 锚点、最长匹配
   （按匹配消耗 octet 数，§5.2）与等长 allow 优先；线性贪心无正则（无 ReDoS 面）。**无缓存 304、
   跨 host robots redirect、解析异常一律 fail-closed 为 unavailable，不再退化为 allow-all**。
   这是 R1 历史策略；R2 已把“解析异常”拆为 fatal UTF-8 文件级失败与其它逐行错误隔离，禁止继续按
   该宽泛表述实现。
4. **timeout/deadline/abort 覆盖 DNS**：DNS lookup 与剩余 deadline、`timeoutMs`、abort 竞争；
   永不返回的 DNS 按时受控失败；`requestFactory` 同步 throw 转受控 unavailable；redirect/HEAD
   等不消费响应立即 `destroy()`（降级 resume 排空）。
5. **XML 安全（WRT-06）**：XInclude namespace（元素或 xmlns 声明）一经出现立即
   `security_rejected`（不再惰性接受）；Atom/RSS 核心字段（identity/title/link 等）同时校验允许
   namespace（Atom=ATOM_NS、RSS=无 namespace），扩展 namespace 同名元素不得覆盖核心字段；
   RSS 根带默认 namespace → parse_changed。
6. **编码 fail-closed（WRT-07）**：TextDecoder 改 `fatal:true`，非法 UTF-8/截断多字节/UTF-16
   奇数长度一律 parse_changed，不再以 U+FFFD replacement 掩盖。
7. **MAX_XML_NODES 覆盖 start element 与 text 事件（WRT-07）**：text 事件计入节点预算。
8. **完整编码投影预算（WRT-07/WRT-19）**：FeedProjection 与 PageProjection 字节预算改为以
   完整、确定性的 canonical encoded projection（JSON 固定键序）为准，==MAX 接受、MAX+1 失败；
   新增 `encodeFeedProjectionCanonical` 纯函数在 helper 级验证边界语义。
9. **依赖加载受控（WRT-06 相关）**：动态 import saxe 失败 → 受控 `dependency_unavailable`，
   不泄漏 promise rejection（`parseFeedXmlWithLoader` seam）。

### 诚实限制（如实记录，不冒充免疫）

- **FeedProjection MAX（262144）实际不可达**：受 `MAX_XML_TOTAL_TEXT_BYTES`（131072）约束，
  完整 canonical 编码的 feed 投影最大约 137KB（31×4096 字段 + 结构开销），故投影守卫为防御性
  正确实现；其 ==MAX/+1 边界语义由 `encodeFeedProjectionCanonical` 在 helper 级机器验证，
  端到端验证覆盖精确记账与最大文本 feed 接受。
- **每跳 robots 的 D5 装配**：`PublicWatchHttpClient` 默认不注入 robots gate（D3 无
  Coordinator）；D5 装配必须把 `RobotsPolicy` 接入客户端，否则每跳 robots 不生效——**该描述已被
  D3-R2 正式契约否决并取代**：缺 gate 必须 fail-closed，D3 自己交付安全工厂；D5 只装配 HostRequestGate/
  并发/5 秒间隔。

### D3-R1 验证门（候选本地全绿）

- D3 聚焦（watch 全部）**379/379**；全量 `npm test -- --maxWorkers=1` **2646/2646**（+44）；
  typecheck ✓、lint ✓、format:check ✓、build ✓、npm audit 0、`git diff --check` 退出码 0。
- 工作区仅含上述 12 个范围内文件；临时探针已清理；候选提交未 push，交由新独立 Reviewer 复验。

## D3-R2 Replacement Execution Contract（2026-08-27）

本节与 detailed-design #S6-038～#S6-042 是待独立安全 Reviewer 审批的完整替代契约；上方资格报告、
原始候选和 D3-R1 记录只作为不可改写的审计历史。Reviewer `PASS` 前不得生成或交付 Executor 实施
prompt，不得开始产品实现或 D4。

### TASK

在保持 D3 原始候选与 D3-R1 审计链不变的前提下，修复 `dd3deeb` 中五类安全根因：robots 独立响应
预算、IPv6 普通公网 GUA 判定、安全 robots 装配、单资源网络总 deadline、RFC 9309 逐行 parser/octet
matcher；先建立可甄别 `dd3deeb` 的红态测试，再做最小实现并交给新的独立安全 Reviewer。

### BASELINE

- 分支：`main`。
- D3-R2 实现 baseline：`dd3deebce8a23cd68e7afac0f7c6dd21f2ca382b`。
- D3 实施前 baseline：`9f33de2824a5b6a701228bbfad6f4fcbbdeb15b3`。
- 原始候选：`662ef0b42a1078c270ad18904038eb1e96e7d29b`。
- `662ef0b` 与 `dd3deeb` 均是不可改写的本地审计历史；禁止 reset/amend/rebase，Reviewer 以
  `dd3deeb..新 repair HEAD` 审查 R2，以 `9f33de2..新 repair HEAD` 复核 D3 总范围。

### GOAL

交付一个默认 fail-closed、网络能力不可伪造、时间/响应/规则/内存均有界的 D3 Public Watch 栈：
page/feed/discovery 必经 RobotsPolicy；robots 获取只可从目标 authority 的 `/robots.txt` 起步；IPv6 仅
放行冻结的 IANA 普通 GUA；一次目标资源获取的所有 DNS/robots/地址/redirect/body 共用 30 秒更早截止；
robots 文件按 RFC 9309 使用 fatal UTF-8 文件门与逐行容错、规范化 octet 匹配。

### NON-GOALS

- 不开始 D4/D5/D6，不实现 Scheduler、HostRequestGate 装配、watch.db、Session、Diff/Event/Digest/UI。
- 不更换 XML/HTML parser，不新增网络或解析依赖，不修改 package/lockfile/corpus。
- 不修改 Feed/HTML parser；若实现者证明与本契约根因不可分割，先停止并返回 Planner，不得自行扩围。
- 不修改 `progress.md`、AGENTS.md 或其它正式文档，不调用 Provider，不 push。

### AUTHORITATIVE SOURCES

- `AGENTS.md` §2.1～§2.7、§3.1、§3.6、§7。
- `Sixth_stage.md`。
- `doc/stage6/detailed-design.md` §0、§2、§6、§7、§15、§16、§17（尤其 #S6-038～#S6-042）。
- `doc/stage6/threat-model.md` §3、WRT-01～WRT-08、WRT-19。
- 本任务文档本 Replacement Execution Contract；若上方 D3/D3-R1 历史描述与本节冲突，以本节和现行
  detailed/threat 契约为准。
- RFC 9309 §2.2、§2.2.2、§2.3.1.5、§2.5；IANA IPv6 Special-Purpose Address Registry 与 IPv6
  Global Unicast Address Assignments 当前冻结快照。

### CURRENT VERIFIED STATE

- Planner 接管时 `main` HEAD 为 `dd3deebce8a23cd68e7afac0f7c6dd21f2ca382b`；两个远程 `main` 均为
  `9f33de2824a5b6a701228bbfad6f4fcbbdeb15b3`，本轮禁止网络写入。
- Planner 工作区只允许本文件、`detailed-design.md`、`threat-model.md` 三份已批准契约修改；产品代码、
  测试、依赖和 progress 均未获 Planner 修改授权。
- `dd3deeb` 现状已由代码/测试独立检查：robots 仍复用 262,144-byte discovery 预算；IPv6 仍把大量
  `2000::/3` 未分配空间放行；RobotsGate 可缺省；地址/redirect 可重获 30 秒；robots 使用 JS string
  匹配并会让坏行或空 specific 语义偏离 RFC。既有聚焦测试全绿不构成 R2 验收，因为缺少下述红态 oracle。
- 三个 parser 直接依赖的精确版本保持既有状态，本轮不重新资格化或升级。

### FIXED DECISIONS

1. **Robots 响应预算**：`MAX_ROBOTS_RESPONSE_BYTES=512_000`；identity/on-wire compressed 与解压后
   任一累计 `512,000` 可接受，读到第 `512,001` byte 立即 destroy 并 `budget_exceeded`。不得复用
   `MAX_DISCOVERY_HTML_BYTES`；1,024 parseable rules、总 deadline 与仅内存约束同时生效。
2. **IPv6**：先按 IANA Special-Purpose 精确拒绝，再且仅再放行 detailed §6.1 冻结的当前 IANA
   `ALLOCATED` 普通 GUA 编译期表；文档、benchmark、transition/site-local、special、RESERVED 与未列
   `2000::/3` 空间拒绝。registry 更新不自动扩权。
3. **Robots 装配**：`createPublicWatchHttpStack(...)` 是唯一产品构造入口；raw transport/client、其
   constructor 和任意 URL test seam 不导出。工厂内部装配 raw → RobotsPolicy → target-gated，调用方只
   获得窄 gated 能力。raw 初始 GET 只能是从目标 canonical authority 派生的 `/robots.txt`，无
   query/fragment；伪造 `purpose=robots` 不能赋予网络能力。raw 内部 redirect 逐跳复验 NetworkPolicy
   并继承原 `effectiveDeadline`。缺 gate 的 page/feed/discovery fail-closed；D5 只加 host gate/并发/间隔。
4. **总 deadline**：入口一次性冻结
   `effectiveDeadline=min(start+30_000, externalDeadline)`；缺省外部值只用内部截止，Invalid Date 或
   已过期值零 DNS/零 socket，外部晚值不能延长 30 秒。DNS、robots、所有地址、redirect、响应与 body
   每个等待点只使用剩余时间；任何路径不续杯；第一个终态胜出，迟到事件不得改变终态或发起网络。
5. **RFC 9309**：文件 body fatal UTF-8，非法/截断 UTF-8 整份 unavailable；合法 UTF-8 后逐行尝试。
   CR、LF、CRLF 和 RFC 结构位置的 SP/HTAB 合法；其它原始 control 或 ABNF 错误只使所在行不可解析。
   malformed/truncated percent triplet 也只忽略该条规则；其它 parseable rules 必须继续使用。
   Percent-encoded unreserved ASCII 解码；reserved、非 unreserved ASCII（含 `%00`）与非 ASCII octet
   保持大写 percent 编码身份。保留相同 UA 组合并、空 specific 不回退、`*`、末尾 `$`、最长 octet 与
   等长 allow 优先。

### INVARIANTS / RED LINES

- page/feed/discovery 缺 RobotsGate 时始终零 DNS、零 request factory、零 socket；没有兼容性 allow-all。
- raw robots 网络能力在模块外不可获得；`purpose` 是校验字段，不是权限令牌。
- 初始 robots authority 必须等于目标 canonical authority，path 只能 `/robots.txt` 且无 query/fragment；
  只有已经开始的 raw 内部 redirect 状态机可改变后续 URL，且每跳复验、共享预算。
- IP 字面量、DNS 全结果、连接时 sealed lookup、每跳 redirect 都执行同一 NetworkPolicy；特殊用途优先拒绝。
- 30 秒是一次目标资源获取总预算，不是单 DNS、单地址、单 socket、单 robots 或单 redirect 的预算。
- 一条合法 UTF-8坏规则不能废弃整份 robots；一个 fatal UTF-8 body 不能降级使用任何部分规则。
- `%00` 是 well-formed 编码 octet 身份，不等于原始 NUL，也不触发 unavailable；只有坏/截断 triplet
  使该规则不可解析。
- 不删、不跳过、不弱化既有有效测试；不引入 `any`、ts-ignore、宽泛 eslint disable、正则 matcher 或
  新网络能力；正文、query、凭据、Cookie 零日志/零落盘。
- D4 禁止开始；不得 amend/reset/rebase/push；最终只追加一个新的 local D3-R2 repair commit。

### EXPECTED SCOPE

- `src/shared/types/watch.ts`
- `src/main/watch/network-policy.ts`
- `src/main/watch/network-policy.test.ts`
- `src/main/watch/public-watch-http-client.ts`
- `src/main/watch/public-watch-http-client.test.ts`
- `src/main/watch/robots-policy.ts`
- `src/main/watch/robots-policy.test.ts`
- `doc/stage6/detailed-design.md`
- `doc/stage6/threat-model.md`
- `doc/stage6/tasks/D3-safe-feed-network-parser.md`

任何其它文件均视为越界并必须停止说明。三份文档由本 Planner 修订；后续实现者只能在实现事实要求的
最小同步范围内保持其一致，不能重开已冻结决策。

### IMPLEMENTATION PLAN

1. 只有本 Replacement Contract 经新的独立安全 Reviewer `PASS`，且用户随后生成/批准 bounded Executor
   prompt 后，Executor 才从精确 `dd3deeb` 审计链继续；先复核状态和范围，不修改历史。
2. **测试先行**：只新增本 Contract 的甄别性测试，产品代码保持 `dd3deeb` 行为；逐组运行并记录预期
   failure、断言位置和旧结构根因。红态必须覆盖五项，不能用模块缺失或错误 fixture 冒充。
3. 最小实现共享常量与 IPv6 分类；特殊用途拒绝优先，allowlist 精确匹配，不顺手重构 parser。
4. 把 Public HTTP 构造收口到安全工厂，隐藏 raw 能力；内部派生初始 robots URL，复用 raw redirect 状态机；
   gate 缺失与伪造 purpose 在任何网络副作用前返回。
5. 在公开入口建立唯一 effectiveDeadline 与 settlement latch，把同一 absolute deadline 传入 robots、DNS、
   地址尝试、redirect 和 body；每个等待点用剩余时间并在终态清理资源/忽略迟到事件。
6. 把 robots parser 拆为 fatal UTF-8 文件门、RFC 换行扫描、逐行 record 解析、octet normalization、group
   selection/matcher；坏行隔离，保持线性/有界，不用正则。
7. 聚焦转绿后运行全量门控、自审 `dd3deeb..HEAD` 与 `9f33de2..HEAD`，清理残留，创建一个新的 local
   repair commit 后停止，不 push，交给新的独立安全 Reviewer。

### TEST PLAN

**红态与聚焦命令**

- 先只改三份既有测试文件，运行：
  `npm test -- --maxWorkers=1 src/main/watch/network-policy.test.ts src/main/watch/public-watch-http-client.test.ts src/main/watch/robots-policy.test.ts`。
- 在 `dd3deeb` 产品实现上，新增 R2 oracle 必须至少一项/组明确失败；记录红态测试名、实际结果与为何
  只有 R2 实现可转绿。随后最小修复并用同一命令全绿。

**精确 oracle**

1. Robots bytes：构造语法合法且规则数未超限的精确 512,000-byte identity body，accept；512,001-byte
   body 在第 512,001 byte destroy + `budget_exceeded`。压缩响应分别证明 on-wire 与解压后任一 `MAX+1`
   都 destroy；超限后后续正常请求仍可用。
2. IPv6：`3fff::1`、`2001:db8::1`、`2001:2::1`、`fec0::1`、未分配 `2000::1`、IANA RESERVED
   `2d00::1` 均分类拒绝；URL 字面量和 DNS 返回路径都零 socket。至少保留 detailed §6.1 中已分配普通
   GUA 的正例并到达受控 test socket；special 子前缀优先于父 allowlist。
3. 工厂/能力：模块公开 surface 不包含 raw client/constructor/任意 fetch seam；只有安全工厂能创建产品
   target client。对目标 `https://EXAMPLE.com:443/a?x=1#f`，第一次 raw 请求只能是规范化
   `https://example.com/robots.txt`。公开入口伪造 `purpose=robots` 并分别改变 host、path、query/fragment
   或使用 HEAD，全部零 DNS、零 request factory、零 socket。raw 内部跨 authority redirect 每跳复验；
   私网/downgrade 拒绝，合法公网跳继承同一 absolute deadline。缺 gate 的 page/feed/discovery 同样零网络。
4. Deadline：FakeClock 下 Invalid Date 与 `deadline<=startedAt` 均零 DNS/零 socket；外部 `start+10s`
   在 10 秒内销毁，外部 `start+60s` 仍在内部 30 秒内销毁。DNS+两地址失败+redirect+静默 body 的累计
   时钟不得超过同一截止；每一步观察到递减 remaining。截止/abort/error/body end 竞态只 settle 一次，
   到期后触发 DNS callback、socket connect/error、redirect、chunk/end 均不能改变结果或产生新 socket。
5. Parser/matcher：
   - fatal 非法/截断 UTF-8 body → 整份 unavailable，先前看似合法规则不得生效；
   - CR、LF、CRLF 三种换行分别可解析，CRLF 不产生错误的额外 record；`User-agent`/冒号/value/行尾
     comment 的 RFC 结构位置 SP/HTAB 正例可用；
   - 含 raw NUL、其它 C0、DEL、C1 或坏 ABNF 的行被忽略，同行不改变 group，后续合法 disallow/allow
     仍生效；`/bad%G1` 与 `/bad%2` 规则各自忽略，前后 parseable rules 继续使用；
   - `/foo/%62%61%7A` 与 `/foo/baz` 等价；raw 非 ASCII 与其 UTF-8 percent octets 等价；`%2F` 不等于
     字面 `/`；`%2A`/`%24` 是字面编码身份；`/x%00y` 是 parseable rule 并只匹配规范化 `%00` 身份；
     `%7F`、孤立 `%80`/`%E3` 等 well-formed 非 unreserved octet 保持编码身份且不使文件 unavailable；
   - 相同 UA 分组合并；存在空 specific group 时允许且不回退 `*`；`*`、仅末尾 raw `$`、最长 normalized
     octet 与等长 allow 优先保持正确；1,024 parseable rules 接受，第 1,025 条触发 unavailable，坏行不计数。
6. 保留并复跑 WRT-01～WRT-08、WRT-19 既有回归，尤其 HTML 零脚本/子资源/Cookie、XML XXE/DTD/
   entity/各预算边界，证明 R2 未改 Feed/HTML parser 行为。

**全量门控**

- `npm test -- --maxWorkers=1 src/main/watch`
- `npm test -- --maxWorkers=1`
- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm run build`
- `npm audit`
- `git diff --check`
- dev 与 production Electron 冒烟按 AGENTS.md 安全任务矩阵执行；真实 Provider 为 N/A，因为 D3 无
  Provider 路径。任何 NOT RUN 必须给出契约依据，不能静默省略。

### ACCEPTANCE

- 五组新增测试已在未改产品代码的 `dd3deeb` 行为上真实红，并在最小实现后用同一断言转绿。
- detailed §6.1 allowlist、512,000/512,001 robots 边界、唯一安全工厂、初始 `/robots.txt` 能力边界、
  absolute effectiveDeadline、RFC 逐行/octet 语义均由机器 oracle 直接证明。
- Invalid Date、已过期、晚于内部截止、所有不续杯与迟到事件路径均有确定性测试，不依赖长墙钟。
- `%00` 与其它 well-formed 非 unreserved octet 不触发 unavailable；坏 percent/control/ABNF 行不污染
  其它规则；fatal UTF-8 整份 fail-closed。
- 所有聚焦/全量/typecheck/lint/format/build/audit/diff/smoke 门控通过；零测试弱化、零新依赖、零敏感
  信息/正文日志/临时残留。
- `dd3deeb..HEAD` 只包含 EXPECTED SCOPE 且没有 D4/D5 产品接线；创建恰好一个新的有界 local repair
  commit，工作区 clean，不 amend/reset/rebase/push。
- 新的独立安全 Reviewer 复核 baseline、diff、关键测试与机器输出并给出 `PASS`；此前 D3/D4 均不关闭/开始。

### STOP / ESCALATE CONDITIONS

- Contract、RFC/IANA、现有公共接口或测试之间仍有实质冲突；需要改变冻结 allowlist、错误映射、预算、
  deadline 起点、工厂能力或 RFC 行级语义。
- 安全工厂无法在 Expected Scope 内隐藏 raw 能力，或必须导出任意 URL transport/test seam。
- 为实现共享 deadline 必须修改 Scheduler/HostRequestGate/D4+，或会把单资源预算错误扩大为 run 预算。
- 需要改 Feed/HTML parser、换包、增加依赖、代理/认证/POST、修改 progress 或任何范围外文件。
- 红态测试不能甄别 `dd3deeb`、测试疑似与正式契约冲突、同一根因连续两轮修复仍失败。
- 出现需用户裁决、不可逆动作、凭据/外部权限；或工作区出现未知修改。遇到任一项立即停止，不自行
  放宽契约、删除测试、重写历史或 push。

### FINAL EVIDENCE

Executor 最终只提交结构化证据并停止：

1. baseline、repair HEAD/commit、`git log --oneline --decorate -5`、`git status --short --branch`；声明未
   amend/reset/rebase/push。
2. 每个新增红态测试名、`dd3deeb` 行为下的失败输出摘要、对应旧根因；同测试转绿结果。
3. 聚焦、Watch、全量 test、typecheck、lint、format、build、audit、diff-check、dev/production smoke 的
   精确命令、退出码和范围；NOT RUN 项及依据。
4. `git diff --stat dd3deeb..HEAD`、`git diff --name-only dd3deeb..HEAD` 与
   `git diff --check dd3deeb..HEAD`；逐文件说明为何在 Expected Scope，确认依赖版本不变、D4/D5 零接线。
5. 五项安全 oracle 的结果摘要、资源销毁/零 DNS/零 socket/迟到事件证据、敏感信息与临时文件扫描、
   剩余风险（无则写无）。
6. 明确交接“新的独立安全 Reviewer”；不更新 progress、不生成 D4 任务、不 push。

## D3-R3 修复记录（2026-08-27，Repair Worker，Reviewer 待复验）

D3-R3 有界修复候选处理独立安全 Reviewer 对 D3-R2 HEAD `2325077` 的四项发现；全部先红后绿，
未删除/放宽既有有效断言，未改动 R2 冻结契约。候选未 push；baseline `2325077`，repair HEAD 见 Git。

### 修复项与证据

1. **A：移除 RobotsGate 绕过能力**。`PublicWatchStackSeams` 删除 `robots` 键；
   `createPublicWatchHttpStack` 无条件在模块内创建真实 `RobotsPolicy` 并注入私有 gate；
   `RobotsGatePort`/`RobotsGateDecision` 降为模块内私有，不导出；无 allow-all/disableRobots/
   policyFactory/raw-client seam。新增结构 oracle（`AssertNoRobots<PublicWatchStackSeams>` 在
   baseline typecheck 报 `never` 赋值错误，修复后 typecheck 干净）与运行时 oracle（调用方强塞
   robots gate 被忽略，仍产生真实 robots.txt 请求并到达受控 socket）。
2. **B：闭合 deadline/abort 生命周期**。`attemptAddress` 显式跟踪 request/response/inflater；
   单一 `finish → cleanup` 幂等销毁三者并清除 socket timer 与 abort listener；`readBoundedBody`
   以 `isOuterSettled` 拒绝外层结算后的迟到 chunk/end/error（不累计字节、不写 buffer、不驱动
   inflater），并在所有终态 `release()` 移除 res/inflater listener 与销毁 inflater。新增
   `createInflater` 窄 seam（只影响解压、不改变安全装配）用于观察 inflater 生命周期。红→绿覆盖：
   identity 静默 body 到期 response 已销毁、gzip 到期 response+inflater 销毁且 listener 清除、
   abort 关闭全部活动资源、迟到事件零副作用零新 socket、timer/listener 清除且无未处理 rejection。
3. **C：修复 IPv6 robots authority**。`robots-policy.ts` 改为从已验证 canonical URL 经
   `new URL(...)` 派生绝对 `/robots.txt`（IPv6 保留方括号、无 query/fragment、scheme/authority
   不变、默认端口规范化一致），不再用去括号 host 拼接；跨 host 判定对 IPv6 方括号做规范化比较。
   真实工厂链 oracle：`https://[2606:4700:4700::1111]/feed` → 首次请求精确到该 IPv6 authority 的
   `/robots.txt`（GET/https/port 443）→ robots 允许后目标请求到达受控 socket；特殊/保留 IPv6
   零 socket oracle 保留。
4. **D：格式**。按仓库 Prettier 修复 `public-watch-http-client.test.ts`（`format:check` 全绿，
   未用忽略配置）。

### 验证门（Repair HEAD，候选本地全绿）

- 聚焦 `public-watch-http-client.test.ts` + `robots-policy.test.ts` 108/108；Watch 全量 240/240；
  全量 `npm test -- --maxWorkers=1` 2686/2686；typecheck/lint/format:check/build/npm audit 0/
  `git diff --check` 全过；dev 与 production Electron 冒烟 exit 0。
- 敏感信息/机器路径/临时残留扫描干净；仅改动 EXPECTED SCOPE 四个代码/测试文件 + 本节任务文档。
- 交接新的独立安全 Reviewer；不更新 progress、不生成 D4、不 push。

## D3-R4 修复记录（2026-08-27，Repair Worker，Reviewer 待复验）

D3-R4 有界修复候选处理独立安全 Reviewer 对 D3-R3 HEAD `be33291` 的首终态资源闭合四项发现。
全部先红后绿，未删除/放宽既有有效断言，未改动 R2/R3 冻结契约。候选未 push；baseline `be33291`，
最终候选为 `0df9bae`。实际范围是两个代码/测试文件（`public-watch-http-client.ts`、
`public-watch-http-client.test.ts`）加本 D3 任务文档，共三个文件。

> **R4 事实修正（R5 记录）**：R4 曾把自己的未公开候选 `a93715b` 经 `git commit --amend` 改写为
> `0df9bae`（reflog 见 a93715b→0df9bae，两提交均未 push，远程 `main` 未受影响）。该操作偏离本仓库
> 「不 amend/reset/rebase 候选历史」的 Git 契约；R5 起严格只追加新提交，不再改写历史。

### 修复项与证据

1. **request 具名回调与窄 removeListener 能力**：`WatchRequestLike` 增加
   `removeListener(response/error/timeout)` 窄能力；`attemptAddress` 的 request
   response/error/timeout 全部改为具名回调 `onResponse/onRequestError/onRequestTimeout`，
   `cleanup()` 确定移除 error/timeout（response 见第 4 点）。
2. **首终态立即 release 正文 reader**：`readBoundedBody` 改为返回 `{ promise, release }`；
   `attemptAddress` 外层持有幂等 `releaseBody` 句柄，`cleanup()` 在任何首终态（success/
   deadline/abort/budget/stream-error/request-error）直接调用，不再等待下一次迟到事件触发清理。
   新增 oracle：identity/gzip 静默 body deadline 与 abort 后，不发送任何迟到事件即断言
   response 的 data/end/error/aborted 与 inflater 的 data/end/error listener 全 0。
3. **response 已交付/request-error 终态移除 request listener**：`cleanup()` 在已见 response
   （`onResponse` 自移除）或 request-error（`requestFailed`）时移除 response listener，
   并始终移除 error/timeout。success/body-deadline/abort（response 已交付）/request-error
   四场景后 request 的 response/error/timeout listenerCount 全 0。
4. **deadline/abort 先于 response 的迟到守卫（R4 行为，已被 R5 取代）**：response 尚未到达时，
   R4 保留 `onResponse` 为迟到 response 守卫；守卫发现 settled/aborted 立即
   `safeDiscardResponse`（destroy 优先，destroy 不可用/抛错时安装安全 error sink 后 resume），
   零正文 listener、零新 socket，处理后再自移除。deadline 与 abort 先于 response 两个迟到
   response oracle 均证明已销毁。**矛盾说明**：该路径下 cleanup 返回时 request 的 response
   listener 仍为 1，并非全 0——与第 3 点「首终态后 listenerCount 全 0」表述冲突；R4 记录中
   「所有首终态 listener=0」与「pre-response 保留 listener」是自相矛盾的陈述，由 D3-R5 修正为
   「首终态无条件移除 request 全部 listener，不保留迟到守卫」。
5. **测试 harness 忠实化**：`FakeIncoming` destroy 后不再投递任何事件（模拟真实流，
   保证终态后发送 error 零未处理异常）；`FakeRequest.destroy()` 无 error 参数不再投递
   'error'（模拟真实 ClientRequest）。`CapturedRequest` 暴露底层 `request` 供
   listenerCount 断言。
6. **保持既有修复**：真实 RobotsPolicy 强制装配、`createInflater` 窄 seam、absolute
   effectiveDeadline 与 IPv6 robots authority 修复均未改动；未用 any/ts-ignore/
   eslint-disable，未降低既有断言。

### 红→绿证据（baseline be33291 上新增/强化测试先红）

- 红（be33291 产品代码 + 新测试，仅 stash 产品文件验证）：8 项失败——R3 压缩迟到事件测试
  （强化后）1 项，R4 新增 7 项（identity 静默 deadline、gzip 静默 deadline、abort 立即断言、
  deadline 先于 response 迟到销毁、abort 先于 response 迟到销毁、request listener 四场景全 0、
  终态后事件风暴）。旧根因：cleanup 不释放正文 reader 与 request listener，迟到 response 仅
  handler return 未 destroy。
- 绿（最终候选 `0df9bae`）：聚焦 63/63；Watch 全量 247/247；全量 `npm test -- --maxWorkers=1`
  2693/2693（baseline 2686 + 7 新增）；typecheck/lint/format:check/build/npm audit 0/
  `git diff --check` 全过；dev 与 production Electron 冒烟 exit 0。
- 依赖版本不变、D4/D5 零接线；敏感信息/临时残留/工作区扫描干净（两个代码/测试文件被修改，
  本任务文档在 R4 记录时一并更新）。
- 交接新的独立安全 Reviewer；不更新 progress、不生成 D4、不 push。

## D3-R5 修复记录（2026-08-27，Repair Worker，Reviewer 待复验）

D3-R5 有界修复候选处理独立安全 Reviewer 对 D3-R4 HEAD `0df9bae` 的三类发现：首终态后 request 的
response/error/timeout listener 必须无条件立即为 0；timer/AbortSignal/request/response/inflater
listener 与资源清理必须逐项异常隔离（任一 remove/destroy/clear 抛错不阻塞剩余清理）；并修正 R4
记录中的 HEAD/范围/amend/listener 事实。全部先红后绿，未删除/放宽既有有效断言，未改动 R2/R3/R4
冻结契约。候选未 push；baseline `0df9bae`，最终 repair HEAD 以 Git 为准（本记录不硬编码自报 SHA）。

### 修复项与证据

1. **首终态无条件移除 request 全部 listener**：`cleanup()` 无条件移除 request 的
   response/error/timeout listener，不再以「保留 response listener 作为迟到守卫」实现迟到安全
   （R4 守卫已被取代）。仅覆盖 `request.destroy()` 内同步发出 response 的竞态：destroy 调用期间
   暂时保留 `onResponse`（若同步发出则由其立即 `safeDiscardResponse` 并自移除），通过 `finally`
   在 cleanup 返回前移除；cleanup 返回时 request 的 response/error/timeout listenerCount 必须
   全为 0。`sawResponse`/`requestFailed` 不再需要，已删除。
2. **逐项异常隔离**：`cleanup()` 的 timer clear、AbortSignal removeEventListener、releaseBody、
   inflater.removeAllListeners/destroy、response.destroy、request 的每个 removeListener 与
   request.destroy 分别 try/catch；`readBoundedBody.release()` 的每个 res/inflater
   removeListener 与 inflater.destroy 分别 try/catch；`lookupWithTimeout.cleanup()` 的每个
   clearTimeout 与 removeEventListener 分别 try/catch；`safeDiscardResponse` 的 destroy、error
   sink 安装与 resume 分别保护。任一单项抛错继续剩余清理，零未处理异常。
3. **终态后 synthetic 事件零副作用**：终态后的 synthetic response/data/end/error 不改变结果、
   零新 socket、零 buffer/inflater 驱动、零未处理异常；不再把迟到 response 的销毁依赖在一个
   终态后仍存活的 listener 上（request 已 destroy，真实 transport 不会在 destroy 后投递
   response）。

### 红→绿证据（baseline 0df9bae 上先红）

- 红（0df9bae 产品代码 + 新/强化测试，仅 stash 产品文件验证）：7 项失败——R4「deadline 先于
  response」「abort 先于 response」强化为「不发送任何迟到事件立即断言 request 的
  response/error/timeout listener 全 0」（旧守卫保留 response listener → 红）；R5 新增 cleanup
  后 synthetic response/data/end 零副作用（含同一立即全 0 断言）；单项抛错隔离中
  response.removeListener、inflater.removeListener、timer clear、AbortSignal removeEventListener
  四组在旧实现未隔离（异常逃逸/挂起/未捕获 → 红）。
- 其余单项抛错（inflater.destroy、response.destroy、request.removeListener、request.destroy）在
  0df9bae 已隔离，基线即绿，保留为回归守卫；`request.destroy()` 内同步发出 response oracle 在
  0df9bae 亦绿（旧守卫经 onResponse 自移除恰好满足），保留为新实现不变式守卫。
- 绿（repair HEAD）：聚焦 73/73；Watch 全量 257/257；全量 `npm test -- --maxWorkers=1`
  2703/2703（baseline 2693 + 10 新增）；typecheck/lint/format:check/build/npm audit 0/
  `git diff --check` 全过；dev 与 production Electron 冒烟 exit 0。
- 依赖版本不变、D4/D5 零接线；敏感信息/临时残留/工作区扫描干净；仅改动 EXPECTED SCOPE
  两个代码/测试文件 + 本节任务文档，共三个文件。
- 交接新的独立安全 Reviewer；不更新 progress、不生成 D4、不 push。

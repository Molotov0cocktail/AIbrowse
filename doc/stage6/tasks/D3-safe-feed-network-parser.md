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
   「所有首终态 listener=0」与「pre-response 保留 listener」是自相矛盾的陈述；D3-R5 当时改成
   「首终态无条件移除 request 全部 listener，不保留迟到守卫」，但该 R5 要求又被 2026-08-28 真实
   Node 24 transport 证伪，当前以本文 REPLAN 两阶段终态为准。
5. **历史 harness 假设（已失效）**：R4/R5 曾让 `FakeIncoming` destroy 后不再投递任何事件，并让
   `FakeRequest.destroy()` 无 error 参数时不投递 `error`；这两项并不忠实于 Node 24，已由下方 REPLAN
   明确废止。`CapturedRequest` 暴露底层 `request` 供
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

D3-R5 有界修复候选处理独立安全 Reviewer 对 D3-R4 HEAD `0df9bae` 的三类发现：R5 **当时要求**首终态后
request 的 response/error/timeout listener 无条件立即为 0；timer/AbortSignal/request/response/inflater
listener 与资源清理必须逐项异常隔离（任一 remove/destroy/clear 抛错不阻塞剩余清理）；并修正 R4
记录中的 HEAD/范围/amend/listener 事实。全部先红后绿，未删除/放宽既有有效断言，未改动 R2/R3/R4
冻结契约。候选未 push；baseline `0df9bae`，最终 repair HEAD 以 Git 为准（本记录不硬编码自报 SHA）。

> **R5 事实修正（2026-08-28 生命周期 REPLAN）**：上述“首终态后 request 的 response/error/timeout
> listener 必须无条件立即为 0”已被 Node 24.18.0 官方事件顺序与 localhost 子进程实测证伪。无参数
> `ClientRequest.destroy()` 在 pre-socket/pre-response 路径会异步发出 `error ECONNRESET → close`；先移除
> error listener 会形成未监听 EventEmitter error、触发 `uncaughtException` 并使子进程 exit 1。R5 的
> FakeRequest“不带参数 destroy 不发 error”和只监听 unhandledRejection 的 oracle 产生假绿。R5 以下内容
> 保留为历史实现记录，不再是当前生命周期契约；当前契约以 detailed-design §6.1/#S6-043、
> threat-model §3.6/WRT-04/§7.1 和本文下方 Replacement Execution Contract 为准。

### 修复项与证据

1. **历史实现（已失效）：首终态无条件移除 request 全部 listener**：`cleanup()` 无条件移除 request 的
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
   终态后仍存活的 listener 上；R5 同时错误假定 request destroy 后不会再投递任何 transport error，
   该假定已由本 REPLAN 的真实 Node `ECONNRESET → close` 证伪。

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

## D3 Public HTTP 生命周期 REPLAN（2026-08-28，Contract Reviewer 待审）

本轮是 D3-R3/R4/R5 同一 request/response/listener 生命周期根因连续失败后的正式 REPLAN。Planner
baseline 为 `e412c12228b127ecaa73619b0c9edd6eced3a34c`；只修订三份正式文档，零产品代码/测试、零
progress、零 commit/push。Contract Reviewer `PASS` 前禁止继续实现。

### Node 24.18.0 调查与事实边界

官方依据：

- `request.destroy([error])` 会销毁 request，可选择发 error，并会发 close；ClientRequest 事件顺序表进一步
  明确：socket 分配前/连接成功前 destroy 为 `error ECONNRESET → close`，response 后 destroy 的
  aborted/error/close 位于 IncomingMessage：
  <https://nodejs.org/download/release/v24.18.0/docs/api/http.html#requestdestroyerror>、
  <https://nodejs.org/download/release/v24.18.0/docs/api/http.html#http_client_request>；
- 未监听 EventEmitter `error` 会抛出并使进程退出：
  <https://nodejs.org/download/release/v24.18.0/docs/api/events.html#error-events>；
- `uncaughtExceptionMonitor` 只观察、不改变默认崩溃行为，不能用它恢复进程：
  <https://nodejs.org/download/release/v24.18.0/docs/api/process.html#event-uncaughtexceptionmonitor>。

Planner 使用真实 Node `v24.18.0` + localhost `node:http`、`agent:false` 的最小探针观察到：

| 路径                                 | response error listener 条件          | 实际事件序列（调用事件省略参数）                                                                                                    |
| ------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| destroy，socket 分配前               | N/A                                   | destroy → request error `ECONNRESET` → request close                                                                                |
| destroy，socket 已分配/response 前   | N/A                                   | request socket → destroy → request error `ECONNRESET` → request close                                                               |
| destroy，response 已交付（原探针）   | 已安装具名 response error observer    | request socket → response → destroy → response aborted → request close → response error `ECONNRESET` → response close               |
| destroy，response 已交付（对照探针） | destroy 前移除最后一个 error listener | request socket → response → destroy → response aborted → request close → response close                                             |
| abort，socket 分配前                 | N/A                                   | abort → request close → request abort（本次实测次序；官方表列 abort → close）                                                       |
| abort，socket 已分配/response 前     | N/A                                   | request socket → abort → request abort → request error `ECONNRESET` → request close                                                 |
| abort，response 已交付（原探针）     | 已安装具名 response error observer    | request socket → response → abort → request abort → response aborted → request close → response error `ECONNRESET` → response close |
| abort，response 已交付（对照探针）   | abort 前移除最后一个 error listener   | request socket → response → abort → request abort → response aborted → request close → response close                               |

另一个不安装 request error sink、但安装 `uncaughtExceptionMonitor` 与 `unhandledRejection` 观察器的受控
子进程，在 pre-response destroy 后输出 `MONITOR origin=uncaughtException code=ECONNRESET` 并 exit 1；同一
路径保留最小 request error sink、在 close 移除 error/close drain listener 后输出 listener count `0/0` 并
exit 0。前者没有 `UNHANDLED_REJECTION`：未监听 EventEmitter error 是异步抛出的 uncaught exception，
不是 Promise unhandledRejection。现有 73 项 FakeRequest 聚焦测试仍全绿，证明旧夹具不能甄别真实缺陷。

response-after 对照探针两路均 exit 0，且 `uncaughtExceptionMonitor`/unhandledRejection 均未命中。原
destroy/abort 探针安装的 response error observer 会使 Node 24.18.0 当前实现发出并交付 response
`ECONNRESET`；移除最后一个 response error listener 后，当前实现可能直接从 aborted 到 close。因此测试
observer 不是透明观察者，旧 R5 在真实 response-after 子进程中不保证 crash、monitor 命中或非零退出。
这不意味着 IncomingMessage drain 可删除：产品必须拥有自己的 named response drain，用于接收实际发出的
error、通过确定性敌手 seam、覆盖未来 Node/transport 差异，并与 request drain 形成统一可清理生命周期。

### 方案评估与冻结选择

| 方案 | 行为                                                                                                           | 结论                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | 业务首终态在同步 cleanup/destroy/fallback 后立即结算；request 与每个已交付 response 各保留 emitter-local drain | **选择**。不等待 transport、不增加 drain timer、不破坏 absolute deadline；两个 emitter 实际发出的 error 都有安全接收点。                          |
| B    | 两阶段内部状态机等待 error/close 或另一个有界 drain timeout 后才结算业务 Promise                               | **拒绝**。close 可永不到达；直接等待会无界挂住调用方，另设 drain timer 会在业务终态后重新持有 timer，并可能把结算推过 #S6-041 absolute deadline。 |

冻结协议：业务终态与 transport drain 状态完全分离。ClientRequest 创建成功后立即安装 named request error
sink + close cleanup；每个 IncomingMessage 一经交付，必须在 body reader、discard、destroy 或 resume 前
安装自己的 named response error sink + close cleanup。两类 sink 从安装起对各自 emitter 的所有 error 都
无条件 no-op，业务终态前由独立 business error handler 决定业务结果。业务首终态立即清除全部**业务**
listener/timer/AbortSignal/body/inflater 状态并销毁资源，在同步 cleanup/destroy/fallback 后立即结算 Promise，
不等待 drain、不增加 drain timer。request/response close 各自幂等、逐项异常隔离地移除本 emitter 的 drain
pair；若 transport 在 request close 后发出 response `ECONNRESET`，必须由 response drain 接收。request drain
只闭包 request 及其两个 callback；response drain 只闭包对应 response 及其两个 callback；均不闭包 Promise、业务结果、
timer、AbortSignal、正文/body buffer、inflater、另一 emitter、process/global listener 或 registry。close
永不到达时仅相应 emitter-local drain pair 可随不可达 transport 对象 GC。destroy 同步抛错只允许一次受控
abort fallback；destroy 调用栈内同步 response 由 finally 必移除的 call-stack discard guard 捕获，guard 必须
先装 response drain 再 destroy，只有 destroy 缺失/抛错才 resume，且在 Promise 结算前归零。

### D3-R6 Replacement Execution Contract

#### TASK

按已冻结的 #S6-043 两阶段协议修复 D3 PublicWatchHttpClient 终态生命周期与测试盲区。只处理 request/
response/inflater 的 business terminal，以及 request/IncomingMessage 两类 emitter-local transport drain；
不得重开网络策略、parser、D4/D5 或其它 Stage 设计。

#### BASELINE

- 精确 SHA：`e412c12228b127ecaa73619b0c9edd6eced3a34c`，分支 `main`。
- Planner 接管时工作区干净；REPLAN 后工作区只允许本次三份正式文档的未提交修改。新的独立 Contract
  Reviewer 必须先审核该 diff 并给出 `PASS`；Executor 开工时 HEAD 仍须等于本 SHA，并保留已批准文档 diff。

#### GOAL

实现可由真实 Node 24.18.0 transport、产品结构断言和确定性敌手 seam 共同证明的两阶段终态：首个业务结果
单次所有权、立即零新业务副作用/重型业务资源，Promise 在同步 cleanup/destroy/fallback 后立即结算且不等待
close；request/response 实际发出的迟到 error 分别由所属 emitter 的最小 drain 安全吸收，各自 close 后 drain
listener 归零；零 uncaughtException、零 unhandledRejection、零多次 settlement。

#### NON-GOALS

- 不修改 Public HTTP URL/DNS/IPv6/robots/redirect/deadline/parser 的既定语义或预算；
- 不安装/升级依赖，不改 package/lockfile；
- 不进入 D4/D5，不改 Scheduler/HostRequestGate/DB/UI/IPC/Provider；
- 不更新 `doc/tasks/progress.md`，不 close D3，不 push；
- 不增加 process 级 `uncaughtException` 兜底，不用等待 close 或新增 drain timer 伪装修复。

#### AUTHORITATIVE SOURCES

- `AGENTS.md` §2.3、§2.5、§3.1；
- `doc/stage6/detailed-design.md` §6.1、§15.1、#S6-041、#S6-043；
- `doc/stage6/threat-model.md` WRT-04、§3.6、§7.1；
- 本任务文档的本 REPLAN/Replacement Contract；
- Node 24.18.0 官方 HTTP ClientRequest、Events error、process uncaughtExceptionMonitor 文档。

#### CURRENT VERIFIED STATE

- R5 `cleanup()` 在 `request.destroy()` 前移除业务也是唯一的 request error listener；真实 Node 随后异步
  发 `ECONNRESET` 时无接收点。
- R5 FakeRequest 明确把无参数 destroy 建模成“不发 error”，FakeIncoming destroy 后抑制所有事件；测试只
  收集 unhandledRejection。当前聚焦 73/73 绿是已证实假绿，不构成 transport 生命周期证据。
- Node 24.18.0 localhost 与子进程结果见上表。pre-socket/pre-response 的 request destroy 在旧 R5 上会因
  未处理 request `ECONNRESET` 造成 monitor 命中或非零退出，这是必须保留的真实 crash 红态。
- response-after 的原 destroy/abort 探针安装了 response error listener，因而观察到 aborted → request close →
  response `ECONNRESET` → response close；移除最后一个 response error listener 的对照探针只观察到 aborted →
  request close → response close，两路均 exit 0 且 monitor/rejection 为零。测试 observer 会改变当前 Node 的
  条件发射，不能用于要求旧 R5 在真实 response-after 必然崩溃。
- R5 产品没有 product-owned named IncomingMessage drain、response business/drain listener 分层或 close
  自清理；该 response-after 缺陷必须由产品结构红态和强制 asynchronous error 的确定性敌手 seam 甄别。
  request drain 在 request close 已自清理，仍不能替 response emitter 接收实际发出的 error。
- R2–R5 的安全工厂、IPv6、robots、absolute deadline、逐项异常隔离中与本冲突无关的部分仍为回归基线。

#### FIXED DECISIONS

1. **两阶段状态**：business settlement latch 与 emitter-local transport drain 状态分离；模型、网页和调用者
   不可改写。request drain 与每个已交付 IncomingMessage 的 response drain 都不是业务 listener。
2. **立即结算**：业务首终态设置 latch、完成同步 cleanup/destroy/fallback 后立即 resolve；永不等待
   transport error/close，永不建立 drain timer。
3. **Request drain**：ClientRequest 创建成功后立即安装独立 named error sink + close cleanup listener；
   业务终态前另有独立 request business error handler。drain sink 从安装起对所有 request error 都无条件
   no-op，不读取 settlement；业务 handler 在业务终态移除后 drain 保留至 request close。drain 只闭包
   request 和两个 callback，不得引用 finish/resolve/reject、业务结果、timer/AbortSignal、body buffer、
   response/inflater 或全局 registry/process listener。
4. **IncomingMessage drain**：每个 response 一经交付，必须先安装独立 named error sink + close cleanup
   listener，再接入 body reader、discard、destroy 或 resume；业务终态前另有独立 response business error
   handler。drain sink 从安装起对所有 response error 都无条件 no-op，不读取 settlement；移除业务 listener
   后保留至 response close；若 transport 在 aborted、request close 之后发出异步 `ECONNRESET`，必须由该
   drain 接收。drain 只闭包该 response 和两个 callback，不得闭包 settlement、业务结果、timer、AbortSignal、
   body buffer、inflater、
   request、全局 registry 或 process listener。
5. **close 自清理**：request/response close cleanup 都必须幂等移除本 emitter 的 error sink + close listener；
   每次 `removeListener` 单独 try/catch，一个 remove 抛错不能形成 uncaught exception 或阻止另一个清理。
   已保存 callback 在清理后重复调用必须幂等。任一 emitter 永不 close 都不阻塞 Promise或保留 timer、正文、
   inflater、业务闭包；仅对应 emitter 自包含 drain pair 可随不可达 transport 对象 GC。
6. **同步异常/response discard**：request destroy 同步抛错不改结果，最多一次受控 abort fallback；fallback
   返回/抛错后立即结算。destroy 内同步 response 仅经 call-stack discard guard 捕获；收到 response 后先
   安装 response drain，再调用 response destroy，仅在 destroy 缺失或抛错时 resume。禁止匿名、无法由 close
   清理的 response error listener；guard 在 request.destroy()/abort fallback 调用栈 finally 和 Promise 结算
   前归零，不得创建 body reader/inflater。
7. **所有权/顺序**：先 latch → 禁止新业务 → 清 timer/AbortSignal → detach/release body、response、inflater
   和 request 业务 listener → 确认对应 request/response drain 已安装 → destroy inflater/response/request 或
   受控 fallback → 清空业务闭包内重型引用 → resolve。每个清理动作独立 try/catch；任何一步失败不跳过后续
   动作。
8. **测试权威**：真实 Node 24 pre-response transport + 子进程退出码/uncaughtExceptionMonitor 是 request
   crash 红态 oracle；response-after 由真实绿态、product-owned drain 结构断言和确定性敌手 seam 共同证明。
   FakeRequest/FakeIncoming 必须提供强制异步 response error/close 的敌手路径，不得用 destroy 后零投递制造
   假绿，也不得把该 seam 冒充真实 Node 必然顺序。测试 observer 必须与 product-owned named drain 区分；
   listenerCount、callback 身份和闭包可达性断言必须排除 observer，observer 不得吞掉产品缺陷。

#### INVARIANTS / RED LINES

- 首个 success/deadline/abort/request-error/body-error/budget-error 恰好结算一次；迟到事件零 retry、零新
  DNS/socket/redirect、零正文/解压/结果变化。
- 业务终态后业务 listener、timer、AbortSignal、body buffer、inflater 和业务闭包中的 response/request 重型
  引用立即归零；允许跨事件轮保留 request drain，以及每个已交付、迟到或需要 discard 的 IncomingMessage
  自身 response drain。
- 两类 drain 均零业务副作用、零敌手正文日志、零 process/global listener/registry；分别在所属 emitter close
  后自身归零。close 永不到达也不阻塞 Promise、不持有 timer/正文/inflater/业务闭包或另一 emitter。
- 禁止 `any`、ts-ignore/nocheck、eslint-disable、删除/跳过/放宽有效断言、process 级异常吞噬或把
  uncaughtException 混称 unhandledRejection。
- 保留 #S6-041 absolute deadline、robots gate、SSRF/IPv6/redirect/预算/解析器全部既有红线。

#### EXPECTED SCOPE

- `src/main/watch/public-watch-http-client.ts`；
- `src/main/watch/public-watch-http-client.test.ts`；
- 允许新增一个专用的 `src/main/watch/public-watch-http-lifecycle.integration.test.ts`，只用于真实 localhost/
  子进程生命周期 oracle；若不新增，必须在现有测试文件内提供等价且可独立运行的真实 transport oracle；
- 保留并在必要时仅机械同步本次已批准的三份正式文档：
  `doc/stage6/detailed-design.md`、`doc/stage6/threat-model.md`、本任务文档。

出现其它文件、需要改变导出安全工厂/公共产品接口、修改 package/progress/D4+ 时立即停止；不得自行扩面。

#### IMPLEMENTATION PLAN

1. 先新增真实 Node 24 localhost pre-socket/pre-response + 受控子进程红态 oracle；在 `e412c12` 产品代码上
   证明旧 R5 因未处理 request `ECONNRESET` 导致 `uncaughtExceptionMonitor` 命中或非零退出，并保留输出证据。
2. 为 response-after 建立独立结构红态：断言业务终态后必须存在 product-owned named IncomingMessage drain、
   business/drain listener 正确分层且 close 自清理；listenerCount、callback 身份和闭包可达性排除测试 observer。
   旧 R5 必须因缺少该产品结构转红，不要求真实 Node 子进程崩溃。
3. 把 FakeRequest/FakeIncoming 生命周期改成与 Node 24 文档相符，并增加明确标注的确定性敌手 response seam，
   强制投递 aborted → asynchronous error → close；旧 R5 因无 response drain 转红。删除“不带参数 destroy
   不发 error”“destroy 后不投递任何事件”的错误声称，但不得把强制 seam 记录为真实 Node 必然顺序。
4. 在 request 创建后立即装配 request drain pair；将 response 交付入口统一为先装 product-owned response
   drain、再分派 body reader/discard/destroy/resume；把两个 drain closure 与业务 cleanup 分离。保留 call-stack
   response discard guard，固定 destroy 缺失/抛错才 resume，并补 request destroy throw→一次 abort fallback。
5. 逐场景转绿：real pre-socket/pre-response crash；real response-after 发或不发 error 的条件路径；正常
   success/end、redirect/HEAD discard、request/body/budget error、sync late response、response destroy 缺失/
   抛错、各 close cleanup 的每项 removeListener 抛错、重复 callback、never-close；逐项检查 settlement/资源/
   业务 listener/product-owned drain，并证明测试 observer 未参与产品安全结果。
6. 复跑 R2–R5 仍有效全部回归、Watch 聚焦/全量与项目全量门控；自审 baseline diff、清理残留，创建有界
   local candidate commit(s)，不 push，STOP 交给新的独立安全 Reviewer。

#### TEST PLAN

**必须先红后绿的 oracle：**

1. **真实 pre-response crash 红态**：真实 Node 24 `node:http`（不是仅 FakeRequest）经产品 request factory
   seam 连接 localhost；pre-socket/pre-response deadline 与 AbortSignal destroy 在旧 R5 上必须因未处理 request
   `ECONNRESET` 触发 `uncaughtExceptionMonitor`、非零退出或等价未处理 error 红态。专用子进程只安装 process
   monitor（只观察、不恢复）并独立记录 unhandledRejection，不得添加 request error observer 掩盖缺陷；绿态
   product-owned request drain 后 exit 0、monitor/rejection 均为零并可继续 sentinel/后续正常请求。
2. **response-after 结构红态 + 真实条件绿态**：旧 R5 必须因业务终态后缺少 product-owned named
   IncomingMessage drain、business/drain listener 分层错误或 close 无自清理而转红，不要求真实 Node 子进程
   必然崩溃。真实 Node response 已交付后触发 deadline 与 AbortSignal；绿态证明业务 Promise 在同步 cleanup/
   destroy/fallback 后立即结算、request close 清 request drain、product-owned response drain 在 destroy 前已
   安装。若 Node 发出 response error，则由该 drain 安全吸收；无论是否发出 error，response close 后 drain
   均为 0、子进程 exit 0、monitor/rejection 均为零。测试不得额外安装匿名 response error listener；具名测试
   observer 仅可用于单独对照事实，且必须从 listenerCount、callback 身份和闭包可达性断言中排除，不能成为
   产品通过的 error sink。
3. **确定性 response 敌手 seam 红态**：FakeIncoming/transport seam 强制异步投递 aborted → error → close；
   旧 R5 因没有 product-owned response drain 明确转红，绿态 error 由 product-owned drain 接收并在 close 后
   归零。测试记录必须把该路径标为确定性敌手 seam，不得声称真实 Node 在无 error listener 时必然发出 error。
4. **业务/drain 分层归零**：正常 success/end、redirect/HEAD discard、budget/body error、response 后 deadline/
   abort 分别证明 request/response/inflater 的业务 listener 在业务终态立即归零；request drain 与每个已交付
   response 的 product-owned drain 可跨事件轮保留，但必须分别在所属 emitter close 后归零；测试 observer
   不计入这些 listener 数量。
5. **destroy 内同步 late response**：request call-stack discard guard 捕获同步 response 后，先安装 response
   drain，再 destroy；guard 在 Promise 结算前归零。response drain 可按正式例外保留至 response close；零 body
   reader、inflater、新 DNS/socket/redirect、正文累计或业务结果变化。request destroy 同步 throw 的一次 abort
   fallback 同样不改变结果或产生多次 settlement。
6. **response destroy fallback**：response `destroy` 缺失与同步抛错两条 seam 都证明 response drain 已先安装，
   之后才 `resume()` 排空；resume 后异步 error/close 安全，零匿名或无法 close-cleanup 的 listener，response
   close 后 drain listener 为 0。destroy 成功时不得额外 resume。
7. **close cleanup 异常隔离**：request 与 response 的 close cleanup 分别对 error sink 的 removeListener 抛错、
   close listener 的 removeListener 抛错建立 oracle；每次 remove 都单独 try/catch，一个失败不形成 uncaught
   exception、不阻止另一个清理，保存的 close/error callback 在清理后重复调用幂等且零业务副作用。
8. **never-close seam**：业务 Promise 已结算；零 timer、AbortSignal、body buffer、inflater、业务闭包与 global
   registry/process listener。仅允许对应 request 或 response emitter 自包含的 drain pair；drain 不可到达另一
   emitter 或 settlement/业务结果。
9. **忠实 fake 与单次终态**：FakeRequest/FakeIncoming 忠实覆盖 Node 24 已观察的异步 request/response
   error/close，并用单独敌手模式强制 response error；禁止 destroy 后零投递，也禁止把强制模式冒充真实必然
   顺序。success/deadline/abort/request-error/body-error/budget-error 每类 settlement counter 精确为 1；迟到
   response/data/end/error/aborted/close 零 retry、零新网络、零正文/解压和结果变化。
10. **既有回归**：保留全部 R2–R5 仍有效的安全工厂/零 raw 出口、IPv6、robots 512,000/512,001、RFC 9309、
    single absolute deadline、redirect/压缩/预算与业务资源逐项异常隔离 oracle。

**验证命令：**

- 聚焦新增 integration/subprocess test + `public-watch-http-client.test.ts`；
- `npm test -- --maxWorkers=1`；
- `npm run typecheck`；`npm run lint`；`npm run format:check`；`npm run build`；
- 与主进程生命周期风险相称的 dev + production Electron 冒烟；
- `npm audit`、`git diff --check`、敏感信息/临时残留/范围扫描。

#### ACCEPTANCE

- 真实 Node 24.18.0 pre-socket/pre-response 子进程保留旧 R5 未处理 request `ECONNRESET` 的 crash/monitor/
  非零退出红态；修复后 product-owned request drain 使其 exit 0、monitor/rejection 为零。
- response-after 旧 R5 由 product-owned named drain 缺失、listener 分层/close 自清理结构断言和强制 error 的
  确定性敌手 seam 明确转红，不要求真实 Node 子进程非零退出或 monitor 命中。
- 真实 Node response-after 绿态证明业务立即结算、request close 后 request drain 为 0、response drain 在
  destroy 前已安装；若 Node 发出 response error 则由该 drain 接收，无论是否发出 error，response close 后
  drain 为 0，且 exit 0、uncaughtExceptionMonitor/unhandledRejection 为零。测试 observer 与 product-owned
  drain 的身份、数量和闭包断言严格分离，不掩盖产品缺陷。
- 业务 Promise 不等待 drain 且无 drain timer；business listener/资源立即清理；request/response drain 分别在
  各自 close 后归零；never-close 仅保留 emitter-local pair，不保留重型/业务/全局资源。
- 正常、discard、body/budget failure、同步 late response、destroy→resume fallback、close cleanup remove 抛错、
  重复/迟到事件均满足既定安装/清理顺序、单次 settlement、逐项异常隔离与零业务副作用。
- R2–R5 有效安全回归、聚焦/全量/typecheck/lint/format/build/冒烟全部通过，无弱化测试。
- 修改范围受控；三份正式文档保持一致；不更新 progress、不进入 D4/D5、不 push。

#### STOP / ESCALATE CONDITIONS

- 真实 Node 24 观察到无法由当前 emitter-local request/response drain 安全承载的 error/close 顺序；
- 需要等待 transport、增加 drain timer/process 级异常兜底、全局 request registry，或 drain 必须捕获业务/
  重型状态、另一 emitter；
- 需要改变 #S6-041、robots/SSRF/IPv6/工厂公共边界、D4+/package/progress 或其它正式架构；
- 测试 oracle 与 Node 官方行为冲突、Fake seam 无法忠实模拟、同一根因本轮仍失败；
- 发现两个长期影响显著的方案或需要用户/独立安全裁决。

任一命中立即停止返回 Planner；不得继续 Repair 堆叠。

#### FINAL EVIDENCE

Executor 必须报告：baseline/最终 HEAD/local candidate commit(s)；红态与绿态命令/退出码；真实 localhost
pre-socket/pre-response request crash 红态与修复后结果；response-after 有/无具名对照 observer 的条件事件序列
及两路 exit code、uncaughtExceptionMonitor/unhandledRejection 计数；product-owned named request/response drain
的 callback 身份、listener 分层、close 自清理、闭包可达性断言，并明确排除测试 observer；确定性敌手 seam
强制 aborted → asynchronous error → close 的旧 R5 红态/修复绿态，且标注它不代表真实 Node 必然发射；各终态
settlement、timer/AbortSignal/body/response/inflater/业务闭包/global registry 断言；sync late response、destroy→
resume、removeListener 抛错隔离与 never-close 证据；聚焦/Watch/全量/typecheck/lint/format/build/audit/冒烟
结果；`baseline..HEAD` + 工作区范围、diff-check、敏感信息/临时残留扫描；剩余诚实限制。完成后 STOP，交给
新的独立安全 Reviewer，禁止自行 close/push。

## D3-R7 修复记录（2026-08-28，Repair Worker，Reviewer 待复验）

D3-R7 有界修复候选处理独立安全 Reviewer 对 D3-R6 HEAD `e689484` 的 transport integration oracle
真实性/自然退出/observer 身份/测试依赖可复现性四项发现。未删除/放宽既有有效断言，未改动 #S6-043
两阶段协议与 R2–R6 冻结契约；产品源码仅做注释校正（无行为变化），除非新 oracle 暴露缺陷否则不改行为。
候选未 push；baseline `e6894844993e163f5cb1f22e6ebf6226b60bd441`，最终 repair HEAD 见 Git。

### 修复项与证据

1. **true pre-socket oracle（此前两个「pre-socket」用例实为 socket-after/pre-response）**：
   `public-watch-http-lifecycle.integration.test.ts` 改为监听真实 request 的 `socket` 事件记录
   `socketSeen`，不再用固定 40/150ms 延迟推断 socket 状态。
   - **true pre-socket deadline**：受控 Clock 在 feed requestFactory 创建真实 ClientRequest 后、返回产品前
     把 `now()` 推进到剩余 deadline 之后 → 产品在 request `end()` 前 destroy；业务终态断言 `socketSeen=false`。
   - **true pre-socket abort**：requestFactory 返回产品前同步触发 AbortController → 产品安装 request drain
     后发现 signal 已 aborted，在 end/socket 前 destroy；断言 `socketSeen=false`。
   - **socket-after/pre-response deadline 与 abort**：仅在 `socketSeen=true` 后（socket 事件微任务）触发
     deadline（确定性 fireFeedTimers）或 abort；server 不发 response；断言 `socketSeen=true`。
2. **R5 红态复现（机器证据）**：临时提取 `e412c12` 的 R5 产品源码（字节精确）+ 当前未变的
   network-policy/robots-policy/shared types，Vite 构建 CJS bundle 后跑同一批子进程场景：
   presocket-deadline/presocket-abort/socketafter-deadline/socketafter-abort 四路均
   `exit=1` + stderr `Unhandled 'error' event`（未处理 request ECONNRESET）；response-after 三路 R5 不崩溃
   （条件发射，符合 REPLAN 调查）。同一场景在当前修复（HEAD）上全部 `exit=0`、stderr 干净、monitor/
   rejection 为零 → 两类路径旧 R5 红、当前修复绿。
3. **子进程自然退出**：成功路径删除 `process.exit(0)`；`await server.close`（子进程 request 使用
   `agent:false`，保证测试创建的连接精确关闭）；main 完成后自然退出，父进程以 10s timeout 检测活动句柄
   泄漏（超时 kill → code=-1 使测试失败）。`main().catch` 只输出受控诊断（PROBE_ERROR + PROBE_RESULT）并
   设置非零 `process.exitCode`，不再伪装成功；JSON 缺失/解析失败/harness 异常均使断言失败。
   `uncaughtExceptionMonitor` 仅观察、不恢复异常。
4. **observer 按 callback identity 隔离**：response-after 对照场景使用显式具名函数 `responseErrorObserver`，
   保存其身份并断言 `observerIdentityMatches`（同一函数对象确已安装）；listener 统计按精确 callback 过滤
   （`filter(f => f !== observer)`），不再只减常量 1；分别断言 `responseErrorDrain`、`onSourceError`、
   `responseCloseCleanup`；observer 与无 observer 场景分开，无匿名 error observer。
5. **删除未声明传递依赖 esbuild 的直接 import**：测试改用 package.json 直接声明的 devDependency
   `vite`（`import { build } from 'vite'`）构建临时子进程产物，`minify:false` 保留产品具名 drain/业务
   listener 的函数名；不修改 package.json/package-lock.json。
6. **注释/标题校正（#S6-043 语义）**：`public-watch-http-client.ts` 两处旧注释改为「业务终态立即移除
   request 的业务 response/error/timeout listener；requestErrorDrain/requestCloseCleanup 保留至 request
   close；全部 request listener 只有 close 后才能断言为零」。测试标题与断言区分「首终态同步状态
   （drain 保留）」与「await 后已 close（全部归零）」，不再把 post-close 观察描述为首终态同步状态。

### 验证门（repair HEAD，候选本地全绿）

- 聚焦 integration 7/7 + `public-watch-http-client.test.ts` 88/88；Watch 全量 279/279；
- `npm test -- --maxWorkers=1` 全量（见 FINAL EVIDENCE）；typecheck/lint/format:check/build/npm audit 0/
  `git diff --check` 全过；dev 与 production Electron 冒烟 exit 0。
- R5 红态与 HEAD 绿态逐路退出码、stderr、socketSeen、monitor/rejection 见 Git 记录的机器输出。
- 依赖版本不变、package/lockfile 不变、D4/D5 零接线；敏感信息/临时残留/工作区扫描干净；
  仅改动 EXPECTED SCOPE 三个代码/测试文件 + 本节任务文档，共四个文件。
- 交接新的独立安全 Reviewer；不更新 progress、不生成 D4、不 push。

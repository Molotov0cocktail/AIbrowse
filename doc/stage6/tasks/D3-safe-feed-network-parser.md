# D3 — XML/HTML 依赖资格门、公开网络、Feed 与公开页面流式通道

## 目标

完成 `@federicocarboni/saxe@0.8.0` 和 `parse5-sax-parser@8.0.0` + `parse5@8.0.1` 双资格门；
只有分别通过后才精确安装并实现公网 GET/HEAD、DNS/redirect/robots、Feed Discovery/RSS2/Atom，
以及公开 HTML→DocumentChannels 的零执行流式通道。

## 范围与非目标

- **做**：两组候选 tarball/许可证/维护/供应链/Node24/Electron 构建核验；XML/HTML 敌手与兼容语料；
  Node 核心 http/https 连接时 lookup；仅 HTTP 80/HTTPS 443 的 NetworkPolicy/RobotsPolicy；
  SAX Feed Discovery；FeedProjection；
  公开 HTML SAX→有界 DocumentChannels，零脚本/子资源/Cookie。
- **不做**：页面 Session、Scheduler、watch.db、Event/Digest/UI；不实现通用 HTTP；不支持登录 feed；
  解析失败不浏览器 fallback。

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

## 验收标准与测试

- WRT-01～WRT-08/WRT-19 对应项聚焦全绿；初始与每跳 scheme/host/port/IP/DNS/downgrade 独立断言，
  省略端口/显式默认端口接受，所有非默认端口零 socket。
- RSS2/Atom/namespaces/CDATA/encoding/重复 identity/304/ETag/Last-Modified 有稳定 oracle。
- DTD/entity/XInclude 零文件/网络；2 MiB 与 XML depth/name/attribute-count/attribute-bytes/text-node/nodes/
  total-text/FeedProjection 每项 `== MAX` 接受、`MAX+1` fail-closed，零假 Projection。
- HTML 零 JavaScript/WebContents/子资源/Cookie；2 MiB/20k node/64 depth/64 attrs fail-closed。
- package 仅批准的三个精确直接依赖；Node24、dev/production build 全绿；全量验证全绿。

## 完成定义

资格报告回填本任务；红→绿；安全 Reviewer PASS；一个依赖资格+Feed安全逻辑提交；不得接线 Scheduler。

## 依赖与停止条件

- 依赖 D2 类型/预算。D7/D10 依赖本任务。
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
  Billion Laughs/未知实体 → 抛错；XInclude 惰性零解析；depth 64==接受/65 拒绝、maxNameLength、
  maxAttributesLength、maxTextLength 均按配置生效；零 `require`/`node:fs`/`node:http`/`fetch` 引用
  （注释剔除后字节扫描）。
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

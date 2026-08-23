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

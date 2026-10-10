# Conversation 闭合投影与流布局资格

只做 E2 容量准备，引用 `doc/stage7/detailed-design.md` §4.1。输入为本工具生成的旧格式合成
JSON，先经现有 ConversationStore 读取函数证明零丢弃，再独立投影。它不是不可信容器解析器，
不读真实 profile、Key、外网或 Electron，不改产品维护接线，也不授 E2 PASS。

## 固定支持范围候选

| 项目                  | 候选与计费口径                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 单消息                | 完整闭合消息对象的紧凑 JSON UTF-8 ≤4 MiB，含字段名、标点、中文及转义                                                                  |
| 会话                  | 整个 `{version:2,messages:[…]}` 紧凑 JSON UTF-8 ≤64 MiB，最多200条                                                                    |
| 旧输入                | 读文件前核对单文件长度≤64 MiB；旧格式缩进也占输入预算                                                                                 |
| 索引                  | 输入与闭合输出各≤64 KiB、最多50个不重复的 UUID、ephemeral=false                                                                       |
| 结构                  | 单会话/索引的原JSON和闭合投影均≤262144个值节点；根深度1、对象/数组及标量各计1节点，键不另计；原JSON深度≤16，当前闭合字段结构最大深度6 |
| 三库物理文件          | Sources 512 MiB、Research 64 MiB、Watch 512 MiB；这里只算容器容量，不重新测库                                                         |
| 四成员元数据          | manifest与result分别≤4 KiB，不沿用utility小应用的256 B消息门                                                                          |
| Conversations逻辑成员 | ≤3201 MiB，含index、子成员头与50份会话                                                                                                |
| 容器                  | ≤5 GiB，包含固定头、manifest和四个成员；不重复既有5 GiB I/O矩阵                                                                       |

这些是资源支持范围，绝不是全部合法历史数据的最大值。旧助手正文、标题、toolCalls数量和部分
字符串无总字节上限。超限或非法已知字段必须整会话/整操作受控失败并保留原件，不能切短文本、
丢字段、丢消息、跳过会话后报告成功。16条各恰4 MiB的消息加会话框架会超过64 MiB，必须拒绝；
各项上限必须同时满足，不能将它们的乘积当作保证。旧缩进文件超限而紧凑投影可容纳的情形也必须
明确拒绝并保留，不先无界解析。正式产品仍需实现可恢复错误态。

## 闭合字段

`projection.ts`逐字段重建以下结构，不复制原对象。未知字段在每层排除并计数；不把它们当作已允许字段。
已存在但非法的已知字段使整个投影失败，不复用旧读取器“丢非法扩展后保留文本”的容错作为成功证明。

- 消息：id、role、content、createdAt、status，以及可选errorCode/contextSource/toolCallId/toolStep/toolCalls/agentRun。
- ContextSource：mode、tabId、url、title、capturedAt、degraded、thin、selectionExcerpt、warnings。
- ToolStep：id、toolCallId、name、ok、contentPreview、errorCode、decision、createdAt。
- ToolCall：id、name、arguments；arguments始终为持久化字符串，不解析为执行输入。
- AgentRunSummary：requestId、sessionId、status、stepsUsed、maxSteps、finalText、toolStepCount。
- Session：id、title、createdAt、updatedAt、ephemeral。

已允许字符串逐字保留，不用提问16000字符、预览200字符或UI标题30字符去裁切旧存储已接受的值。
枚举和有限数字按现有共享类型/读取形状检查；不凭投影新增长期数据。tool仍须有匹配的前一assistant
调用引用且同一toolCallId不能重复，否则整会话失败。version1消息文件明确投影为version2；索引版本仍1。
当前工具保留声明过的可选字段，不通过角色注释擅自删除已存在且合法的字段。

## 固定逻辑布局提案

外层只有顺序固定的`sources/research/watch/conversations`四个逻辑成员，ID映射主进程固定目标，
不携带文件路径。外层头固定32 B、manifest≤4096 B、各成员头48 B，声明的总长度必须与实际EOF一致。
这次只给布局/算术与合成写入器，没有实现外来容器读取。

Conversations头24 B：magic8 B、version u32、子成员数u32、整个成员长度u64（含自身头）。
其后恰好1个index和索引声明的0～50个session，顺序与index相同。子成员头固定64 B：
kind u8、schemaVersion u8、零保留字段u16、ID16 B、payload长度u64、SHA256 32 B、零保留字段u32。
index的逻辑ID固定`index`，二进制ID为全零；session ID由合法UUID解码16 B生成，不从字符串拼路径。
index版本1、session版本2；声明长度只计紧凑JSON payload。UUID原有大小写保留，按忽略大小写的身份检查重复。
空索引是合法空集合，不能用省略index表达。
重复、未知、缺失、顺序不符、长度不符、摘要不符或尾随字节均不能构成完成。

最坏子成员容量严格为`24 + 51×64 + 65536 + 50×67108864 = 3355512024 B`，
3201 MiB成员上限余979752 B。四成员预算加头和最大manifest为4497346784 B，
5 GiB容器余871362336 B。没有把SHA256当作可信来源证明。

manifest闭合字段为formatVersion=1、productVersion（最多64个ASCII版本标记字符）、snapshotId
（规范UUID）、四个有序member。member只含id/present/schemaVersion（u32）/length（该成员上限）/
sha256（64小写hex；不存在成员为null且length=0）。result只含operationId/phase（固定validated）/
四个id、length、sha256、rows（0～MAX_SAFE_INTEGER）的投影及errorCode（null或固定≤22字符枚举）。
最大候选对象由`maximumMetadata()`计算。未来增加字段必须重新闭合，不能沿用本次对象尺寸推断新协议。

## 本次固定测量

一次Node运行，工作上限30秒，全部构建/合成原件/输出≤256 MiB。外层Job执行上限30秒；沿用现有
JobProcess的最多额外30秒强制退出确认，只用于清理，不能延长测量预算或继续工作。
事先生成measurement-plan原件，失败停止，不重试、不换样本、不放宽门；仍保留所有旧失败。

固定9个会话样本：全部允许嵌套字段、旧消息3,145,839 B中文包络、既有200消息×64toolCalls的
ASCII/中文/六字节转义三样本、200消息×256toolCalls、合法warnings使结构恰262144节点、
单消息恰4 MiB、200条消息合计恰64 MiB。另测50索引和全部51个
子成员的实际流写/flush/长度与EOF，流中只有1个大session，其余49个实际旧格式空会话。
每个帧以64 KiB写块输出；一次只投影一个会话，不把50份会话整读进内存。

记录旧读取耗时、JSON解码+投影耗时、字节/深度/节点、每消息采样RSS和Node报告的进程maxRSS，
不把采样最大值冒充不会漏峰的计量。`--expose-gc`仅在固定样本之间释放可回收对象，报告据实注明。
此小资格不提供完整导入时限、真实自然drain期限或Electron UI响应通过；库扫描/迁移、三库一致性、
快照、空间共存峰值、切换/回退、实际utility IPC速率/总量/退出与UI门仍需产品接线后的共同测量。

```powershell
# 小型纯验证与静态构建不运行容量样本：
node node_modules/vitest/vitest.mjs run tools/data-qualification/projection/projection.test.ts --maxWorkers=1
node --experimental-strip-types tools/data-qualification/projection/build.ts
# 主协调者明确给窗口后，只运行指定新ID一次：
pwsh -NoProfile -File tools/data-qualification/projection/run.ps1 -BuildId projection-<32位ID>
```

构建/运行原件在`log/stage7-e2/projection-<ID>/`，源码、产品依赖、实际bundle和launcher均绑定摘要。
run在Node预检前清理环境并finally恢复，非白名单变量真正移除；原子Job约束全部子进程，退出后核对归零。

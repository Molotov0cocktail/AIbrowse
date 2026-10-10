# 50 份完整 Conversation 合成集合

仅准备 Stage7 E2 容量输入。成功不表示备份、恢复、UI 或 Stage7 已通过。
本目录不运行 Electron、不注入真实 profile、不改变 E1 disposable-profile。

## 固定输入与输出

构建命令：`node tools/data-qualification/full-conversations/build.ts`。
它只创建新的 `log/stage7-e2/full-conversations-<UUID32>`，绑定源码、Node 版本和工具制品摘要。
后续由主协调在独立外层 Windows Job 下运行该目录的
`node prepare.cjs runtime-<原资格UUID32>`。参数仅允许已有固定 runtime ID，不能传任意路径。
本轮准备没有执行这两个命令，也没有生成大集合。

模板来自旧 runtime 原件的第一个 `exactSession()` 生成文件及其 fixture-proof 摘要。
工具用**当前产品** `parseBoundedJson/projectSession/sessionChunks` 再次校验，要求恰好
64 MiB、200 条消息、每条完整消息不超过 4 MiB、无排除字段且规范字节摘要不变。
旧 proof 只证明模板来源，不能替代当前产品投影检查。找不到原件或模板变化时失败，不换批重试。
索引复用 `fiftyIndex()`，由当前 `projectIndex` 校验闭合形状和 UUID。

输出为固定 `conversations/index.json` 和索引声明的 50 个 UUID JSON，均独立 `wx` 创建、
从偏移 0 连续写入、推进短写、flush，并以 64 KiB 读回 hash/EOF/身份。
不调用 hardlink、copyFile、truncate 或稀疏文件 API。拒绝链接、非普通文件、未知成员和已有目标；
最终整组 hash 后复核目录、输入及输出元数据。静止的自有场地是前提，这不是原子文件系统快照承诺。
所有失败原件和部分输出保留，无自动清理。受控纯测试仅清理自己创建的临时目录。

`fixture-proof.json` 包含每件字节数、SHA256、文件身份、模板来源、源码证明摘要和有界计数。
同一次运行还必须有 `prepare-result.json.completed=true`、外层实际 exit0/Job 归零及原截止证明；
单独 proof（例如末尾超过期限后留下的文件）不构成成功。
`verifyReplicas` 是生成期间独立读回入口，使用该次持有的精确身份事实，不信任外来 proof 选路径。
创建时绑定的源祖先、输出祖先和每件事实持续保留到完成；初始 build-proof 与来源 proof 均从同一次
有界读取解析并绑定原摘要。最后 fixture-proof 写入/读回后复核精确名单及稳定元数据，入口在
prepare-result 写入后再次执行同一完成检查。迟到变化保留原件并以 exit2 退出；不能认领新证明或新目录。
之后产品验收只使用真实 TransferPipeline 或正式发行 UI；工具不实现第二套容器或转移投影。

## 资源与证据边界

- 新数据为 `50 × 64 MiB + index`，上限 3201 MiB；工具制品/证明合计预留另 1 MiB。
- 只解析一次 64 MiB 模板，产品解析/投影会产生相应对象及瞬态字符串；内存随一份成员增长，
  不能把 64 MiB 输入界限说成 64 MiB RSS。其余复制和哈希使用 64 KiB 缓冲。
- 准备阶段独立协作期限 150 秒，超时停止、保留现场；同步 native IO 的硬停止依赖外层 Job。
  实际执行前由主协调另冻结 Job 工作/真实退出预算、RSS 上限和磁盘空间。未满足时不得运行。
- 此准备期限不授产品额度。后续真实转移继续受原 1500 秒总账本、1000 秒 Conversation、
  150 秒容器 IO 等正式阶段上限，以及最多 10 秒实际退出监督约束，不能因失败调宽。
- 小型 tests 覆盖原件变化、短写/零写、取消/末尾期限、跨 scope、重复 UUID、链接、覆盖、
  未知成员和输出变化；不能据此声称 50×64 MiB 容量已经实测。

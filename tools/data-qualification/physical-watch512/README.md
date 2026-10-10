# 固定 Watch512 Node 构造资格

合同见 `doc/stage7/tasks.md` 的 E2 物理上限差量。只复制既有合成 runtime 的110,444,544B Watch源，
在新 `physical-watch512-UUID` 根构造512MiB文件及独立SQLite backup。原件与失败scope保持。

生产schema/Watch scanner、十五表全部内容稳定摘要、版本、完整性/FK、页数/freelist须前后一致；
实际输入固定200规则、2800事件、8400证据项、1030摘要。小测试复用已审核H夹具，只读取其新建小副本。

复用原padding/backup/journal/allocation/io与同一个FixedTransferJob，原Sources/Research工具不改。
原生包装相对Sources只改固定域、scope/kind、来源清单和数据库成员，容量及所有预算保持：
两份512MiB、J128MiB、工具16MiB逐文件取整加1GiB；120秒工作/30秒退出、单进程commit2GiB、
采样RSS1GiB、Node old-space768MiB、100ms采样。Node24.18.0与字节SHA、源码/制品/输入proof/身份均绑定。

新独审与最终绑定后由主协调者只执行一次，首失败停止并保留，不放宽门或重用scope：

```powershell
node --experimental-strip-types tools/data-qualification/physical-watch512/build.ts
pwsh -NoProfile -File tools/data-qualification/physical-watch512/run.ps1 -ScopeId physical-watch512-<构建返回的ID>
```

纯测试只用单库≤1MiB；不授实际512MiB、Electron worker、三库与full50组合或E2整体PASS。
SQLite journal只报告离散观测和终态缺席，不声称连续峰值或磁盘预约。scope保存全部失败证据。

# Stage7 E4 performance check

This narrow Windows-only runner builds the ordinary production main, preload, and renderer and drives the public renderer bridge against ten local synthetic pages. It does not enable qualification or release branches, inject product measurements, read existing user data, call an external provider, or publish artifacts.

Build a new immutable scope:

```powershell
node --experimental-strip-types tools/data-qualification/performance-check/build.ts
```

Use the printed `scopeId` exactly once for the five-minute feasibility run:

```powershell
pwsh -NoProfile -File tools/data-qualification/performance-check/run.ps1 -ScopeId performance-check-<32 hex> -Mode feasibility
```

The fixed short baseline uses a separate fresh scope. It records six startup-only cold processes and then a seventh cold process that continues into the complete business baseline, with a 15-minute whole deadline. This keeps the measured startup profile stable before business measurements add Research rows:

```powershell
pwsh -NoProfile -File tools/data-qualification/performance-check/run.ps1 -ScopeId performance-check-<32 hex> -Mode baseline
```

The complete process measures 30 create-to-ready Tabs, 30 snapshots for each of three DOM fixtures, 30 searches over a tool-seeded 5000-row Sources database, ten first-token calls through a loopback OpenAI-compatible endpoint, and five completed Research tasks. The setup writes only synthetic fixture data under the isolated profile. A main-process helper uses Electron safeStorage for the synthetic local credential and creates the same credential-generation/target binding that the product later consumes. The local endpoint does not stand in for an external Provider; the result records that cell as `NOT RUN`.

Every fresh profile starts from the fixed E2 small-A four-domain fixture and then reaches exactly 5000 Sources. Before product startup the runner copies the closed fixed database and Conversation file set to an immutable inspection directory, verifies that copying changed neither the original bytes nor its file set, and hashes every fixed business table row and canonical Conversation file only from that copy. After Job-empty and writer retirement it repeats the same copy boundary into a new directory. Feasibility, historical long, fixed-long, and turnover modes require all four domains to remain identical. Baseline and candidate mode additionally bind the five fixed Research goals to their product-issued task IDs, require exactly five completed tasks and their fixed results, and reject every other new or changed business row.

Run the same fixed short workload on a fresh candidate scope and bind it to the frozen PASS baseline:

```powershell
pwsh -NoProfile -File tools/data-qualification/performance-check/run.ps1 -ScopeId performance-check-<candidate 32 hex> -Mode candidate -BaselineScopeId performance-check-<baseline 32 hex>
```

Candidate mode repeats all seven cold processes on its own fresh synthetic profile and applies every frozen baseline p95 threshold. Neither baseline nor candidate clears the operating-system cache. Keep both scopes; do not select a favorable subset of the seven starts.

The original dynamic two-hour run remains a FAIL and its `long` mode is retained only to replay that historical contract. The current supplement has two separate formal runs. After the offline runner and oracle receive review, run one two-hour fixed-identity scope:

```powershell
pwsh -NoProfile -File tools/data-qualification/performance-check/run.ps1 -ScopeId performance-check-<32 hex> -Mode fixed-long -BaselineScopeId performance-check-<baseline 32 hex>
```

The fixed run creates ten Tabs before the clock starts, then only activates and snapshots those existing documents. It performs no navigation, reload, close, or rebuild. After the ten-minute warmup, every native Job member must remain the same exact PID plus process-creation-time identity. The native member detail must sum exactly to the tree totals. Runtime-detectable crashes, absolute resource breaches, and page or interaction binding failures stop immediately. The complete native lifetime record proves births, retirements, PID reuse, missing identities, and member-set drift in the post-exit oracle without dropping any identity or sample. The unchanged fixed tree limits are 24 MiB/hour RSS, 24 MiB/hour private bytes, and 60 handles/hour.

Use another fresh scope for the single bounded turnover sequence:

```powershell
pwsh -NoProfile -File tools/data-qualification/performance-check/run.ps1 -ScopeId performance-check-<32 hex> -Mode turnover -BaselineScopeId performance-check-<baseline 32 hex>
```

Turnover mode is an 18-minute workload inside the approved 20-minute budget. Its immutable order is slots 0 through 9 and then 0 through 9 again. Before each replacement, the old Tab is bound by its hash, exact URL/canary, document ID, WebContents ID, and an exclusive renderer PID. The runner closes it and refuses to create the next generation until both Electron ownership and `app.getAppMetrics()` stop reporting that PID. After process exit, the native Job lifetime oracle separately requires that identity's `retiredObservedMs` to be no later than `createStartedMs`. Native retirement is an end-of-run fact rather than a live creation permit; observation latency that violates the inequality remains a complete FAIL. Shared or cached renderers, ambiguous identity, wrong-slot generations, or a missing retirement fail closed.

Each formal mode has a one-run budget. Runtime-detectable product, source, absolute-limit, and binding failures stop immediately. The first post-exit native fact-oracle failure ends that mode and stops any later formal mode. Keep every identity and sample; do not retry with another scope or adjust retirement time to select a favorable result. These offline harness changes do not enter the product closure and do not rebuild or replace the final FIRST package bound to 207cdde3.

Both supplement modes reuse only the exact PASS short baseline `performance-check-c8e3852d7c5e4e54b92b171652ba6f48` whose oracle SHA256 is `bd04e914df32a4661f2ba54216767ac4a1821278f4c0334ee3ed3bd9d49ad0ba`. Their changed tool hash is not silently accepted and does not require rerunning the seven-process baseline. Before either command can run, the independent oracle review must create `log/stage7-e4/performance-supplement-independent-review-001/baseline-applicability.json`. The runner and oracle require its exact baseline and FIRST-207 binding, the five reviewed executable supplement source hashes, the fixed FIRST 1321-file source manifest SHA256 `3a47ce55c6015c0bc92f5e57171f1b68d2eddab88be138bd515a0fcbe777e210`, both approved modes, and explicit `false` coverage for arbitrary additional turnover and longer-interval leaks. Every non-supplement build input must match that manifest except the exact ten React/ReactDOM/scheduler `node_modules` paths, whose paths and bytes must match the original PASS baseline build manifest SHA256 `3b4b4ab8f2dbf21abb7ee751fe22bba747d72de8300a2e8a1c13f6d7850d3a99`; no other dependency is exempted. The runner compares the complete build environment with that manifest before setup or runtime. The old baseline fixture, build entry, and Vite config must retain their exact old hashes. The review, source-manifest, and baseline-build files are held read-only throughout the run; a missing or changed file fails before product startup.

The native Job enforces 24 processes, 2/4 GiB process/tree commit, 1/2 GiB process/tree RSS, samples exact process identities and handle counts, and allows 125 minutes plus its fixed 30-second Job-empty proof for the two-hour route. Every ten-second resource point contains the exact PID plus decimal creation time and per-identity RSS/private/handles, while the 100 ms observer records bounded first/last/retired lifetime facts. The product also records bounded `app.getAppMetrics()` members every ten seconds and adds a final sample at workload completion. The runtime process clock and native Job root-start offset bind both streams to the same actual workload window; cleanup points after that window remain in evidence but do not enter growth calculations. Both clocks must start within ten seconds of their own measurement origin, reach the actual measured duration within ten seconds, and have no gap above 12 seconds.

Each synthetic Tab has a main-process tool expectation containing its exact tab ID, page index, navigation generation, and current document ID. Every snapshot must match the exact URL and visible canary and must preserve or advance the expected document generation for that operation. Any controlled WebContents renderer crash, including a remote page renderer rather than only the main UI, fails the run immediately.

The run rechecks every observed product/tool source and every executable artifact, then holds read-only, non-delete-sharing handles to them until the application has exited, the hashes have been checked again, and the oracle has finished. A run therefore fails closed if its exact bound source is already changing, and writers cannot replace a bound file during the measurement. The product source set is the actual Vite module graph plus this runner and the lifecycle guardian; unrelated installer/MSI sources are outside that lock.

The feasibility result proves only the ordinary 10-Tab, real IPC snapshot, resource observation, normal-exit, writer-retirement, and Job-empty path. It explicitly records Sources search, local provider, Research, and external provider as `not-run`; those short-baseline cells need separate product-bound execution and cannot be inferred from this run. For the external Provider cell the runner checks only whether the normal encrypted credential file exists. A missing file is recorded as `not-run-credential-file-missing`; a present file is `not-run-credential-file-present-has-key-not-checked`. The runner never reads or prints a key and never treats file presence as `hasKey` or as an executed network test.

The baseline oracle stores every sample plus p50/p95/max and freezes each candidate threshold as `baseline p95 × 1.20 + 20 ms`; absolute stop limits remain independent. Candidate and historical long runs require the same hashed performance-tool workload as the referenced baseline. Fixed-long and turnover instead require the exact preserved baseline fixture/build/config hashes plus the independently reviewed five-file supplement source map described above. All four modes require the same recorded OS, Node, CPU, memory, and active power-scheme environment, embed the exact PASS baseline report and its hash, and apply the corresponding startup, new-Tab, and per-DOM snapshot thresholds. CPU is reported from all `app.getAppMetrics()` members as interval-weighted logical-core milliseconds divided by observed wall time, plus peak aggregate percent. No CPU PASS threshold is inferred until the formal contract supplies one. The two-layer supplement proves only a two-hour fixed identity set and the one scheduled 20-replacement sequence; it does not prove arbitrary additional turnover or leaks visible only over a longer interval.

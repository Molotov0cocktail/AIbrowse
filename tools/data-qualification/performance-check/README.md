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

Every fresh profile starts from the fixed E2 small-A four-domain fixture and then reaches exactly 5000 Sources. Before product startup the runner copies the closed fixed database and Conversation file set to an immutable inspection directory, verifies that copying changed neither the original bytes nor its file set, and hashes every fixed business table row and canonical Conversation file only from that copy. After Job-empty and writer retirement it repeats the same copy boundary into a new directory. Feasibility and long mode require all four domains to remain identical. Baseline and candidate mode additionally bind the five fixed Research goals to their product-issued task IDs, require exactly five completed tasks and their fixed results, and reject every other new or changed business row.

Run the same fixed short workload on a fresh candidate scope and bind it to the frozen PASS baseline:

```powershell
pwsh -NoProfile -File tools/data-qualification/performance-check/run.ps1 -ScopeId performance-check-<candidate 32 hex> -Mode candidate -BaselineScopeId performance-check-<baseline 32 hex>
```

Candidate mode repeats all seven cold processes on its own fresh synthetic profile and applies every frozen baseline p95 threshold. Neither baseline nor candidate clears the operating-system cache. Keep both scopes; do not select a favorable subset of the seven starts.

After the feasibility evidence and runner receive review, create a fresh scope and run the fixed two-hour load:

```powershell
pwsh -NoProfile -File tools/data-qualification/performance-check/run.ps1 -ScopeId performance-check-<32 hex> -Mode long -BaselineScopeId performance-check-<baseline 32 hex>
```

Start this one long run only after known E3/E4 product failures are closed and the exact product source is frozen. A product failure, source change, missing sample, absolute-limit breach, or binding mismatch stops the run at its first failure; the runner does not retry inside the scope.

The native Job enforces 24 processes, 2/4 GiB process/tree commit, 1/2 GiB process/tree RSS, samples exact process identities and handle counts, and allows 125 minutes plus its fixed 30-second Job-empty proof. The product records all bounded `app.getAppMetrics()` members every ten seconds and adds a final sample at workload completion. The runtime process clock and native Job root-start offset bind both streams to the same actual workload window; cleanup points after that window remain in evidence but do not enter growth calculations. Both clocks must start within ten seconds of their own measurement origin, reach the actual measured duration within ten seconds, and have no gap above 12 seconds. After the fixed ten-minute warmup, RSS, private bytes, and handles use a separate OLS slope for every observed topology with at least 30 points spanning one hour. A sparse transition episode may contain at most two points over at most 20 seconds, must return to the same evaluated stable topology, and never counts as an OLS pass; at least one stable topology must qualify. This prevents opposite topology trends from cancelling without assuming a process count that the product does not promise. Both routes stop on their first failure and preserve the scope under `log/stage7-e4/`.

Each synthetic Tab has a main-process tool expectation containing its exact tab ID, page index, navigation generation, and current document ID. Every snapshot must match the exact URL and visible canary and must preserve or advance the expected document generation for that operation. Any controlled WebContents renderer crash, including a remote page renderer rather than only the main UI, fails the run immediately.

The run rechecks every observed product/tool source and every executable artifact, then holds read-only, non-delete-sharing handles to them until the application has exited, the hashes have been checked again, and the oracle has finished. A run therefore fails closed if its exact bound source is already changing, and writers cannot replace a bound file during the measurement. The product source set is the actual Vite module graph plus this runner and the lifecycle guardian; unrelated installer/MSI sources are outside that lock.

The feasibility result proves only the ordinary 10-Tab, real IPC snapshot, resource observation, normal-exit, writer-retirement, and Job-empty path. It explicitly records Sources search, local provider, Research, and external provider as `not-run`; those short-baseline cells need separate product-bound execution and cannot be inferred from this run. For the external Provider cell the runner checks only whether the normal encrypted credential file exists. A missing file is recorded as `not-run-credential-file-missing`; a present file is `not-run-credential-file-present-has-key-not-checked`. The runner never reads or prints a key and never treats file presence as `hasKey` or as an executed network test.

The baseline oracle stores every sample plus p50/p95/max and freezes each candidate threshold as `baseline p95 × 1.20 + 20 ms`; absolute stop limits remain independent. Candidate and long runs also require the same hashed performance-tool workload and the same recorded OS, Node, CPU, memory, and active power-scheme environment as the referenced baseline. Long-mode candidate runs embed the exact PASS baseline report and its hash, then apply the corresponding new-Tab and per-DOM snapshot thresholds. CPU is reported from all `app.getAppMetrics()` members as interval-weighted logical-core milliseconds divided by observed wall time, plus peak aggregate percent. No CPU PASS threshold is inferred until the formal contract supplies one.

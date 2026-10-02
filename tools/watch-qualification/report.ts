import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readEvidence } from './read-evidence.ts';
import { cadenceIssues, reportResources } from './resource-report.ts';
import { reportMain } from './main-report.ts';
import { reportExit } from './exit-report.ts';
import { reportBattery } from './battery-report.ts';
import { reportLoad } from './load-report.ts';

export function report(external: string, mainText: string): object {
  const evidence = readEvidence(external, mainText);
  const resources = reportResources(evidence.resources);
  const main = reportMain(
    evidence.resources.window,
    evidence.runId,
    evidence.main,
    cadenceIssues(evidence.resources),
  );
  const exit = reportExit(evidence.resources.window, evidence.records, main.traceComplete);
  const battery = reportBattery(
    evidence.resources.window,
    evidence.records,
    cadenceIssues(evidence.resources),
  );
  const load = reportLoad(
    evidence.resources.window.mode,
    evidence.runId,
    evidence.main,
    main.traceComplete,
  );
  // Unimplemented or externally reviewed gates stay explicit; local resource PASS is not H3b PASS.
  return {
    version: 1,
    runId: evidence.runId,
    mode: evidence.resources.window.mode,
    h3b: [resources.verdict, main.verdict, exit.verdict, battery.verdict, load.verdict].includes(
      'FAIL-product',
    )
      ? 'FAIL-product'
      : 'BLOCKED/evidence-insufficient',
    evidenceIssues: evidence.issues,
    observer: evidence.observer,
    pendingGates: ['独立关闭后DB业务复算', '安全隔离专项', '电池', 'Windows稳定性及完整生产冒烟'],
    resources,
    main,
    exit,
    battery,
    load,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [externalPath, mainPath, output] = process.argv.slice(2);
    if (!externalPath || !mainPath || !output || process.argv.length !== 5)
      throw new Error('参数无效');
    for (const path of [externalPath, mainPath])
      if (statSync(path).size > 64 * 1024 * 1024) throw new Error('证据过大');
    const result = report(readFileSync(externalPath, 'utf8'), readFileSync(mainPath, 'utf8'));
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write('独立报告已生成；总门结论见报告。\n');
  } catch {
    process.stderr.write('报告生成失败：检查参数、证据格式和输出文件是否已存在。\n');
    process.exitCode = 1;
  }
}

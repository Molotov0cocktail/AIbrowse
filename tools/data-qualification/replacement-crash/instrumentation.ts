import { createHash } from 'node:crypto';

const HELPER = `\nconst __aibrowseReplacementCrashBoundary = async (point: string): Promise<void> => {\n  const hook = (globalThis as typeof globalThis & {\n    __aibrowseReplacementCrashBoundary?: (point: string) => Promise<void>;\n  }).__aibrowseReplacementCrashBoundary;\n  if (typeof hook !== 'function') throw new Error('replacement crash插桩未绑定');\n  await hook(point);\n};\n`;

const INSERTIONS = [
  {
    anchor: '    const created = await file.stat({ bigint: true });\n',
    addition: "    await __aibrowseReplacementCrashBoundary('dataset-active-temp-created');\n",
  },
  {
    anchor: '    await file.writeFile(JSON.stringify(pointer(scope)));\n',
    addition: "    await __aibrowseReplacementCrashBoundary('dataset-active-temp-written');\n",
  },
  {
    anchor: '    await file.sync();\n',
    addition: "    await __aibrowseReplacementCrashBoundary('dataset-active-temp-flushed');\n",
  },
  {
    anchor: '    await rename(temp, path);\n',
    addition: "    await __aibrowseReplacementCrashBoundary('dataset-active-published');\n",
  },
  {
    anchor: '  await unlink(path);\n',
    before: "  await __aibrowseReplacementCrashBoundary('before-dataset-active-cleared');\n",
    addition: "  await __aibrowseReplacementCrashBoundary('dataset-active-cleared');\n",
  },
] as const;

function count(source: string, value: string): number {
  return source.split(value).length - 1;
}

export interface InstrumentedSource {
  readonly originalSha256: string;
  readonly instrumented: string;
  strip(): string;
}

/** Closed, build-time-only instrumentation for the fixed dataset-active source. */
export function instrumentDatasetActive(original: string): InstrumentedSource {
  if (original.includes('__aibrowseReplacementCrashBoundary'))
    throw new Error('dataset-active源码已含资格插桩标识');
  let instrumented = original;
  const importEnd = instrumented.lastIndexOf("from './dataset-layout';");
  if (importEnd < 0 || count(instrumented, "from './dataset-layout';") !== 1)
    throw new Error('dataset-active固定导入锚点缺失或重复');
  const helperAt = importEnd + "from './dataset-layout';".length;
  instrumented = instrumented.slice(0, helperAt) + HELPER + instrumented.slice(helperAt);
  for (const insertion of INSERTIONS) {
    if (count(instrumented, insertion.anchor) !== 1)
      throw new Error('dataset-active固定I/O锚点缺失或重复');
    const replacement =
      ('before' in insertion ? insertion.before : '') + insertion.anchor + insertion.addition;
    instrumented = instrumented.replace(insertion.anchor, replacement);
  }
  const strip = (): string => {
    let stripped = instrumented;
    for (const insertion of [...INSERTIONS].reverse()) {
      const replacement =
        ('before' in insertion ? insertion.before : '') + insertion.anchor + insertion.addition;
      if (count(stripped, replacement) !== 1) throw new Error('资格插桩无法闭合剥离');
      stripped = stripped.replace(replacement, insertion.anchor);
    }
    if (count(stripped, HELPER) !== 1) throw new Error('资格插桩helper无法闭合剥离');
    stripped = stripped.replace(HELPER, '');
    return stripped;
  };
  if (strip() !== original) throw new Error('资格插桩剥离后与原文不一致');
  return {
    originalSha256: createHash('sha256').update(original).digest('hex'),
    instrumented,
    strip,
  };
}

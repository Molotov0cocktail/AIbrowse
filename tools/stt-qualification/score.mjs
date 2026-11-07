import { readFileSync, writeFileSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function tokenize(text, language) {
  if (typeof text !== 'string' || !['en', 'zh', 'ja'].includes(language)) {
    throw new Error('参考文本、转写或语言无效。');
  }
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\p{P}/gu, '');
  return language === 'en'
    ? normalized.trim().split(/\s+/u).filter(Boolean)
    : [...normalized.replace(/\s/gu, '')];
}

export function editCounts(reference, hypothesis) {
  // Ties prefer substitution, then deletion, then insertion for reproducible counts.
  const rows = Array.from(
    { length: reference.length + 1 },
    () => new Uint32Array(hypothesis.length + 1),
  );
  for (let i = 0; i <= reference.length; i++) rows[i][0] = i;
  for (let j = 0; j <= hypothesis.length; j++) rows[0][j] = j;
  for (let i = 1; i <= reference.length; i++) {
    for (let j = 1; j <= hypothesis.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j - 1] + Number(reference[i - 1] !== hypothesis[j - 1]),
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
      );
    }
  }
  let i = reference.length;
  let j = hypothesis.length;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  while (i || j) {
    if (
      i &&
      j &&
      rows[i][j] === rows[i - 1][j - 1] + Number(reference[i - 1] !== hypothesis[j - 1])
    ) {
      substitutions += Number(reference[--i] !== hypothesis[--j]);
    } else if (i && rows[i][j] === rows[i - 1][j] + 1) {
      deletions++;
      i--;
    } else {
      insertions++;
      j--;
    }
  }
  return {
    substitutions,
    deletions,
    insertions,
    errors: substitutions + deletions + insertions,
    referenceUnits: reference.length,
    hypothesisUnits: hypothesis.length,
  };
}

export function scoreSample(sample, run, output) {
  const base = {
    id: sample.id,
    language: sample.language,
    metric: sample.language === 'en' ? 'WER' : 'CER',
    reference: sample.reference,
  };
  if (!run || run.status !== 'completed') {
    return { ...base, status: 'unscored', reason: run?.status ?? 'result_missing', rate: null };
  }
  if (!output || !Array.isArray(output.transcription)) {
    return { ...base, status: 'unscored', reason: 'transcription_missing', rate: null };
  }
  if (
    output.transcription.some(
      (segment) =>
        typeof segment?.text !== 'string' ||
        !Number.isFinite(segment?.offsets?.from) ||
        !Number.isFinite(segment?.offsets?.to) ||
        segment.offsets.from < 0 ||
        segment.offsets.to < segment.offsets.from,
    )
  ) {
    return { ...base, status: 'unscored', reason: 'transcription_invalid', rate: null };
  }
  const segments = output.transcription.map(({ text, offsets }) => ({
    text,
    offsets: { from: offsets.from, to: offsets.to },
  }));
  const rawText = segments.map((segment) => segment.text).join('');
  const scoringText = segments
    .map((segment) => segment.text)
    .join(sample.language === 'en' ? ' ' : '');
  const reference = tokenize(sample.reference, sample.language);
  const hypothesis = tokenize(scoringText, sample.language);
  if (!reference.length)
    return {
      ...base,
      status: 'unscored',
      reason: 'reference_empty',
      rawText,
      segments,
      rate: null,
    };
  if (reference.length * hypothesis.length > 4_000_000) {
    return {
      ...base,
      status: 'unscored',
      reason: 'alignment_budget_exceeded',
      rawText,
      segments,
      rate: null,
    };
  }
  const counts = editCounts(reference, hypothesis);
  return {
    ...base,
    status: 'scored',
    rawText,
    segments,
    normalizedReference: reference,
    normalizedHypothesis: hypothesis,
    ...counts,
    rate: counts.errors / counts.referenceUnits,
  };
}

export function scoreBatch(manifest, results, readOutput) {
  if (
    !Array.isArray(manifest.samples) ||
    !manifest.samples.length ||
    !Array.isArray(results.samples)
  )
    throw new Error('清单或结果 samples 无效。');
  const ids = new Set();
  for (const sample of manifest.samples) {
    if (typeof sample.id !== 'string' || !sample.id || ids.has(sample.id))
      throw new Error('清单 id 缺失或重复。');
    tokenize(sample.reference, sample.language);
    ids.add(sample.id);
  }
  const runs = new Map();
  for (const run of results.samples) {
    if (!ids.has(run.id) || runs.has(run.id)) throw new Error('结果包含未知或重复 id。');
    runs.set(run.id, run);
  }
  const samples = manifest.samples.map((sample) => {
    const run = runs.get(sample.id);
    let output;
    if (run?.status === 'completed') {
      try {
        output = readOutput(run);
      } catch {
        return {
          id: sample.id,
          language: sample.language,
          reference: sample.reference,
          status: 'unscored',
          reason: 'output_unreadable',
          rate: null,
        };
      }
    }
    return scoreSample(sample, run, output);
  });
  const languages = Object.fromEntries(
    ['en', 'zh', 'ja'].map((language) => {
      const expected = samples.filter((sample) => sample.language === language);
      const scored = expected.filter((sample) => sample.status === 'scored');
      const totals = {
        substitutions: 0,
        deletions: 0,
        insertions: 0,
        errors: 0,
        referenceUnits: 0,
        hypothesisUnits: 0,
      };
      for (const sample of scored)
        for (const key of Object.keys(totals)) totals[key] += sample[key];
      const complete = expected.length > 0 && expected.length === scored.length;
      return [
        language,
        {
          metric: language === 'en' ? 'WER' : 'CER',
          expected: expected.length,
          scored: scored.length,
          complete,
          ...totals,
          rate: complete && totals.referenceUnits ? totals.errors / totals.referenceUnits : null,
          partialRate: totals.referenceUnits ? totals.errors / totals.referenceUnits : null,
        },
      ];
    }),
  );
  return {
    schemaVersion: 1,
    complete: samples.every((sample) => sample.status === 'scored'),
    normalization:
      'NFKC、小写、删除 Unicode 标点；英文按空白分词，中日删除空白后按 Unicode 码点；不做繁简、数字、异体字或同音归一化。',
    samples,
    languages,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [manifestPath, resultPath, outputPath] = process.argv.slice(2);
    if (!manifestPath || !resultPath || !outputPath || process.argv.length !== 5)
      throw new Error('用法：node score.mjs <manifest.json> <result.json> <score.json>');
    const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
    const results = readJson(resultPath);
    const manifestSha256 = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
    if (results.manifest?.sha256 !== manifestSha256)
      throw new Error('输入清单摘要与运行结果不一致。');
    const report = scoreBatch(readJson(manifestPath), results, (run) => readJson(run.jsonPath));
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(`评分已保存：${outputPath}；完整性：${report.complete ? '完整' : '存在缺失'}`);
    if (!report.complete) process.exitCode = 1;
  } catch (error) {
    console.error(`评分失败：${error.message}`);
    process.exitCode = 1;
  }
}

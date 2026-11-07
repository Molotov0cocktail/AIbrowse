import assert from 'node:assert/strict';
import test from 'node:test';
import { editCounts, scoreBatch, scoreSample, tokenize } from './score.mjs';

const sample = { id: 'en1', language: 'en', reference: 'Hello, WORLD!' };
const run = { id: 'en1', status: 'completed' };
const output = (text) => ({ transcription: [{ text, offsets: { from: 0, to: 1500 } }] });

test('英文 NFKC、大小写和 Unicode 标点等价', () => {
  const result = scoreSample(sample, run, output('Ｈｅｌｌｏ world。'));
  assert.equal(result.rate, 0);
  assert.equal(result.referenceUnits, 2);
  assert.equal(result.rawText, 'Ｈｅｌｌｏ world。');
  assert.deepEqual(result.segments[0].offsets, { from: 0, to: 1500 });
});

test('完整返回替换、删除、插入数量', () => {
  assert.deepEqual(editCounts(['a', 'b', 'c'], ['a', 'x', 'c']), {
    substitutions: 1,
    deletions: 0,
    insertions: 0,
    errors: 1,
    referenceUnits: 3,
    hypothesisUnits: 3,
  });
  assert.equal(editCounts(['a', 'b', 'c'], ['a', 'c']).deletions, 1);
  assert.equal(editCounts(['a', 'c'], ['a', 'b', 'c']).insertions, 1);
  assert.deepEqual(editCounts([], ['x']), {
    substitutions: 0,
    deletions: 0,
    insertions: 1,
    errors: 1,
    referenceUnits: 0,
    hypothesisUnits: 1,
  });
});

test('缺失输出、失败进程、无效段均不能评分成功', () => {
  assert.equal(scoreSample(sample, undefined, undefined).status, 'unscored');
  assert.equal(
    scoreSample(sample, { status: 'process_failed' }, output('Hello world')).status,
    'unscored',
  );
  assert.equal(scoreSample(sample, run, {}).status, 'unscored');
  assert.equal(
    scoreSample(sample, run, { transcription: [{ text: 'hello world' }] }).status,
    'unscored',
  );
  assert.equal(scoreSample(sample, run, output(null)).status, 'unscored');
});

test('有效空转写计为全部删除；空参考不能产生零错误率', () => {
  const result = scoreSample(sample, run, { transcription: [] });
  assert.equal(result.rate, 1);
  assert.equal(result.deletions, 2);
  assert.equal(scoreSample({ ...sample, reference: '!!!' }, run, output('')).status, 'unscored');
});

test('中日按 Unicode 字符计数并保留书写差异', () => {
  assert.deepEqual(tokenize('你好， 世 界！', 'zh'), [...'你好世界']);
  assert.deepEqual(tokenize('今日は、晴れ。', 'ja'), [...'今日は晴れ']);
  assert.equal(
    scoreSample({ id: 'zh', language: 'zh', reference: '你好世界' }, run, output('你好世人')).rate,
    0.25,
  );
  assert.equal(
    scoreSample({ id: 'ja', language: 'ja', reference: '今日は晴れ' }, run, output('今日は 晴れ！'))
      .rate,
    0,
  );
  assert.equal(tokenize('𠮷', 'ja').length, 1);
  assert.notDeepEqual(tokenize('學', 'zh'), tokenize('学', 'zh'));
});

test('多段转写不粘连英文词；中日不插入计分空白', () => {
  const result = scoreSample(sample, run, {
    transcription: [
      { text: 'Hello', offsets: { from: 0, to: 10 } },
      { text: 'world', offsets: { from: 10, to: 20 } },
    ],
  });
  assert.equal(result.rate, 0);
  assert.equal(result.segments.length, 2);
});

test('部分批次不得显示完整语种指标', () => {
  const report = scoreBatch(
    { samples: [sample, { ...sample, id: 'en2' }] },
    { samples: [run] },
    () => output('Hello world'),
  );
  assert.equal(report.complete, false);
  assert.equal(report.languages.en.rate, null);
  assert.equal(report.languages.en.partialRate, 0);
  assert.equal(report.languages.en.expected, 2);
  assert.equal(report.languages.en.scored, 1);
  assert.equal(
    scoreBatch({ samples: [sample] }, { samples: [run] }, () => {
      throw new Error('缺文件');
    }).samples[0].reason,
    'output_unreadable',
  );
});

test('重复与未知结果 id 拒绝处理', () => {
  assert.throws(
    () => scoreBatch({ samples: [sample, sample] }, { samples: [] }, () => output('')),
    /重复/u,
  );
  assert.throws(
    () => scoreBatch({ samples: [sample] }, { samples: [run, run] }, () => output('')),
    /重复/u,
  );
  assert.throws(
    () => scoreBatch({ samples: [sample] }, { samples: [{ id: 'other' }] }, () => output('')),
    /未知/u,
  );
});

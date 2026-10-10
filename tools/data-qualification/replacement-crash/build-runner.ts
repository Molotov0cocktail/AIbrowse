import { resolve } from 'node:path';
import { buildRunner } from './build.ts';

// Build only. This entry never starts the interruption qualification matrix.
const [output, ...rest] = process.argv.slice(2);
if (!output || rest.length !== 0) throw new Error('请提供一个新的runner构建输出目录');
const built = await buildRunner(process.cwd(), resolve(output));
process.stdout.write(
  JSON.stringify({ artifact: built.artifact, inputs: built.sources.length }) + '\n',
);

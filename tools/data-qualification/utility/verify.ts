import { verify } from './build.ts';

if (process.argv.length !== 3) throw new Error('资格验证只接受固定格式构建ID');
const result = await verify(process.argv[2]);
process.stdout.write(`${JSON.stringify(result)}\n`);

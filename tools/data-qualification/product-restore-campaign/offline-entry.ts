import { offline } from './offline';
import { need } from './contract';

async function main(): Promise<void> {
  const [command, scene, appData, journal] = process.argv.slice(2);
  need(
    process.argv.length === 6 && (scene === 'R' || scene === 'P') && command && appData && journal,
  );
  await offline(command, scene, appData, journal);
}
void main().catch(() => {
  process.exitCode = 1;
});

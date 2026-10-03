import { writeFileSync } from 'node:fs';
import process from 'node:process';

import { app } from 'electron';

const output = `${JSON.stringify({
  appData: app.getPath('appData'),
  userData: app.getPath('userData'),
  sessionData: app.getPath('sessionData'),
})}\n`;
const outputPath = process.argv[2];
if (outputPath !== undefined) writeFileSync(outputPath, output, 'utf8');
process.stdout.write(output);
app.exit(0);

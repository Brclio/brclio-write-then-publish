import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

for (const file of readdirSync('tests').sort().filter(name => /(?:\.cjs|\.test\.mjs)$/.test(name))) {
  const result = spawnSync(process.execPath, [`tests/${file}`], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error('npm_execpath is required to prepare CodeGraph');
}

function runNpm(args) {
  const result = spawnSync(process.execPath, [npmExecPath, ...args], {
    env: { ...process.env, npm_config_global: 'false' },
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const tsc = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
);

if (!existsSync(tsc)) {
  runNpm([
    'install',
    '--global=false',
    '--include=dev',
    '--ignore-scripts',
    '--no-save',
    '--no-audit',
    '--no-fund',
  ]);
}

runNpm(['run', 'build']);

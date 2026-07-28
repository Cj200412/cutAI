import { spawn } from 'node:child_process';
import electronPath from 'electron';

const child = spawn(electronPath, ['desktop-dist/main.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, CC_SMOKE: '1' },
  windowsHide: true,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

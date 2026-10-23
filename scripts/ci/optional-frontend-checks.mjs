// 仅运行项目中真实存在的检查脚本，不虚构检查或模拟成功状态。
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
for (const candidates of [['lint'], ['typecheck'], ['test:ci', 'test:polish']]) {
  const name = candidates.find(candidate => pkg.scripts?.[candidate]);
  if (!name) {
    console.log(`[跳过] package.json 中没有脚本：${candidates.join(' 或 ')}`);
    continue;
  }
  console.log(`[执行] pnpm run ${name}`);
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['run', name], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status || 1);
}

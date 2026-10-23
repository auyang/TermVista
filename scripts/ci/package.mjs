#!/usr/bin/env node
// 本地打包命令行工具；请在目标操作系统上原生构建。
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const command = argv[0] || 'build';
const dryRun = argv.includes('--dry-run');
const targetOpt = argv.find(s => s.startsWith('--target='));
const target = targetOpt ? targetOpt.slice('--target='.length) : null;
const os = process.platform;
const choices = {
  darwin: { bundles: 'dmg', targets: ['aarch64-apple-darwin', 'x86_64-apple-darwin'] },
  win32: { bundles: 'nsis', targets: ['x86_64-pc-windows-msvc'] },
};
function exec(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  if (dryRun) return;
  const result = spawnSync(os === 'win32' && cmd === 'pnpm' ? 'pnpm.cmd' : cmd, args, {
    stdio: 'inherit', cwd: resolve('.'), shell: os === 'win32',
    env: { ...process.env, CI: process.env.CI || 'true' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!['build', 'check', 'doctor'].includes(command)) {
  console.error('用法：node scripts/ci/package.mjs [doctor|check|build] [--target=<triple>] [--dry-run]');
  process.exit(2);
}
if (command === 'doctor') {
  let missing = false;
  for (const file of ['package.json', 'pnpm-lock.yaml', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json']) {
    const exists = existsSync(file);
    console.log(`${exists ? 'OK' : '缺失'} ${file}`);
    missing ||= !exists;
  }
  const packageManager = JSON.parse(readFileSync('package.json', 'utf8')).packageManager;
  if (packageManager !== 'pnpm@10.32.1') {
    console.error(`packageManager 应为 pnpm@10.32.1，当前值为 ${packageManager ?? '未设置'}`);
    missing = true;
  } else {
    console.log(`OK ${packageManager}`);
  }
  exec('node', ['--version']);
  exec('pnpm', ['--version']);
  exec('cargo', ['--version']);
  if (missing) process.exit(1);
  process.exit(0);
}
if (!dryRun) {
  for (const file of ['package.json', 'pnpm-lock.yaml', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json']) {
    if (!existsSync(file)) throw new Error(`项目文件不存在：${file}`);
  }
}
if (command === 'check') {
  exec('pnpm', ['install', '--frozen-lockfile']);
  exec('node', ['scripts/ci/optional-frontend-checks.mjs']);
  exec('pnpm', ['run', 'build']);
  exec('cargo', ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--all', '--', '--check']);
  exec('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']);
  exec('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']);
  exec('cargo', ['clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets', '--locked', '--', '-D', 'warnings']);
} else {
  if (!choices[os]) throw new Error(`当前操作系统不支持打包：${os}`);
  if (target && !choices[os].targets.includes(target)) {
    throw new Error(`目标平台 ${target} 不支持在 ${os} 上构建，请使用目标操作系统的原生 Runner。`);
  }
  const args = ['tauri', 'build', '--bundles', choices[os].bundles];
  if (target) args.push('--target', target);
  exec('pnpm', args);
  console.log('安装包输出目录：src-tauri/target/<target?>/release/bundle/');
}

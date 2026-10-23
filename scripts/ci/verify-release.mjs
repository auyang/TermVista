import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const tag = process.argv[2];
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : '';
if (!semverPattern.test(version)) {
  throw new Error(`版本标签格式无效：${tag}。请使用 v0.5.0 或 v0.5.0-beta.1。`);
}
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const pkgPath = resolve('package.json');
const tauriPath = resolve('src-tauri/tauri.conf.json');
for (const f of [pkgPath, tauriPath]) if (!existsSync(f)) throw new Error(`缺少版本校验文件：${f}`);
const pkg = readJson(pkgPath);
const conf = readJson(tauriPath);
let tauriVersion = conf.version;
if (typeof tauriVersion !== 'string') throw new Error('tauri.conf.json 的 version 必须是字符串或相对 JSON 路径。');
if (tauriVersion.toLowerCase().endsWith('.json')) {
  const other = resolve(dirname(tauriPath), tauriVersion);
  if (!existsSync(other)) throw new Error(`tauri.conf.json 指向的版本文件不存在：${other}`);
  tauriVersion = readJson(other).version;
}
if (pkg.version !== version || tauriVersion !== version) {
  throw new Error(`版本不一致：tag=${version}，package.json=${pkg.version}，tauri.conf.json=${tauriVersion}`);
}
const manifest = resolve('src-tauri/Cargo.toml');
if (!existsSync(manifest)) throw new Error(`缺少 Cargo 清单：${manifest}`);
const src = readFileSync(manifest, 'utf8');
const lines = src.split(/\r?\n/);
const sectionStart = lines.findIndex(line => line.trim() === '[package]');
const sectionEnd = lines.findIndex((line, i) => i > sectionStart && line.trim().startsWith('['));
const packageSection = sectionStart < 0 ? '' : lines.slice(sectionStart + 1, sectionEnd < 0 ? undefined : sectionEnd).join('\n');
const rustVersion = packageSection.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!rustVersion) {
  throw new Error('src-tauri/Cargo.toml 的 [package] 缺少显式 version，无法安全校验发布标签。');
}
if (rustVersion !== version) {
  throw new Error(`版本不一致：Cargo.toml=${rustVersion}，tag=${version}`);
}
console.log(`版本校验通过：${tag}`);

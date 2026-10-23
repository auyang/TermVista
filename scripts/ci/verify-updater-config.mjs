import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const expectedIdentifier = 'com.aisshstudio.desktop';
const expectedEndpoint = 'https://github.com/auyang/TermVista/releases/latest/download/latest.json';

export function inspectUpdaterConfiguration(config, releaseConfig) {
  const issues = [];
  if (config.identifier !== expectedIdentifier) issues.push('Tauri application identifier 已变化。');
  if (config.bundle?.createUpdaterArtifacts !== false) issues.push('普通构建必须关闭更新包签名产物。');

  const updater = config.plugins?.updater;
  if (!updater || !Array.isArray(updater.endpoints)
    || updater.endpoints.length !== 1 || updater.endpoints[0] !== expectedEndpoint) {
    issues.push('更新端点必须指向 TermVista 官方 HTTPS Release latest.json。');
  }
  if (updater?.endpoints?.some((endpoint) => typeof endpoint !== 'string' || !endpoint.startsWith('https://'))) {
    issues.push('更新端点只能使用 HTTPS。');
  }
  if (updater?.requireSignedVersion !== true) issues.push('必须启用签名版本绑定。');
  if (updater?.allowDowngrades !== false) issues.push('必须禁止降级更新。');
  if (updater?.dangerousInsecureTransportProtocol === true
    || updater?.dangerousAcceptInvalidCerts === true
    || updater?.dangerousAcceptInvalidHostnames === true) {
    issues.push('禁止启用不安全传输或证书校验绕过选项。');
  }

  const pubkey = typeof updater?.pubkey === 'string' ? updater.pubkey.trim() : '';
  const decoded = pubkey ? Buffer.from(pubkey, 'base64') : Buffer.alloc(0);
  const keyText = decoded.toString('utf8');
  const keyLines = keyText.split(/\r?\n/);
  if (!pubkey || decoded.toString('base64') !== pubkey || keyLines.length < 2
    || !keyLines[0].startsWith('untrusted comment: minisign public key')
    || !/^[A-Za-z0-9+/]{50,}={0,2}$/.test(keyLines[1])) {
    issues.push('必须配置有效格式的 Tauri Minisign 更新公钥。');
  }

  if (releaseConfig?.bundle?.createUpdaterArtifacts !== true) {
    issues.push('Release 专用 Tauri 配置必须启用 createUpdaterArtifacts。');
  }
  return issues;
}

function main() {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const releaseConfig = JSON.parse(readFileSync('src-tauri/tauri.updater.release.conf.json', 'utf8'));
  const issues = inspectUpdaterConfiguration(config, releaseConfig);
  if (issues.length > 0) {
    for (const issue of issues) console.error(`更新配置检查失败：${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log('在线更新安全配置检查通过。');
}

if (basename(process.argv[1] ?? '') === 'verify-updater-config.mjs') main();

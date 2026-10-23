import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectUpdaterConfiguration } from '../scripts/ci/verify-updater-config.mjs';

function config() {
  return {
    identifier: 'com.aisshstudio.desktop',
    bundle: { createUpdaterArtifacts: false },
    plugins: {
      updater: {
        pubkey: '',
        endpoints: ['https://github.com/auyang/TermVista/releases/latest/download/latest.json'],
        requireSignedVersion: true,
        allowDowngrades: false,
      },
    },
  };
}

test('在线更新配置在未提供真实格式公钥时被拒绝', () => {
  const issues = inspectUpdaterConfiguration(config(), { bundle: { createUpdaterArtifacts: true } });
  assert.ok(issues.some((issue) => issue.includes('公钥')));
});

test('拒绝不安全端点、降级策略、关闭签名版本绑定及普通包开启签名', () => {
  const value = config();
  value.bundle.createUpdaterArtifacts = true;
  value.plugins.updater.endpoints = ['http://example.test/latest.json'];
  value.plugins.updater.allowDowngrades = true;
  value.plugins.updater.requireSignedVersion = false;
  const issues = inspectUpdaterConfiguration(value, { bundle: { createUpdaterArtifacts: false } });
  assert.ok(issues.some((issue) => issue.includes('普通构建')));
  assert.ok(issues.some((issue) => issue.includes('HTTPS')));
  assert.ok(issues.some((issue) => issue.includes('签名版本绑定')));
  assert.ok(issues.some((issue) => issue.includes('禁止降级')));
  assert.ok(issues.some((issue) => issue.includes('Release 专用')));
});

test('拒绝改变应用 identifier 或启用证书校验绕过', () => {
  const value = config();
  value.identifier = 'com.other.app';
  value.plugins.updater.dangerousAcceptInvalidCerts = true;
  const issues = inspectUpdaterConfiguration(value, { bundle: { createUpdaterArtifacts: true } });
  assert.ok(issues.some((issue) => issue.includes('identifier')));
  assert.ok(issues.some((issue) => issue.includes('证书校验绕过')));
});

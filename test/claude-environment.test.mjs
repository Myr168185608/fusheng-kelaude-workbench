import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeEnvironment } from '../lib/claude-environment.mjs';

test('removes inherited authentication, provider and config overrides, keeps default storage', () => {
  const rejected = {
    CLAUDE_CONFIG_DIR: '/wrong-config', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/wrong-secrets',
    claude_securestorage_config_dir: '/lowercase-secret', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret',
    ANTHROPIC_BASE_URL: 'https://wrong.invalid', ANTHROPIC_PROFILE: 'wrong', ANTHROPIC_FEDERATION_TOKEN: 'secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDECODE: 'nested-session', NODE_OPTIONS: '--require=/wrong', PYTHONPATH: '/wrong', PYTHONSTARTUP: '/wrong'
  };
  const env = claudeEnvironment({ env: { ...rejected, SAFE_WORKBENCH_TEST: 'allowed' } });
  for (const key of Object.keys(rejected)) assert.equal(env[key], undefined, `${key} must not reach the CLI`);
  assert.equal(env.SAFE_WORKBENCH_TEST, 'allowed');
  assert.equal(env.HOME, process.env.HOME);
});

test('operator proxy settings pass through unchanged', () => {
  const env = claudeEnvironment({ env: { HTTP_PROXY: 'http://proxy:8080', https_proxy: 'http://proxy:8080', ALL_PROXY: 'socks5://proxy', NO_PROXY: 'localhost' } });
  assert.equal(env.HTTP_PROXY, 'http://proxy:8080');
  assert.equal(env.https_proxy, 'http://proxy:8080');
  assert.equal(env.ALL_PROXY, 'socks5://proxy');
  assert.equal(env.NO_PROXY, 'localhost');
});

test('only a trusted server-selected configDir sets CLAUDE_CONFIG_DIR', () => {
  const env = claudeEnvironment({ configDir: '/srv/cloud-ops-workbench/config',
    env: { CLAUDE_CONFIG_DIR: '/request-body-value', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/wrong', SAFE_WORKBENCH_TEST: undefined } });
  assert.equal(env.CLAUDE_CONFIG_DIR, '/srv/cloud-ops-workbench/config');
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
  assert.equal('SAFE_WORKBENCH_TEST' in env, false);
});

test('inherited secret overrides are removed without mutating the parent process or input object', t => {
  const previous = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = '/inherited-secret';
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR; else process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = previous; });
  const input = { CLAUDE_CONFIG_DIR: '/wrong', SAFE_WORKBENCH_TEST: 'allowed' };
  const snapshot = { ...input };
  const env = claudeEnvironment({ env: input });
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
  assert.equal(process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/inherited-secret');
  assert.deepEqual(input, snapshot);
});

test('untrusted relative or non-string config selections fail before spawning', () => {
  for (const configDir of ['', '.', '../other', null, 123, {}]) {
    assert.throws(() => claudeEnvironment({ configDir }), TypeError);
  }
  assert.equal(claudeEnvironment().CLAUDE_CONFIG_DIR, undefined);
});

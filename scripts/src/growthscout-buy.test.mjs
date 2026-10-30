import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const runner = fileURLToPath(new URL('./growthscout-buy.mjs', import.meta.url));

test('memory signer persists public metadata only and can sign on subsequent runs', () => {
  const home = mkdtempSync(join(tmpdir(), 'growthscout-memory-test-'));
  const key = generatePrivateKey();
  const env = { ...process.env, BUY_HOME: home, BUY_ACCOUNT: 'test-agent', AGENT_PRIVATE_KEY: key };
  try {
    for (const command of ['--setup', '--check-signer']) {
      const output = execFileSync(process.execPath, [runner, command], { env, encoding: 'utf8' });
      const result = JSON.parse(output);
      assert.equal(result.address, privateKeyToAccount(key).address);
      assert.equal(result.privateKeyWrittenToDisk, false);
      assert.ok(!output.includes(key));
    }
    const files = readdirSync(home, { recursive: true });
    assert.ok(!files.some(f => f === 'keys' || f.startsWith('keys/')));
    for (const file of files) {
      const contents = readFileSync(join(home, file), 'utf8');
      assert.ok(!contents.includes(key), `Secret must not appear in ${file}`);
    }
    const other = spawnSync(process.execPath, [runner, '--setup'], {
      env: { ...env, AGENT_PRIVATE_KEY: generatePrivateKey() }, encoding: 'utf8',
    });
    assert.equal(other.status, 1);
    assert.match(other.stderr, /differs from the configured secret/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('unsafe payment arguments are refused before wallet access', () => {
  const validProbe = ['curl', '--max-amount', '.005', '-X', 'POST', '-H',
    'Content-Type: application/json', '--data', '{"query":"Celo"}',
    'https://gateway.usebuy.ai/v1/social/x/posts/search'];
  for (const args of [
    ['curl', '--max-amount', '1', 'https://gateway.usebuy.ai/v1/social/x/posts/search'],
    ['curl', 'https://gateway.usebuy.ai/v1/social/x/posts/search'],
    ['curl', '--max-amount', '.005', 'https://example.com'],
    ['send', '1', 'someone'],
    ['--force', '--setup'],
    [...validProbe, '--max-amount=1000'],
    [...validProbe, '-L'],
  ]) {
    const result = spawnSync(process.execPath, [runner, ...args], {
      env: { ...process.env, AGENT_PRIVATE_KEY: '' }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes('AGENT_PRIVATE_KEY must'), 'Fail before loading secrets');
  }
});

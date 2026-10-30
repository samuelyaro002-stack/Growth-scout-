#!/usr/bin/env node
/**
 * Replit Secrets -> buy SDK's process-only signer -> unchanged buy CLI.
 * No private key file, vendor patch, or disabled payment/storage safeguards.
 * Node >=22.15 is required for synchronous module-resolution hooks.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';
import {
  createAccount,
  createMemorySignerBackend,
  findAccount,
  isPrivateKey,
  loadSigner,
  setDailySpendCap,
} from '@celo/buy-keystore';
import { privateKeyToAccount } from 'viem/accounts';
import { claimSignerReservation } from './signer-budget-gate.mjs';

const require = createRequire(import.meta.url);
const stateKey = Symbol.for('growthscout.buy.memorySigner');
const args = process.argv.slice(2);
const reportMode = args[0] === '--report';
if (reportMode) args.shift();
let policy;
const name = process.env.BUY_ACCOUNT || 'agent';
const home = process.env.BUY_HOME || join(homedir(), '.growthscout-buy');
process.env.BUY_HOME = home;
// The adapter never uses the file backend, even if legacy configuration asks for it.
delete process.env.BUY_KEYSTORE_BACKEND;

function fail(message) {
  const error = new Error(message);
  error.safeForOutput = true;
  throw error;
}

async function initialize() {
  const key = process.env.AGENT_PRIVATE_KEY;
  // Do not forward the key to buy's curl subprocesses.
  delete process.env.AGENT_PRIVATE_KEY;
  delete process.env.BUY_IMPORT_KEY;
  delete process.env.BUDGET_DATABASE_URL;
  delete process.env.BUDGET_AUTHORITY_ID;
  delete process.env.BUDGET_RESERVATION_ID;
  if (!key || !isPrivateKey(key)) {
    fail('AGENT_PRIVATE_KEY must be a valid 0x-prefixed private key in Replit Secrets.');
  }
  let wallet;
  try {
    wallet = privateKeyToAccount(key);
  } catch {
    fail('AGENT_PRIVATE_KEY is not a valid signing key.');
  }
  const backend = createMemorySignerBackend();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  let account = await findAccount(name);
  if (account) {
    if (account.network !== 'mainnet' ||
        account.address.toLowerCase() !== wallet.address.toLowerCase()) {
      fail('Saved account differs from the configured secret or network. Nothing was replaced.');
    }
    await backend.setKey(account, key);
  } else {
    account = await createAccount(
      { name, network: 'mainnet', privateKey: key, setDefault: true },
      backend,
    );
  }
  // Preserve SDK's persistent reservations in addition to the report ledger.
  await setDailySpendCap(name, String(Math.round((policy?.dailyCapUsd ?? 0.01) * 1e6)));
  const signer = await loadSigner(name, backend); // SDK checks metadata/key agreement
  globalThis[stateKey] = { name, backend };
  return { account, signer, backend };
}

async function main() {
  if (reportMode) {
    if (process.env.REPORT_PURCHASES_ENABLED !== '1') fail('Report purchases are disabled.');
    try { policy = JSON.parse(process.env.GROWTHSCOUT_BUY_POLICY || 'null'); }
    catch { fail('Invalid report purchase policy.'); }
    if (!policy || !Array.isArray(policy.sources) || !policy.sources.length ||
        policy.sources.some(s => !['x', 'reddit', 'youtube'].includes(s)) ||
        !Number.isFinite(policy.dailyCapUsd) || policy.dailyCapUsd <= 0 || policy.dailyCapUsd > 1000 ||
        !policy.maxCallUsd || ['x', 'reddit', 'youtube'].some(s =>
          !Number.isFinite(policy.maxCallUsd[s]) || policy.maxCallUsd[s] < 0 ||
          policy.maxCallUsd[s] > 1000)) {
      fail('Invalid report purchase policy.');
    }
  }
  const allowed = ['--setup', '--check-signer', 'whoami', 'quote', 'curl'];
  // Existing probe passes --verbose before curl. Accept only the intended commands.
  const command = args.find(a => allowed.includes(a));
  if (reportMode && command !== 'curl') fail('Report mode permits only paid searches.');
  if (!command) fail('Supported commands: --setup, --check-signer, whoami, quote, curl.');
  if (args.some(a => ['--force', '--sandbox', '-s', 'send', 'setup', '--account'].includes(a))) {
    fail('Destructive setup, transfers, account overrides and network overrides are disabled.');
  }
  if (command === 'curl') {
    if (!reportMode) fail('Standalone paid probes are disabled; use the shared report budget.');
    const invocation = args[0] === '--verbose' ? args.slice(1) : args;
    const amount = Number(invocation[2]);
    const endpoints = {
      x: 'https://gateway.usebuy.ai/v1/social/x/posts/search',
      reddit: 'https://gateway.usebuy.ai/v1/social/reddit/posts/search',
      youtube: 'https://gateway.usebuy.ai/v1/social/youtube/videos/search',
    };
    const source = Object.keys(endpoints).find(s => endpoints[s] === invocation[9]);
    const limit = reportMode && source ? policy.maxCallUsd[source] : 0.0075;
    // Exact argv allowlist prevents aliases, duplicate/equals-form caps, redirects,
    // output-file flags or additional requests from weakening the probe restriction.
    if (invocation.length !== 10 ||
        invocation[0] !== 'curl' || invocation[1] !== '--max-amount' ||
        !Number.isFinite(amount) || amount <= 0 || amount > limit ||
        invocation[3] !== '-X' || invocation[4] !== 'POST' ||
        invocation[5] !== '-H' || invocation[6] !== 'Content-Type: application/json' ||
        invocation[7] !== '--data' ||
        !source || (reportMode ? !policy.sources.includes(source) : source !== 'x')) {
      fail('Only the capped USDC X-search probe invocation is permitted.');
    }
    let body;
    try { body = JSON.parse(invocation[8]); } catch { fail('Probe body must be JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        (reportMode ? typeof body.query !== 'string' || !body.query.trim() ||
          body.query.length > 256 || /[\u0000-\u001f]/.test(body.query) : body.query !== 'Celo')) {
      fail('Only the authorized Celo search probe is permitted.');
    }
    // Validate key shape before making any network request; never print the key.
    const key = process.env.AGENT_PRIVATE_KEY;
    if (!key || !isPrivateKey(key)) fail('AGENT_PRIVATE_KEY must be a valid 0x-prefixed private key in Replit Secrets.');
    const wallet = privateKeyToAccount(key).address.toLowerCase();
    try { await claimSignerReservation(`eip155:42220:${wallet}`, endpoints[source], amount); }
    catch { fail('Shared signer reservation not confirmed; nothing signed.'); }
  }
  const state = await initialize();
  try {
    if (command === '--setup' || command === '--check-signer') {
      if (args.length !== 1) fail('Setup and signer check take no extra arguments.');
      if (command === '--check-signer') {
        // Off-chain local check; no request, payment or signature is published.
        await state.signer.signMessage({ message: 'GrowthScout local signer check' });
      }
      process.stdout.write(JSON.stringify({
        ready: true,
        account: state.account.name,
        address: state.account.address,
        network: state.account.network,
        signer: 'Replit Secrets -> buy SDK memory backend',
        privateKeyWrittenToDisk: false,
        dailyCapUsd: policy?.dailyCapUsd ?? 0.01,
      }) + '\n');
      return;
    }
    const cliPath = require.resolve('@celo/buy/dist/main.js');
    const cliDirectory = pathToFileURL(dirname(cliPath) + '/').href;
    const adapterUrl = new URL('./growthscout-keystore-adapter.mjs', import.meta.url).href;
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        // Only redirect CLI imports; the adapter itself imports the original SDK.
        if (specifier === '@celo/buy-keystore' &&
            context.parentURL?.startsWith(cliDirectory)) {
          return { url: adapterUrl, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    try {
      process.argv = [process.execPath, cliPath, '--account', name, ...args];
      await import(pathToFileURL(cliPath).href);
    } finally {
      hooks.deregister();
    }
  } finally {
    await state.backend.deleteKey(state.account);
    delete globalThis[stateKey];
  }
}

main().catch(error => {
  // Never serialize error causes, environment variables or wallet objects.
  process.stderr.write(JSON.stringify({
    error: error.safeForOutput ? error.message : 'Signing operation failed; no automatic retry.',
  }) + '\n');
  process.exitCode = 1;
});

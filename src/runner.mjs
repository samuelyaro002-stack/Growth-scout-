#!/usr/bin/env node
/**
 * Host secret -> buy SDK's process-only signer -> unchanged buy CLI.
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
import { validateInvocation, validatePolicy } from './invocation-policy.mjs';

const require = createRequire(import.meta.url);
// Wallet apps (MetaMask) export the key without the 0x prefix; accept both.
if (process.env.AGENT_PRIVATE_KEY && /^[0-9a-fA-F]{64}$/.test(process.env.AGENT_PRIVATE_KEY.trim())) {
  process.env.AGENT_PRIVATE_KEY = '0x' + process.env.AGENT_PRIVATE_KEY.trim();
}
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
  if (!key || !isPrivateKey(key)) {
    fail('AGENT_PRIVATE_KEY must be a valid 0x-prefixed private key in the host secret settings.');
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
    if (!validatePolicy(policy)) fail('Invalid report purchase policy.');
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
    // Exact argv + endpoint + body allowlist (see invocation-policy.mjs).
    try { validateInvocation(invocation, policy); }
    catch (e) { fail(e.message); }
    // Validate key shape before making any network request; never print the key.
    const key = process.env.AGENT_PRIVATE_KEY;
    if (!key || !isPrivateKey(key)) fail('AGENT_PRIVATE_KEY must be a valid 0x-prefixed private key.');
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
        signer: 'environment secret -> buy SDK memory backend',
        privateKeyWrittenToDisk: false,
        dailyCapUsd: policy?.dailyCapUsd ?? 0.01,
      }) + '\n');
      return;
    }
    const cliPath = require.resolve('@celo/buy/dist/main.js');
    const cliDirectory = pathToFileURL(dirname(cliPath) + '/').href;
    const adapterUrl = new URL('./keystore-adapter.mjs', import.meta.url).href;
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

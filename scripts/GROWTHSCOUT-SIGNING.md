# GrowthScout signing in this project

The installed buy CLI's OS keychain could not store a key in this environment.
Its file backend deliberately refuses mainnet. Neither safeguard was removed.

The project adds a custom CLI adapter using the SDK's exported memory backend.
This is not a native CLI setting or an independently audited production signer.
It was locally tested and used for a single successful mainnet data purchase.

## Run

Keep `AGENT_PRIVATE_KEY` in Replit Secrets. Use a dedicated low-balance wallet.

```sh
pnpm --filter @workspace/scripts run growthscout:setup
pnpm --filter @workspace/scripts run growthscout:whoami
# Paid standalone probes are now refused. Use the shared report budget.
```

Pulse and Audit use the same memory signer, through the existing API server.
No additional mainnet purchase was made while integrating those routes.

## Report purchases

The server lives in `artifacts/api-server`, with the imported GrowthScout domain
code and signer in `lib/growthscout`. It exposes the original `/api/pulse`,
`/api/audit`, `/api/sample`, and `/api/receipts` routes plus
`/api/growthscout/health` and `/api/growthscout/agent`. No new visual frontend
was added. The original upload remains under `.local` as a reference, not as a
runtime dependency.

Live supplier buying is **off by default**. Configure these as non-secret
environment variables only when you intend to allow real wallet spending:

| Variable | Default | Purpose |
| --- | --- | --- |
| `REPORT_PURCHASES_ENABLED` | off | Set `1` to allow report purchases |
| `BUY_ALLOWED_SOURCES` | `x,reddit,youtube` | Only these fixed gateway search endpoints |
| `BUY_MAX_X_USD`, `BUY_MAX_REDDIT_USD`, `BUY_MAX_YOUTUBE_USD` | `0.0075` each | Per-call ceilings |
| `MAX_SPEND_PER_REQUEST_USD` | `0.0225` | Worst-case report budget |
| `DAILY_SPEND_CAP_USD` | `0.01` | Shared UTC-day ceiling; uncertain payments count |
| `BUY_ACCOUNT` | `agent` | Must match the saved public account and secret |
| `BUY_HOME` | `~/.growthscout-buy` | SDK public metadata, reservations and receipts |
| `DATA_DIR` | `data/growthscout` | Legacy evidence / local fixtures only; never a live budget |
| `BUDGET_DATABASE_URL` | unset | Secret: restricted-role connection to ONE shared authority database |
| `BUDGET_AUTHORITY_ID` | unset | Public UUID pinned to the wallet policy in that authority |

The daily default is intentionally unchanged from the probe. At that budget
an Audit may be partial because it needs three supplier calls; choose an
explicit budget before enabling live reports. Each call is also limited to
1.5 times its catalogue price. Supplier payments use USDC, not customer-selected
tokens. Customer receipts are recorded only after x402 confirms settlement.
The configured facilitator may require its own `X402_API_KEY` secret to settle
customer payments; the previous developer-funded probe did not test that flow.

For local fixture-only requests, use `MOCK_BUY=1` and `DEV_NO_PAYWALL=1`.
Paywall bypass is refused with real supplier buying or in production.
Do not expose this fixture mode as a real paid service.

## Storage and checks

- Each process loads the key into the SDK memory backend from Replit Secrets.
- The key is removed from the environment before buy spawns curl.
- SDK account/address matching and buy's settlement checks remain enabled.
- Public account metadata, spend reservations and receipts are stored under
  `~/.growthscout-buy` by default (`BUY_HOME` can override it).
- No private-key file is written. Secrets still need protection, and process
  memory can be compromised by malicious code with sufficient access.
- Do not automatically retry an uncertain settlement or failed provision.
- Dependency updates must revalidate the adapter's module-resolution hook.
- Curl accepts only POST JSON search requests to the configured gateway endpoints.
  Account overrides, redirects, extra flags and alternate tokens are refused.
- Signer subprocesses receive an allowlisted environment, not session/API secrets.
  Supplier error text is not written to the report ledger or returned to customers.

### Budget persistence and recovery

Live reports now require PostgreSQL reservations. There is **no fallback** to
`DATA_DIR`, `BUY_HOME`, an empty ledger or the environment's `DATABASE_URL`.
`REPORT_PURCHASES_ENABLED=1` alone no longer authorizes signing.

All replicas and spending environments for the same chain/wallet must use
**the same `BUDGET_DATABASE_URL` authority and `BUDGET_AUTHORITY_ID`**. Managed
development and production databases are separate; copying the schema or policy
to each would incorrectly reset the budget. Use a dedicated shared PostgreSQL
authority (an explicitly chosen external database when spanning environments),
or do not enable live spending in the second environment. Do not provision an
independent authority for a wallet that is already spending elsewhere.

The wallet policy, not an instance's environment, owns the daily cap. A process
whose `DAILY_SPEND_CAP_USD` differs from the policy cannot reserve. The wallet
key is `eip155:42220:<lowercase signing-wallet address>`; account aliases, customer
payment addresses and environment names do not create new budgets.

Reservations and evidence commit under a transaction-scoped wallet advisory
lock, with integer microdollar limits and database UTC timestamps. The signer
child then consumes a unique `launched` event before activating its signer. A reused,
missing or completed reservation cannot sign again. Database credentials are
removed from the child environment before buy/curl starts, like the signing key.

Unfinished, failed and uncertain purchases hold their original maximum
**indefinitely**, including after crashes or UTC midnight. Only durable confirmed
supplier evidence ends a reservation. A lost commit acknowledgement may hold
funds without a purchase: this is intentional. Never automatically retry.

Customer records are distinct: `generated` is a report, `customer_pending` is an
intent saved before the facilitator is called, and `settled` requires confirmed
settlement. Transaction/asset deduplication prevents counting a replay twice.
If final receipt persistence fails after payment, the pending record remains
unresolved and an operator error is raised; it does not falsely count a sale or
tell a charged customer they were not charged. Receipt summaries expose
`customers.settlementsNeedingReview`. No payment signature/provider output is stored.

`/api/growthscout/health` exposes `budgetReady` and the effective
`purchasesEnabled`. `/api/receipts` returns 503 rather than misleading zero totals
when the shared authority is unavailable. Schema and policy creation never run
at API startup or in deployment build hooks.

### Provisioning the authority (operator approval required)

The development DB was empty when the additive `growth_wallets` and
`growth_evidence` tables were added through the existing Drizzle dev workflow.
No existing database was replaced, legacy evidence was imported, or live wallet
policy was created/enabled. Integration tests use temporary synthetic-wallet
policies and remove only their own data. No production database was modified.

1. Stop all old spending processes, including any other projects using this wallet.
   Preserve `DATA_DIR`, `BUY_HOME`, the probe's receipts and any published instances.
   Obtain approval before any existing-data migration.
2. Choose one durable shared authority. Apply the schema in
   `lib/db/src/schema/growth-budget.ts` through its owner's approved schema workflow.
   Do not use a managed-production schema migration script: Replit Publish manages
   that schema, and a per-environment managed DB is not a shared wallet authority.
3. Provision a dedicated **login role** with no superuser, DB creation, role creation,
   bypass-RLS or owner membership. The schema owner grants only:

   ```sql
   GRANT USAGE ON SCHEMA public TO growthscout_runtime;
   GRANT SELECT ON public.growth_wallets TO growthscout_runtime;
   GRANT SELECT, INSERT ON public.growth_evidence TO growthscout_runtime;
   ```

   The role must not inherit policy INSERT/UPDATE, evidence UPDATE,
   DELETE/TRUNCATE, schema CREATE, or ownership privileges, including via PUBLIC.
   Configure role credentials through the provider's secure console and Replit
   Secrets, never source files/chat. Runtime privilege checks reject owner/admin
   connections. Test fixtures impersonate a no-login test role solely for testing;
   that is not the production credential setup.
4. As owner, provision a policy for the public wallet address with a fresh authority
   UUID, `daily_micro=22500` (the approved $0.0225), `enabled=false`,
   `reconciled=false`. Keep it disabled while reviewing/importing prior evidence.
   Preserve original UTC timestamps and reservation IDs; synthesize held reservations
   for uncertain legacy spends that lack one. Ignore legacy release records for any
   unknown payment. Backfill verified prior receipts without counting generated
   reports as sales. Never delete historical evidence to reset a cap.
5. Only after independently reconciling all historical/unfinished payments and
   verifying that no other authority is active, the owner may approve
   `reconciled=true` and `enabled=true`. There is deliberately no automatic
   migration, reconciliation or budget-policy creation in the API.
6. Add the restricted role's connection as the **same** `BUDGET_DATABASE_URL` secret
   in every configured spending environment and pin the same public
   `BUDGET_AUTHORITY_ID`. Do not store the admin credential in the app. Leave
   `DAILY_SPEND_CAP_USD=0.0225` and the approved per-request/per-call limits unchanged.
7. Check health/readiness and receipts first without payment. Only perform a live
   purchase or publish after explicit authorization.

Append-only permissions protect receipts against the runtime role, not the DB
owner or hosting provider. Restrict owner credentials and back up the authority.
After restoring a snapshot, leave spending disabled until all activity after the
snapshot is reconciled; an old backup must not give a wallet a fresh budget.

If an old `ledger.lock` remains, preserve it and the files for reconciliation;
do not remove reservations or replay a purchase because its status is unknown.

Local non-payment checks:

```sh
pnpm --filter @workspace/scripts run growthscout:signer-test
pnpm --filter @workspace/growthscout test
pnpm run typecheck
node scripts/src/growthscout-buy.mjs --check-signer
```

The automated report tests use synthetic keys, a local fake facilitator and
an injected non-payment supplier runner. They verify x402 routing and receipt
handling without moving money. They are not proof of a live customer sale.
`test/pg-ledger.test.ts` additionally exercises real development PostgreSQL with
temporary restricted roles: competing independent pools/processes, UTC rollover,
restart, write failure, lost commit acknowledgement, immutable evidence and
one-use signer claims. It skips DB integration only if `DATABASE_URL` is absent;
CI must provide a disposable/dev PostgreSQL database for that coverage.

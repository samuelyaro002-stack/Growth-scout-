# GrowthScout

A growth-intelligence agent for Web3 projects, built for the **Celo "Agents on Open Rails"** hackathon.

**What it does.** A project pays a few cents in stablecoins and gets a growth report with an Africa lens. To produce each report the agent itself pays for live X, Reddit and YouTube data through [buy](https://usebuy.ai). Two payment flows, both on Celo mainnet:

```
 customer ──x402 (USDC / USA₮)──▶ GrowthScout ──x402 via buy (USDC)──▶ X / Reddit / YouTube data
   pays $0.02–$0.10                  analyses, scores                      pays ~$0.005 per call
```

| Route | Price | Data bought | Output |
|---|---|---|---|
| `POST /api/pulse` | $0.02 | X | score, Africa-mention share, sentiment, top posts |
| `POST /api/audit` | $0.10 | X + Reddit + YouTube | all of the above + an evidence-graded growth plan |
| `GET /api/sample` | free | fixture (labelled) | sample report for prospects |
| `GET /api/receipts` | free | – | public ledger: supplier purchases, reports generated, customer payments **confirmed by the facilitator** |
| `GET /.well-known/agent.json` | free | – | ERC-8004 registration file |
| `GET /health` | free | – | status |

**Tracks targeted:** Build with buy, and USA₮ with x402.

## Live proof

> Filled in from the real paid run. Anything not listed here has not happened.

| Item | Value |
|---|---|
| Live URL | _(set after deploy)_ |
| ERC-8004 agent id / registration tx | _(set after registration)_ |
| Agent wallet | `0x91a1F1d9CA6f8649A907Fd5EcCf886E46CbCEf32` |
| Supplier purchases through buy (tx hashes) | _(from the paid run)_ |
| Customer settlement tx(s) | _(from the paid run)_ |

The first customer report is a **developer-funded test** for GG Attention, a project the author also builds, so it is not counted as independent demand. See *Honest limits*.

## How the report is made

1. A customer calls `/api/audit`; the x402 middleware answers `402` with the price, payee and builder code.
2. The customer signs a payment; the facilitator verifies it.
3. The agent reserves worst-case budget, then buys one search each from X, Reddit and YouTube through `buy`, one signed payment per call, never retried if the outcome is uncertain.
4. The analysis (deterministic, no LLM) removes duplicate posts across sources, keeps only posts that mention the project, and **uses only posts with a verifiable publication date in the last 30 days** as the basis for recommendations. Fewer than three such posts ⇒ `confidence: "low"` and no growth plan is sold on thin evidence.
5. If nothing usable was bought, the route returns 4xx/5xx, which means the x402 middleware **does not settle** and the customer is not charged.
6. After settlement the facilitator's confirmation, tx hash and payer are written to the public ledger.

## Deploy (free, from this repo)

Runs on Node ≥ 22.15 (the signer needs synchronous module hooks). `render.yaml` is a ready Render Blueprint:

1. Render → New → Blueprint → pick this repo. It builds with `npm ci` and starts with `npm start`.
2. In the dashboard, set secrets: `AGENT_PRIVATE_KEY` (dedicated low-balance wallet, never your main one), `X402_API_KEY` (from <https://x402.celo.org>: connect the wallet, sign a free message) and `PUBLIC_URL` (the service URL, no trailing slash).
3. Check `GET /health`, then `GET /.well-known/agent.json`.
4. Set `REPORT_PURCHASES_ENABLED=1` only when you are ready for the agent to spend.

**Free-host caveat.** A free web service has an ephemeral disk and sleeps when idle. The ledger behind `/api/receipts` and the daily cap reset when the process restarts, so the on-chain transactions listed above are the durable record. A health ping every 5 minutes keeps it awake.

## How buy runs without a keychain

buy's own file keystore refuses mainnet and a server has no OS keychain, so `src/runner.mjs` loads the key from an environment secret into the buy SDK's **in-memory** signer backend and then runs the unchanged `buy` CLI. The key is never written to disk and is removed from the environment before the CLI starts curl. Only fixed gateway search endpoints, a fixed argument shape and a hard per-call price ceiling are accepted. `npm run check-signer` prints the wallet address without making any payment.

## ERC-8004 identity

The identity is an NFT minted to the wallet that sends the registration. **That wallet must be the one in your hackathon entry.**

1. The server is up at `PUBLIC_URL` (it serves `/.well-known/agent.json`).
2. The wallet holds ≥ 0.05 USDC or ≥ 0.01 CELO for gas.
3. Dry run (sends nothing): `npm run register`
4. Broadcast: `npm run register -- --send`. It goes through the tagged wallet client, so it carries `celo_16de1003cce6`, and the script confirms the tag on-chain.
5. Set `AGENT_ID=<the id>` and restart. Check it on <https://8004scan.io/>.

## Attribution tag

`celo_16de1003cce6` is attached where the wallet client is built (`src/tag.ts`), so no transaction the agent sends itself can forget it; the tests sign real transactions locally and check the raw bytes. Verify any mainnet tx with `npm run verify-tx -- 0x…`.

x402 settlements are submitted by Celo's facilitator, which does not write attribution tags yet, and the same applies to the payments buy makes for us. We declare our code in every 402 (`builder-code` extension) so it is credited once the facilitator ships. The organisers confirmed that x402 needs only a `payTo` wallet.

## Safety rails

- **Worst-case spend caps.** Every purchase is capped at 1.5× its catalogue price and the caps count that worst case until buy's quote is read.
- **One shared budget.** Budget is reserved in one synchronous step before anything is signed, so concurrent requests cannot jointly exceed `DAILY_SPEND_CAP_USD`.
- **No blind retries.** A failed purchase may or may not have settled, so it keeps its worst-case hold and is never retried.
- **Customers are not charged for failures.** No usable evidence ⇒ 4xx/5xx ⇒ no settlement.
- **Evidence cannot overstate itself.** Three separate counts: supplier purchases, reports generated (not a sale) and customer payments confirmed by the facilitator. A cached report returns no purchase evidence.
- **No shell, no secrets in logs.** The signer is spawned with an argument array and an allowlisted environment; supplier error text is not stored.
- Fund the wallet like a float, not a treasury. buy is pre-1.0 beta software without an external security review.

## USA₮

USDC is always offered. USA₮ is offered only when its EIP-712 domain is configured, since a wrong value breaks every signature: run `npm run probe:usat`, then set `USAT_EIP712_NAME` and `USAT_EIP712_VERSION`.

## What is and isn't verified

Verified by `npm test` (43 tests): tag encoding and placement, worst-case caps, concurrent requests sharing one budget, never-retry behaviour, request validation, de-duplication and recency rules, the signer's argument and environment isolation, and the **real x402 middleware** returning a correct 402 and completing a full signed payment against a stand-in facilitator, ending in a recorded "settled" entry.

Not covered by tests: a live settlement through `api.x402.celo.org`, a live purchase of all three sources, and the registration transaction. The *Live proof* table above is filled in only from those real runs.

## Honest limits

Sentiment is a keyword lexicon and the score is a transparent heuristic (see `methodology` in each report). "Africa share" is the share of matching posts that *mention* African countries, cities or local-currency terms; it does not measure where the audience lives. The rules require independent users, meaning wallets that were not funded by the builder, and the first report here is a developer-funded test.

## Scripts

`npm start` · `npm test` · `npm run typecheck` · `npm run check-signer` · `npm run check-tag` · `npm run probe:usat` · `npm run register` · `npm run verify-tx`

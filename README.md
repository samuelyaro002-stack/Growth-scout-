# GrowthScout

A growth-intelligence agent for Web3 projects, built for the **Celo "Agents on Open Rails"** hackathon.

**What it does.** Projects pay a few cents in stablecoins to get a growth report with an Africa lens. To produce each report the agent itself pays for live X, Reddit and YouTube data through [buy](https://usebuy.ai). So there are two payment flows on Celo mainnet:

```
 customer ──x402 (USDC / USA₮)──▶ GrowthScout ──x402 via buy (USDC)──▶ X / Reddit / YouTube data
   pays $0.02–$0.10                  analyses, scores                      pays ~$0.005 per call
```

| Route | Price | Data bought | Output |
|---|---|---|---|
| `POST /api/pulse` | $0.02 | X | score, Africa-mention share, sentiment, top posts |
| `POST /api/audit` | $0.10 | X + Reddit + YouTube | all of the above + prioritised growth plan |
| `GET /api/sample` | free | fixture (labelled) | sample report for prospects |
| `GET /api/receipts` | free | – | public ledger, three separate counts: supplier purchases, reports generated, customer payments **confirmed by the facilitator** |
| `GET /.well-known/agent.json` | free | – | ERC-8004 registration file |

Margin: an audit costs about $0.015 in data and sells for $0.10.

**Tracks targeted:** Build with buy (verified paid calls into services we don't control) and USA₮ with x402 (real customers settling through Celo's facilitator).

---

## Setup on Replit

1. **Get the code into Replit.** Push this folder to a **public GitHub repo** (required by the rules), then import that repo into Replit. Your attribution tag may be derived from the repo, so see *Attribution tag* below before sending any transaction.
2. **Secrets** (Replit → Tools → Secrets). Copy names from `.env.example`. Minimum:
   - `AGENT_PRIVATE_KEY`: a **new dedicated wallet** (never your main one). Generate it in any wallet app and export the key. **Never paste it into chat.**
   - `GITHUB_REPO`: `owner/repo` (optional, see *Attribution tag*)
   - `PUBLIC_URL`: your Replit URL, no trailing slash
   - `X402_API_KEY`: create at <https://x402.celo.org> (connect the wallet, sign a free message)
3. **Install and check the tag**
   ```bash
   npm install
   npm run check-tag -- owner/repo   # optional; MATCH means your tag is repo-derived
   ```
4. **Fund the wallet** on Celo mainnet: about **$3 USDC** is plenty (a little for gas, a little as the buy float). Add the wallet address to your hackathon entry.
5. **Set up buy with the same wallet**
   ```bash
   npm run setup:buy
   npm run probe:buy            # free: shows the price quote
   npm run probe:buy -- --pay   # buys ONE ~$0.005 call; confirm "normalized posts" > 0
   ```
6. **Run it:** press Run (`npm start`). Visit your URL, then `/health`.
7. **Register the ERC-8004 identity** (below).
8. **Publish**: deploy (Replit → Deploy) so the URL stays up through judging.

## ERC-8004 identity: step by step

The identity is an NFT minted to the wallet that sends the registration. **That wallet must be the one in your hackathon entry.**

1. Server is running at `PUBLIC_URL` (it serves `/.well-known/agent.json`).
2. Wallet holds ≥ 0.05 USDC or ≥ 0.01 CELO for gas.
3. Dry run, which sends nothing:
   ```bash
   npm run register
   ```
   It checks the key, the repo/tag match, that your registration file is reachable, balances, and simulates the call.
4. Broadcast:
   ```bash
   npm run register -- --send
   ```
   The registration transaction is sent through the tagged wallet client, so it carries `celo_16de1003cce6`. The script prints your **Agent ID** and confirms the tag on-chain.
5. Add `AGENT_ID=<the id>` to Secrets and restart. The registration file now includes the `registrations` block automatically, with no on-chain update needed.
6. Check it appears on <https://8004scan.io/>, and add the agent wallet to your entry on loops.house.

## Attribution tag

The tag `celo_16de1003cce6` is attached **where the wallet client is built** (`src/tag.ts`), so no transaction path can forget it. `npm test` signs real transactions locally and checks the raw bytes end with the suffix. Verify any mainnet tx with `npm run verify-tx -- 0x…`.

**Two things to know:**

- **Confirm how your tag was issued BEFORE sending anything.** Celo's guide says hackathon codes are *often* derived from the GitHub `owner/repo`, and a mismatched code tags transactions that credit nobody, silently. Tags can't be added after the fact. Create the repo, then run `npm run check-tag -- owner/repo`. A MATCH means the tag is repo-derived and you're set. No match means either a wrong slug or a tag issued independently, which is valid as-is. Settle it by reading the tag on your Loops entry page (before and after adding the repo to the entry) or asking in the hackathon Telegram. Set `REQUIRE_REPO_MATCH=1` only once check-tag says MATCH.
- **x402 settlements are not tagged yet.** Celo's facilitator does not write attribution tags today (their fix is under review upstream). So customer payments settled through x402, and the payments buy makes on our behalf, are submitted by someone else and carry no tag. We already declare our code in every 402 (`builder-code` extension) so it is credited automatically once the facilitator ships. Transactions the agent sends itself, such as the ERC-8004 registration, are tagged. The organisers have confirmed that x402 needs only a `payTo` wallet and that tags aren't supported there yet, and that for buy the judging focus is the quality of the agent built on the services.

## Safety rails

- **Spend caps use the worst case:** each purchase is allowed up to 1.5× the catalogue price (passed to buy as `--max-amount`), and the caps count that worst case until buy's real quote is read. If the quote can't be read, the worst case is kept and the ledger flags the amount as an estimate.
- **One shared budget:** before any payment is signed, the worst-case amount is *reserved* from today's budget in a single synchronous step, so simultaneous requests can't both slip under `DAILY_SPEND_CAP_USD`. The hold is released when the purchase ends, even on failure.
- **No blind retries:** a 500 can mean the payment already settled, so uncertain failures are logged, counted against the caps and never retried.
- **Customers aren't charged for failures:** if no data can be bought, or none of it mentions the project, the route returns 4xx/5xx and the x402 middleware does not settle the payment. A report is only sold when at least one returned post actually mentions the project; with fewer than 3 it is stamped `confidence: "low"`.
- **Evidence can't overstate itself:** the ledger keeps three things apart: *supplier purchases* (what we paid), *reports generated* (not a sale) and *customer payments confirmed* (recorded only after the facilitator confirms settlement, with the tx hash and payer). A cached report returns no purchase evidence, because that request bought nothing.
- **No shell:** `buy` is run with an argument array, never through a shell.
- **Keys:** read from environment only, never logged. The buy keystore lives outside the project (`BUY_HOME`).
- Fund the wallet like a float, not a treasury. buy is pre-1.0 beta software without an external security review.

## USA₮ (second payment option)

USDC is always offered. USA₮ is offered only when its EIP-712 domain is configured, since a wrong value makes every signature fail:

```bash
npm run probe:usat    # reads the domain from the token contract
# then set USAT_EIP712_NAME and USAT_EIP712_VERSION
```

## What is and isn't verified

Verified by tests (`npm test`, 44 passing) and a local run:
tag encoding and on-wire placement, repo/tag mismatch guard, worst-case spend caps, concurrent requests sharing one budget, never-retry behaviour (against a fake `buy`), request validation, report analysis (no unrelated posts counted as evidence, no score sold on nothing), cache evidence, and the **real x402 middleware** both returning a 402 (USDC, right amount, payee, builder code) and completing a **full signed payment** against a fake facilitator, ending in a recorded "settled" entry with tx hash and payer.

**Not verified from the build environment** (no network route to the gateway or Celo, and no funds):
- A live paid call to the buy gateway. The social-data response shapes aren't publicly documented, so the parser is defensive; run `npm run probe:buy -- --pay` once and tune aliases in `src/sources.ts` if "normalized posts" is 0.
- A live x402 settlement through `api.x402.celo.org`.
- The registration transaction itself (the dry run exercises everything up to broadcast).

## Honest limits

Sentiment is a keyword lexicon and the score is a transparent heuristic (see `methodology` in each report). "Africa share" is the share of matching posts that *mention* African countries, cities or local-currency terms. It does not measure where the audience lives. It is a directional signal for outreach and planning, not a verdict. The rules require independent users: wallets you did not fund that were already active on Celo. Bring real customers, such as the projects you already work with.

## Scripts

`npm start` · `npm test` · `npm run typecheck` · `npm run check-tag` · `npm run setup:buy` · `npm run probe:buy` · `npm run probe:usat` · `npm run register` · `npm run verify-tx`

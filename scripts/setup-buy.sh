#!/usr/bin/env bash
# Adopts AGENT_PRIVATE_KEY as buy's wallet so ONE wallet is used everywhere
# (ERC-8004 owner, x402 payee, buy payer). Headless-safe: uses buy's file keystore, not an OS keychain.
#
#   npm run setup:buy
#
# Keep the keystore OUTSIDE the project folder so it can never be committed or exported with the code.
set -euo pipefail

: "${AGENT_PRIVATE_KEY:?Set AGENT_PRIVATE_KEY in Replit Secrets first}"
export BUY_KEYSTORE_BACKEND="${BUY_KEYSTORE_BACKEND:-file}"
export BUY_HOME="${BUY_HOME:-$HOME/.buy-home}"
NAME="${BUY_ACCOUNT:-agent}"
BUY="./node_modules/.bin/buy"

mkdir -p "$BUY_HOME"
chmod 700 "$BUY_HOME"

if "$BUY" --account "$NAME" whoami >/dev/null 2>&1; then
  echo "buy account '$NAME' already exists:"
else
  BUY_IMPORT_KEY="$AGENT_PRIVATE_KEY" "$BUY" setup --import --name "$NAME" >/dev/null
  echo "buy account '$NAME' created from AGENT_PRIVATE_KEY (key not printed)."
fi
"$BUY" --account "$NAME" whoami
echo
echo "Fund the address above with a small float of USDC on Celo mainnet (\$1-\$3 is plenty). buy needs no CELO: the gateway sponsors gas."

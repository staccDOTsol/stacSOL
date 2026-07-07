#!/usr/bin/env bash
# Watch Sam3d's staged deployer wallet (funded 2.5 SOL from a CEX on 2026-07-06,
# exactly deploy money) for the canonical uponly deploy. When a new tx touches
# the BPF upgradeable loader, print the program id and the next command to run.
set -euo pipefail
WALLET=${1:-mCsdFy93ud2UQyW59asvXWhEsBY5WDFoMFQYBSsam3d}
KNOWN_FUNDING_TX="LsEYKJNsVC1VLuQkNE8b4u6GoXXmgerLGGpDksej3Ay8AT7LxhrjAH15bhgAFTzAtZ3H1jaTrGMfg49y2KJTXUJ"
RPC=${RPC:-https://api.mainnet-beta.solana.com}

# sharpest signal first: the address IS the reserved program id (vanity
# "am3d") — the moment it turns executable, uponly is live at this address.
if solana program show "$WALLET" -u "$RPC" >/dev/null 2>&1; then
  echo "🚨 $WALLET IS NOW AN EXECUTABLE PROGRAM — uponly is LIVE"
  solana program show "$WALLET" -u "$RPC"
  echo "→ run: ./verify-uponly.sh $WALLET"
  exit 0
fi

SIGS=$(solana transaction-history "$WALLET" -u "$RPC" --limit 25 | grep -v "transactions found" || true)
NEW=$(echo "$SIGS" | grep -v "^$KNOWN_FUNDING_TX$" | grep -v '^$' || true)
if [ -z "$NEW" ]; then
  echo "no new activity — still staged ($(echo "$SIGS" | grep -c . ) known tx)"
  exit 0
fi
echo "🔔 NEW ACTIVITY on $WALLET:"
for SIG in $NEW; do
  echo "— $SIG"
  DETAIL=$(solana confirm "$SIG" -u "$RPC" -v 2>/dev/null || true)
  if echo "$DETAIL" | grep -q "BPFLoaderUpgradeab1e"; then
    PROG=$(echo "$DETAIL" | grep -B1 "BPFLoaderUpgradeab1e" | grep -oE '[1-9A-HJ-NP-Za-km-z]{32,44}' | head -1)
    echo "  ⛏ PROGRAM DEPLOY detected. Candidate id: $PROG"
    echo "  → run: ./verify-uponly.sh $PROG"
  else
    echo "$DETAIL" | grep -E "Account [0-9]: " | head -6
  fi
done

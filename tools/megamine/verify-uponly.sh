#!/usr/bin/env bash
# Deploy-day gate: verify the canonical uponly deployment matches the source
# we DD'd before megamine burns its program id into Config.
#
#   ./verify-uponly.sh <program-id> [git-ref=main] [rpc=mainnet-beta]
#
# Builds BuildwithAnon/uponly at <git-ref> with the known-good toolchain,
# dumps the on-chain program, and compares byte-for-byte (the on-chain image
# is zero-padded past the ELF; the tail must be all zeros). Also re-checks the
# Curve layout constants megamine deserializes at fixed offsets.
#
# A hash MISMATCH means either (a) he deployed different code — do NOT compose,
# re-audit — or (b) toolchain skew; try `solana-verify` for a reproducible
# build before concluding (a).
set -euo pipefail

PROGRAM_ID=${1:?usage: verify-uponly.sh <program-id> [git-ref] [rpc-url]}
REF=${2:-main}
RPC=${3:-https://api.mainnet-beta.solana.com}
BUILD_SBF=~/.local/share/solana/install/releases/2.3.0/solana-release/bin/cargo-build-sbf

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
echo "→ building uponly @ $REF"
git clone --quiet https://github.com/BuildwithAnon/uponly "$WORK/uponly"
git -C "$WORK/uponly" checkout --quiet "$REF"
(cd "$WORK/uponly/program" && "$BUILD_SBF" --tools-version v1.53 >/dev/null 2>&1)
LOCAL="$WORK/uponly/program/target/deploy/uponly.so"

echo "→ dumping on-chain program $PROGRAM_ID"
solana program dump "$PROGRAM_ID" "$WORK/onchain.so" -u "$RPC" >/dev/null

LSIZE=$(wc -c < "$LOCAL" | tr -d ' ')
head -c "$LSIZE" "$WORK/onchain.so" > "$WORK/onchain.trunc"
L=$(shasum -a 256 "$LOCAL" | cut -d' ' -f1)
O=$(shasum -a 256 "$WORK/onchain.trunc" | cut -d' ' -f1)
TAILNZ=$(tail -c +"$((LSIZE + 1))" "$WORK/onchain.so" | tr -d '\0' | wc -c | tr -d ' ')
echo "  local  : $L ($LSIZE bytes)"
echo "  onchain: $O (nonzero tail bytes: $TAILNZ)"

# megamine parses Curve at fixed offsets — the layout must be untouched
echo "→ curve layout guard"
grep -q "CURVE_SIZE: usize = 32 + 32 + 16 + 8 + 2 + 2 + 2 + 2 + 2 + 16 + 1" \
  "$WORK/uponly/program/src/lib.rs" \
  && echo "  ✓ CURVE_SIZE layout formula unchanged (115 bytes)" \
  || { echo "  ✗ Curve layout CHANGED — re-audit megamine's parse offsets (88/92/96/114)"; exit 1; }

# upgrade authority: if it exists, "no admin keys" is FALSE at the deployment
# level — the bytecode can be swapped under the same id and every vault drained.
echo "→ upgrade authority"
AUTH=$(solana program show "$PROGRAM_ID" -u "$RPC" | awk '/Authority/ {print $2}')
if [ "$AUTH" = "none" ] || [ -z "$AUTH" ]; then
  echo "  ✓ upgrade authority burned"
else
  echo "  ✗ upgrade authority LIVE: $AUTH — deployer can swap the program. Do NOT compose"
  exit 1
fi

if [ "$L" = "$O" ] && [ "$TAILNZ" = "0" ]; then
  echo "✅ VERIFIED — safe to Initialize megamine with uponly_program=$PROGRAM_ID"
else
  echo "❌ MISMATCH — do NOT compose against this deployment (see header comment)"
  exit 1
fi

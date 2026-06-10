import confetti from 'canvas-confetti'

/** Multicolor blast for mints. */
export function fireMint() {
  const palette = ['#ff3300', '#ffaa66', '#ffcc00', '#ff6633', '#ffffff']
  const end = Date.now() + 1500
  ;(function frame() {
    confetti({
      particleCount: 6,
      angle: 60,
      spread: 75,
      origin: { x: 0, y: 0.7 },
      colors: palette,
      disableForReducedMotion: true,
    })
    confetti({
      particleCount: 6,
      angle: 120,
      spread: 75,
      origin: { x: 1, y: 0.7 },
      colors: palette,
      disableForReducedMotion: true,
    })
    if (Date.now() < end) requestAnimationFrame(frame)
  })()
}

/** Hot-only flame burst for burns. */
export function fireBurn() {
  const palette = ['#ff3300', '#ff6633', '#ffaa66', '#ffcc00']
  // single big upward burst from the bottom-center
  confetti({
    particleCount: 120,
    spread: 100,
    startVelocity: 55,
    decay: 0.92,
    gravity: 1.1,
    ticks: 250,
    origin: { x: 0.5, y: 0.95 },
    colors: palette,
    shapes: ['circle'],
    scalar: 1.1,
    disableForReducedMotion: true,
  })
  // a few stragglers that drift up like embers
  setTimeout(() => {
    confetti({
      particleCount: 30,
      spread: 60,
      startVelocity: 40,
      decay: 0.95,
      gravity: 0.6,
      ticks: 350,
      origin: { x: 0.5, y: 0.85 },
      colors: ['#ff3300', '#ff6633'],
      shapes: ['circle'],
      scalar: 0.6,
      disableForReducedMotion: true,
    })
  }, 200)
}

/** Brief shake for errors. */
export function shake(el: HTMLElement | null) {
  if (!el) return
  el.animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-6px)' },
      { transform: 'translateX(6px)' },
      { transform: 'translateX(-4px)' },
      { transform: 'translateX(4px)' },
      { transform: 'translateX(0)' },
    ],
    { duration: 350, easing: 'ease-in-out' },
  )
}

// SPL stake-pool v1.0.0 program error codes — same numbering as Sanctum's
// fork. Mapping to human-readable strings so we don't surface raw "0x11" in
// the UI. Codes covering the deposit / withdraw paths only; rare admin
// errors (validator management, fee config) fall through to the generic
// fallback.
const STAKE_POOL_ERRORS: Record<number, string> = {
  0x02: 'pool state invalid',
  0x03: 'pool math overflow',
  0x04: 'fee too high',
  0x05: 'wrong mint',
  0x07: 'wallet signature missing',
  0x09: 'wrong manager-fee account',
  0x0a: 'wrong pool mint',
  0x0b: 'stake account in wrong state',
  0x10: "validator list out of date — pool needs UpdateValidatorListBalance",
  0x11: "pool needs an epoch crank — try again in a moment (manager normally cranks within 5 min)",
  0x12: 'unknown validator stake account',
}

/** Try to extract a useful one-liner from a Solana RPC error blob. */
export function summarizeError(e: unknown): string {
  if (!e) return 'unknown error'
  const msg = e instanceof Error ? e.message : String(e)
  // Common patterns from web3.js / RPC
  const customErr = msg.match(/custom program error: (0x[0-9a-fA-F]+)/)
  if (customErr) {
    const code = parseInt(customErr[1], 16)
    const named = STAKE_POOL_ERRORS[code]
    if (named) return named
    return `program error ${customErr[1]}`
  }
  const insErr = msg.match(/Error processing Instruction (\d+):\s*([^.]+)/)
  if (insErr) return `instruction ${insErr[1]}: ${insErr[2].trim()}`
  const blockhashErr = /BlockhashNotFound|TransactionExpired/.exec(msg)
  if (blockhashErr) return 'tx expired — try again'
  const rejected = /User rejected|reject/i.exec(msg)
  if (rejected) return 'cancelled'
  const insufficient = /insufficient/i.exec(msg)
  if (insufficient) return 'insufficient funds'
  // Fallback: first sentence, capped
  const first = msg.split(/[\n.]/)[0].trim()
  return first.length > 120 ? first.slice(0, 117) + '…' : first
}

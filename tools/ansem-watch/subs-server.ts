// Billing sidecar: flat passes + pay-as-you-go metering. Isolated from the
// ingest relay; the relay proxies /api/sub/*, /paywall.js and /plan.json here.
// Run: bun run tools/ansem-watch/subs-server.ts

import { subsInfo, passStatus, buildPayTx, confirmPay, meter } from "./subs";
import {
  initStreaming, streamInfo, streamStatus, streamSeen,
  buildStreamTx, confirmStream, pullActiveStreams,
} from "./subs-stream";
import { initBurn, burnStatus, buyAndBurn } from "./burn";

const PORT = Number(process.env.SUBS_PORT || 4478);

// combined status: any active model unlocks the terminal
function combinedStatus(wallet: string) {
  const pass = passStatus(wallet);
  if (pass.subscribed) return pass;
  const stream = streamStatus(wallet);
  if (stream.subscribed) return stream;
  return { ...pass, stream: streamInfo().enabled };
}
const CORS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/paywall.js") {
      return new Response(Bun.file(new URL("./paywall.js", import.meta.url).pathname), {
        headers: { "content-type": "application/javascript", "cache-control": "no-cache", "access-control-allow-origin": "*" },
      });
    }
    if (p === "/plan.json") {
      return Response.json(
        { name: "aggr.sh", description: "Pay-as-you-go (0.05 SOL/hr, metered while open) or Day 1 / Month 18 flat passes." },
        { headers: CORS },
      );
    }
    if (p === "/api/sub/info") {
      return Response.json({ ...subsInfo(), stream: streamInfo(), burn: burnStatus() }, { headers: CORS });
    }
    if (p === "/api/burn/status") {
      return Response.json(burnStatus(), { headers: CORS });
    }
    if (p === "/api/sub/status") {
      const w = url.searchParams.get("wallet") ?? "";
      if (!w) return Response.json({ enabled: true, subscribed: false }, { headers: CORS });
      try {
        return Response.json(combinedStatus(w), { headers: CORS });
      } catch (e) {
        return Response.json({ enabled: true, subscribed: false, error: String(e) }, { headers: CORS });
      }
    }
    if (p === "/api/sub/stream/tx" && req.method === "POST") {
      try {
        const b = await req.json();
        return Response.json(await buildStreamTx(String(b.wallet), Number(b.hours) || 6), { headers: CORS });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 422, headers: CORS });
      }
    }
    if (p === "/api/sub/stream/confirm" && req.method === "POST") {
      try {
        const b = await req.json();
        return Response.json(await confirmStream(String(b.wallet), Number(b.nonce), Number(b.hours) || 6, String(b.signature || "")), { headers: CORS });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 422, headers: CORS });
      }
    }
    if (p === "/api/sub/tx" && req.method === "POST") {
      try {
        const b = await req.json();
        return Response.json(await buildPayTx(String(b.wallet), String(b.kind || b.tier || "day"), b.lamports), { headers: CORS });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 422, headers: CORS });
      }
    }
    if (p === "/api/sub/confirm" && req.method === "POST") {
      try {
        const b = await req.json();
        return Response.json(await confirmPay(String(b.wallet), String(b.kind || b.tier || "day"), String(b.signature || "")), { headers: CORS });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 422, headers: CORS });
      }
    }
    if (p === "/api/sub/meter" && req.method === "POST") {
      try {
        const b = await req.json();
        const w = String(b.wallet);
        streamSeen(w); // keep streamers marked active for the pull loop
        const st = meter(w);
        if (st.subscribed) return Response.json(st, { headers: CORS });
        return Response.json(streamStatus(w), { headers: CORS });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 422, headers: CORS });
      }
    }
    return new Response("not found", { status: 404 });
  },
});

initStreaming().catch((e) => console.log("[stream] init failed:", String(e).slice(0, 120)));
setInterval(() => pullActiveStreams().catch((e) => console.log("[stream] pull loop error:", e)), 60 * 1000);

initBurn().catch((e) => console.log("[burn] init failed:", String(e).slice(0, 120)));
setInterval(() => buyAndBurn().catch((e) => console.log("[burn] loop error:", e)), 10 * 60 * 1000);

console.log(`subs sidecar up on http://localhost:${PORT} (stream + passes + prepay + buy&burn)`);

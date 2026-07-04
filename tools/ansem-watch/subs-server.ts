// Billing sidecar: native Solana subscriptions, isolated from the ingest relay.
// The main relay proxies /api/sub/*, /paywall.js and /plan.json here (port 4478).
// Run: bun run tools/ansem-watch/subs-server.ts

import {
  initSubscriptions,
  subsInfo,
  subStatus,
  buildSubscribeTx,
  buildTopupTx,
  noteSubscribed,
  collectDue,
} from "./subs";

const PORT = Number(process.env.SUBS_PORT || 4478);

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
        { name: "Carnage Terminal - hourly access", description: "0.05 SOL per hour, cancel any time on-chain." },
        { headers: CORS },
      );
    }
    if (p === "/api/sub/info") {
      return Response.json(subsInfo(), { headers: CORS });
    }
    if (p === "/api/sub/status") {
      const w = url.searchParams.get("wallet") ?? "";
      try {
        return Response.json(await subStatus(w), { headers: CORS });
      } catch (e) {
        return Response.json({ enabled: false, subscribed: false, error: String(e) }, { headers: CORS });
      }
    }
    if (p === "/api/sub/tx" && req.method === "POST") {
      try {
        const body = await req.json();
        return Response.json(await buildSubscribeTx(String(body.wallet), Number(body.hours) || 1), { headers: CORS });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 422, headers: CORS });
      }
    }
    if (p === "/api/sub/topup" && req.method === "POST") {
      try {
        const body = await req.json();
        return Response.json(await buildTopupTx(String(body.wallet), Number(body.hours) || 1), { headers: CORS });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 422, headers: CORS });
      }
    }
    if (p === "/api/sub/confirm" && req.method === "POST") {
      try {
        const body = await req.json();
        const st: any = await subStatus(String(body.wallet));
        if (st.subPda) noteSubscribed(String(body.wallet), st.subPda);
        return Response.json(st, { headers: CORS });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 422, headers: CORS });
      }
    }
    return new Response("not found", { status: 404 });
  },
});

function bootSubs() {
  initSubscriptions().catch((e) => {
    console.log("[subs] init failed (retrying in 10m):", String(e).slice(0, 160));
    setTimeout(bootSubs, 10 * 60 * 1000);
  });
}
bootSubs();
setInterval(() => collectDue().catch((e) => console.log("[subs] collect error:", e)), 5 * 60 * 1000);

console.log(`subs sidecar up on http://localhost:${PORT}`);

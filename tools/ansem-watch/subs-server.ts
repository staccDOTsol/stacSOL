// Billing sidecar: prepaid access passes (upfront SOL transfer), isolated from
// the ingest relay. The relay proxies /api/sub/*, /paywall.js and /plan.json here.
// Run: bun run tools/ansem-watch/subs-server.ts

import { subsInfo, passStatus, buildPassTx, confirmPass } from "./subs";

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
        { name: "Carnage Terminal", description: "Day pass 1 SOL / Month pass 18 SOL, paid upfront on-chain." },
        { headers: CORS },
      );
    }
    if (p === "/api/sub/info") {
      return Response.json(subsInfo(), { headers: CORS });
    }
    if (p === "/api/sub/status") {
      const w = url.searchParams.get("wallet") ?? "";
      if (!w) return Response.json({ enabled: true, subscribed: false }, { headers: CORS });
      try {
        return Response.json(passStatus(w), { headers: CORS });
      } catch (e) {
        return Response.json({ enabled: true, subscribed: false, error: String(e) }, { headers: CORS });
      }
    }
    if (p === "/api/sub/tx" && req.method === "POST") {
      try {
        const b = await req.json();
        return Response.json(await buildPassTx(String(b.wallet), String(b.tier || "day")), { headers: CORS });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 422, headers: CORS });
      }
    }
    if (p === "/api/sub/confirm" && req.method === "POST") {
      try {
        const b = await req.json();
        return Response.json(await confirmPass(String(b.wallet), String(b.tier || "day"), String(b.signature || "")), { headers: CORS });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 422, headers: CORS });
      }
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`subs sidecar up on http://localhost:${PORT} (prepaid passes)`);

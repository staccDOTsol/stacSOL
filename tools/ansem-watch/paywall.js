// Carnage paywall: 5 free minutes, then a native Solana subscription
// (0.05 wSOL/hr via solana-foundation/subscriptions) unlocks the terminal.
(function () {
  var RELAY = (function () {
    try {
      var src = document.currentScript && document.currentScript.src;
      if (src) return new URL(src).origin;
    } catch (e) { /* fall through */ }
    return location.origin;
  })();

  var FREE_SECONDS = 300;
  var LSK_TIME = "cw_watch_s";
  var LSK_WALLET = "cw_wallet";

  var watched = +(localStorage.getItem(LSK_TIME) || 0);
  var wallet = localStorage.getItem(LSK_WALLET) || null;
  var subscribed = false;
  var enabled = null; // null = unknown yet
  var overlay = null;

  function j(u, opts) { return fetch(u, opts).then(function (r) { return r.json(); }); }

  function provider() {
    return (window.phantom && window.phantom.solana) || window.solana || null;
  }

  function loadWeb3() {
    return new Promise(function (res, rej) {
      if (window.solanaWeb3) return res(window.solanaWeb3);
      var s = document.createElement("script");
      s.src = "https://unpkg.com/@solana/web3.js@1.98.0/lib/index.iife.min.js";
      s.onload = function () { res(window.solanaWeb3); };
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function checkStatus() {
    if (!wallet) return Promise.resolve(false);
    return j(RELAY + "/api/sub/status?wallet=" + wallet).then(function (st) {
      enabled = !!st.enabled;
      subscribed = !!(st.subscribed && !st.delinquent);
      if (st.subscribed && st.delinquent && overlay) setMsg("subscription found, but your wSOL ran dry — top up to resume");
      return subscribed;
    }).catch(function () { return subscribed; });
  }

  function setMsg(t, isErr) {
    var el = overlay && overlay.querySelector("#cwp-msg");
    if (el) { el.textContent = t; el.style.color = isErr ? "#ff3b4e" : "#8a8a99"; }
  }

  function showOverlay() {
    if (overlay || subscribed || enabled === false) return;
    overlay = document.createElement("div");
    overlay.id = "cwp-overlay";
    overlay.innerHTML =
      '<style>' +
      '#cwp-overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(8,8,12,.82);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;font-family:"SF Mono",ui-monospace,Menlo,monospace;color:#e8e8ee}' +
      '#cwp-card{background:#111116;border:1px solid #26262f;border-radius:12px;padding:32px;max-width:420px;width:92%;text-align:center}' +
      '#cwp-card h1{font-size:18px;margin:0 0 6px;letter-spacing:.05em}' +
      '#cwp-card h1 .skull{color:#ff3b4e}' +
      '#cwp-card .price{font-size:34px;font-weight:700;margin:14px 0 2px;color:#2bd576}' +
      '#cwp-card .per{color:#8a8a99;font-size:12px;margin-bottom:18px}' +
      '#cwp-hours{display:flex;gap:8px;justify-content:center;margin-bottom:18px}' +
      '#cwp-hours button{background:#16161d;border:1px solid #26262f;border-radius:8px;color:#e8e8ee;padding:8px 14px;font:inherit;cursor:pointer}' +
      '#cwp-hours button.sel{border-color:#2bd576;color:#2bd576}' +
      '#cwp-go{background:#2bd576;border:none;border-radius:8px;color:#08080c;font:inherit;font-weight:700;padding:12px 22px;cursor:pointer;width:100%}' +
      '#cwp-go:disabled{opacity:.5;cursor:wait}' +
      '#cwp-msg{font-size:11px;color:#8a8a99;margin-top:12px;min-height:28px}' +
      '#cwp-fine{font-size:10px;color:#55555f;margin-top:10px;line-height:1.5}' +
      '</style>' +
      '<div id="cwp-card">' +
      '<h1><span class="skull">☠</span> CARNAGE COSTS</h1>' +
      '<div style="color:#8a8a99;font-size:12px">5 free minutes are up. Keep watching with a native Solana subscription.</div>' +
      '<div class="price">0.05 SOL</div><div class="per">per hour · billed on-chain · cancel any time</div>' +
      '<div id="cwp-hours">' +
      '<button data-h="1">1h</button><button data-h="6" class="sel">6h</button><button data-h="24">24h</button>' +
      '</div>' +
      '<button id="cwp-go">connect phantom &amp; subscribe</button>' +
      '<div id="cwp-msg"></div>' +
      '<div id="cwp-fine">solana-foundation subscriptions program · De1egAF…vR44<br/>funds wrap to wSOL in your wallet; the plan pulls 0.05/hr while you stay subscribed</div>' +
      '</div>';
    document.documentElement.appendChild(overlay);

    var hours = 6;
    overlay.querySelectorAll("#cwp-hours button").forEach(function (b) {
      b.onclick = function () {
        overlay.querySelectorAll("#cwp-hours button").forEach(function (x) { x.classList.remove("sel"); });
        b.classList.add("sel");
        hours = +b.dataset.h;
      };
    });

    overlay.querySelector("#cwp-go").onclick = function () {
      var btn = this;
      btn.disabled = true;
      var ph = provider();
      if (!ph) { setMsg("phantom not found — install it or open in a wallet browser", true); btn.disabled = false; return; }
      setMsg("connecting wallet…");
      ph.connect().then(function (res) {
        wallet = (res.publicKey || ph.publicKey).toString();
        localStorage.setItem(LSK_WALLET, wallet);
        return checkStatus();
      }).then(function (already) {
        var route = already === true ? null : "/api/sub/tx";
        // delinquent subscribers just need a top-up
        return j(RELAY + "/api/sub/status?wallet=" + wallet).then(function (st) {
          if (st.subscribed && !st.delinquent) { return "done"; }
          var path = st.subscribed && st.delinquent ? "/api/sub/topup" : "/api/sub/tx";
          setMsg("building transaction…");
          return j(RELAY + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ wallet: wallet, hours: hours }),
          });
        });
      }).then(function (out) {
        if (out === "done") return "done";
        if (!out || out.error) throw new Error((out && out.error) || "tx build failed");
        setMsg("waiting for signature… (wraps " + (0.05 * hours).toFixed(2) + " SOL + subscribes)");
        return loadWeb3().then(function (w3) {
          var tx = w3.VersionedTransaction.deserialize(b64ToBytes(out.tx));
          return provider().signAndSendTransaction(tx);
        }).then(function (sig) {
          setMsg("confirming " + String(sig.signature || sig).slice(0, 8) + "…");
          return new Promise(function (res) {
            var tries = 0;
            (function poll() {
              j(RELAY + "/api/sub/confirm", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ wallet: wallet }),
              }).then(function (st) {
                if (st.subscribed && !st.delinquent) return res("done");
                if (++tries > 40) return res("timeout");
                setTimeout(poll, 2000);
              }).catch(function () { setTimeout(poll, 2000); });
            })();
          });
        });
      }).then(function (r) {
        if (r === "done") {
          subscribed = true;
          setMsg("subscribed — welcome to the carnage");
          setTimeout(hideOverlay, 900);
        } else if (r === "timeout") {
          setMsg("still confirming… reload in a moment if this hangs", true);
          btn.disabled = false;
        }
      }).catch(function (e) {
        setMsg(String(e && e.message || e).slice(0, 120), true);
        btn.disabled = false;
      });
    };
  }

  function hideOverlay() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  // watch-time accounting: only count while the tab is visible
  setInterval(function () {
    if (subscribed) return;
    if (document.visibilityState === "visible") {
      watched += 5;
      localStorage.setItem(LSK_TIME, String(watched));
      if (watched >= FREE_SECONDS && enabled !== false) showOverlay();
    }
  }, 5000);

  // initial + periodic status
  j(RELAY + "/api/sub/info").then(function (info) {
    enabled = !!info.enabled;
    if (!enabled) return;
    checkStatus().then(function (ok) {
      if (ok) hideOverlay();
      else if (watched >= FREE_SECONDS) showOverlay();
    });
  }).catch(function () { enabled = false; });

  setInterval(function () {
    checkStatus().then(function (ok) {
      if (ok) hideOverlay();
      else if (watched >= FREE_SECONDS) showOverlay();
    });
  }, 10 * 60 * 1000);
})();

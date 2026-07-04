// Carnage paywall: 5 free minutes, then an upfront access pass.
//   Day pass  = 1 SOL  (24h)
//   Month pass = 18 SOL (30d, upfront)
// Payment is a direct SOL transfer; the relay verifies it on-chain and grants
// the access window keyed to the wallet.
(function () {
  var RELAY = (function () {
    try {
      var src = document.currentScript && document.currentScript.src;
      if (src) return new URL(src).origin;
    } catch (e) {}
    return location.origin;
  })();

  var FREE_SECONDS = 300;
  var LSK_TIME = "cw_watch_s";
  var LSK_WALLET = "cw_wallet";

  var watched = +(localStorage.getItem(LSK_TIME) || 0);
  var wallet = localStorage.getItem(LSK_WALLET) || null;
  var subscribed = false;
  var enabled = null;
  var overlay = null;
  var tier = "month";

  function j(u, opts) { return fetch(u, opts).then(function (r) { return r.json(); }); }
  function provider() { return (window.phantom && window.phantom.solana) || window.solana || null; }

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
      enabled = st.enabled !== false;
      subscribed = !!st.subscribed;
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
      '#cwp-card{background:#111116;border:1px solid #26262f;border-radius:12px;padding:30px;max-width:440px;width:92%;text-align:center}' +
      '#cwp-card h1{font-size:18px;margin:0 0 6px;letter-spacing:.05em}' +
      '#cwp-card h1 .skull{color:#ff3b4e}' +
      '#cwp-tiers{display:flex;gap:10px;margin:18px 0}' +
      '.cwp-tier{flex:1;background:#16161d;border:1px solid #26262f;border-radius:10px;padding:16px 10px;cursor:pointer;transition:border-color .1s}' +
      '.cwp-tier.sel{border-color:#2bd576}' +
      '.cwp-tier .amt{font-size:26px;font-weight:700;color:#2bd576}' +
      '.cwp-tier .unit{font-size:11px;color:#8a8a99;margin-top:2px}' +
      '.cwp-tier .tag{font-size:10px;color:#ffb02e;margin-top:6px;min-height:12px}' +
      '#cwp-go{background:#2bd576;border:none;border-radius:8px;color:#08080c;font:inherit;font-weight:700;padding:12px 22px;cursor:pointer;width:100%}' +
      '#cwp-go:disabled{opacity:.5;cursor:wait}' +
      '#cwp-msg{font-size:11px;color:#8a8a99;margin-top:12px;min-height:28px}' +
      '#cwp-fine{font-size:10px;color:#55555f;margin-top:8px;line-height:1.5}' +
      '</style>' +
      '<div id="cwp-card">' +
      '<h1><span class="skull">☠</span> CARNAGE COSTS</h1>' +
      '<div style="color:#8a8a99;font-size:12px">5 free minutes are up. Pay upfront, watch the whole dump.</div>' +
      '<div id="cwp-tiers">' +
      '<div class="cwp-tier" data-t="day"><div class="amt">1</div><div class="unit">SOL · 1 day</div><div class="tag"></div></div>' +
      '<div class="cwp-tier sel" data-t="month"><div class="amt">18</div><div class="unit">SOL · 30 days</div><div class="tag">save 40%</div></div>' +
      '</div>' +
      '<button id="cwp-go">connect phantom &amp; pay</button>' +
      '<div id="cwp-msg"></div>' +
      '<div id="cwp-fine">one upfront transfer · verified on-chain · access keyed to your wallet<br/>stacks onto any time you already have</div>' +
      '</div>';
    document.documentElement.appendChild(overlay);

    overlay.querySelectorAll(".cwp-tier").forEach(function (el) {
      el.onclick = function () {
        overlay.querySelectorAll(".cwp-tier").forEach(function (x) { x.classList.remove("sel"); });
        el.classList.add("sel");
        tier = el.dataset.t;
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
        if (already) return "done";
        setMsg("building payment…");
        return j(RELAY + "/api/sub/tx", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ wallet: wallet, tier: tier }),
        }).then(function (out) {
          if (!out || out.error) throw new Error((out && out.error) || "tx build failed");
          var sol = tier === "month" ? 18 : 1;
          setMsg("approve " + sol + " SOL in your wallet…");
          return loadWeb3().then(function (w3) {
            var tx = w3.VersionedTransaction.deserialize(b64ToBytes(out.tx));
            return provider().signAndSendTransaction(tx);
          }).then(function (sig) {
            var signature = sig.signature || sig;
            setMsg("confirming payment " + String(signature).slice(0, 8) + "…");
            return new Promise(function (resolve) {
              var tries = 0;
              (function poll() {
                j(RELAY + "/api/sub/confirm", {
                  method: "POST", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ wallet: wallet, tier: tier, signature: String(signature) }),
                }).then(function (st) {
                  if (st.subscribed) return resolve("done");
                  if (st.error && !/not found|not confirmed/.test(st.error)) { setMsg(st.error, true); }
                  if (++tries > 45) return resolve("timeout");
                  setTimeout(poll, 2000);
                }).catch(function () { setTimeout(poll, 2000); });
              })();
            });
          });
        });
      }).then(function (r) {
        if (r === "done") {
          subscribed = true;
          setMsg("access granted — welcome to the carnage");
          setTimeout(hideOverlay, 1000);
        } else if (r === "timeout") {
          setMsg("still confirming… reload in a moment if this hangs", true);
          btn.disabled = false;
        }
      }).catch(function (e) {
        setMsg(String((e && e.message) || e).slice(0, 130), true);
        btn.disabled = false;
      });
    };
  }

  function hideOverlay() { if (overlay) { overlay.remove(); overlay = null; } }

  setInterval(function () {
    if (subscribed) return;
    if (document.visibilityState === "visible") {
      watched += 5;
      localStorage.setItem(LSK_TIME, String(watched));
      if (watched >= FREE_SECONDS && enabled !== false) showOverlay();
    }
  }, 5000);

  j(RELAY + "/api/sub/info").then(function (info) {
    enabled = info.enabled !== false;
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
  }, 5 * 60 * 1000);
})();

// Carnage paywall: 5 free minutes, then either
//   Pay-as-you-go — deposit SOL, burns 0.05/hr ONLY while this tab is open
//   Day pass 1 SOL / Month pass 18 SOL — flat, unlimited while active
// The relay meters real watch-time (visibility-gated heartbeats) against the
// prepaid credit; close the tab and the meter stops.
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
  var mode = null;
  var secondsLeft = 0;
  var enabled = null;
  var info = null;
  var overlay = null;
  var badge = null;
  var choice = { kind: "payg", lamports: 250000000 }; // default 0.25 SOL PAYG

  function j(u, opts) { return fetch(u, opts).then(function (r) { return r.json(); }); }

  var wa = null; // chosen wallet adapter

  function bs58(bytes) {
    var A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    var d = [0], i, k, c;
    for (i = 0; i < bytes.length; i++) {
      c = bytes[i];
      for (k = 0; k < d.length; k++) { c += d[k] << 8; d[k] = c % 58; c = (c / 58) | 0; }
      while (c) { d.push(c % 58); c = (c / 58) | 0; }
    }
    var s = "";
    for (i = 0; i < bytes.length && bytes[i] === 0; i++) s += "1";
    for (i = d.length - 1; i >= 0; i--) s += A[d[i]];
    return s;
  }
  function sigStr(sig) {
    if (typeof sig === "string") return sig;
    if (sig && sig.signature) return sigStr(sig.signature);
    if (sig instanceof Uint8Array) return bs58(sig);
    if (sig && sig.length != null) return bs58(new Uint8Array(sig));
    return String(sig);
  }

  // --- Wallet Standard discovery (Phantom / Solflare / Backpack / Jupiter / …)
  var standardWallets = [];
  (function discover() {
    function register() {
      for (var i = 0; i < arguments.length; i++) {
        var w = arguments[i];
        if (w && w.features && w.features["standard:connect"] &&
            (w.features["solana:signAndSendTransaction"] || w.features["solana:signTransaction"]) &&
            (!w.chains || w.chains.some(function (c) { return String(c).indexOf("solana") === 0; }))) {
          if (standardWallets.indexOf(w) === -1) standardWallets.push(w);
        }
      }
      return function () {};
    }
    try {
      window.addEventListener("wallet-standard:register-wallet", function (e) { e.detail({ register: register }); });
      window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register: register } }));
    } catch (e) {}
  })();

  // uniform adapter over both Wallet-Standard and injected (window.solana) wallets
  function standardAdapter(w) {
    var account = null;
    return {
      name: w.name, icon: w.icon,
      connect: function () {
        return w.features["standard:connect"].connect().then(function (res) {
          account = (res.accounts && res.accounts[0]) || w.accounts[0];
          return account.address;
        });
      },
      signAndSend: function (tx) {
        var f = w.features["solana:signAndSendTransaction"];
        if (f) {
          return f.signAndSendTransaction({ account: account, transaction: tx.serialize(), chain: "solana:mainnet" })
            .then(function (out) { return sigStr(out[0].signature); });
        }
        // sign-only wallet: sign then send via provider fallback isn't available → reject
        return Promise.reject(new Error(w.name + " can't send transactions"));
      }
    };
  }
  function injectedAdapter(name, icon, p) {
    return {
      name: name, icon: icon,
      connect: function () { return p.connect().then(function (r) { return ((r && r.publicKey) || p.publicKey).toString(); }); },
      signAndSend: function (tx) { return p.signAndSendTransaction(tx).then(function (s) { return sigStr(s); }); }
    };
  }
  function discoverAdapters() {
    var list = standardWallets.map(standardAdapter);
    var names = list.map(function (a) { return (a.name || "").toLowerCase(); });
    // injected fallbacks for wallets that predate the standard
    if (window.phantom && window.phantom.solana && names.indexOf("phantom") === -1)
      list.push(injectedAdapter("Phantom", "", window.phantom.solana));
    if (window.solflare && names.indexOf("solflare") === -1)
      list.push(injectedAdapter("Solflare", "", window.solflare));
    if (!list.length && window.solana)
      list.push(injectedAdapter(window.solana.isPhantom ? "Phantom" : "Wallet", "", window.solana));
    return list;
  }

  // wallet picker modal → resolves to a chosen adapter
  function pickWallet() {
    var adapters = discoverAdapters();
    if (adapters.length === 1) return Promise.resolve(adapters[0]);
    if (!adapters.length) return Promise.reject(new Error("no Solana wallet found — install Phantom, Solflare, Jupiter…"));
    return new Promise(function (resolve, reject) {
      var m = document.createElement("div");
      m.id = "cwp-wallets";
      m.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(8,8,12,.85);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;font-family:'SF Mono',ui-monospace,Menlo,monospace;color:#e8e8ee";
      m.innerHTML = '<div style="background:#111116;border:1px solid #26262f;border-radius:12px;padding:22px;max-width:340px;width:90%">' +
        '<div style="font-size:14px;font-weight:700;letter-spacing:.05em;margin-bottom:14px;text-align:center">connect a wallet</div>' +
        '<div id="cwp-wl"></div>' +
        '<div style="text-align:center;margin-top:12px"><a href="javascript:void(0)" id="cwp-wlx" style="color:#8a8a99;font-size:11px">cancel</a></div></div>';
      document.documentElement.appendChild(m);
      var wl = m.querySelector("#cwp-wl");
      adapters.forEach(function (a) {
        var row = document.createElement("button");
        row.style.cssText = "display:flex;align-items:center;gap:10px;width:100%;background:#16161d;border:1px solid #26262f;border-radius:9px;padding:11px 13px;margin-bottom:8px;color:#e8e8ee;font:inherit;cursor:pointer";
        row.innerHTML = (a.icon ? '<img src="' + a.icon + '" width="22" height="22" style="border-radius:5px"/>' : '<span style="width:22px">👛</span>') +
          '<span style="font-weight:600">' + a.name + '</span>';
        row.onmouseover = function () { row.style.borderColor = "#2bd576"; };
        row.onmouseout = function () { row.style.borderColor = "#26262f"; };
        row.onclick = function () { m.remove(); resolve(a); };
        wl.appendChild(row);
      });
      m.querySelector("#cwp-wlx").onclick = function () { m.remove(); reject(new Error("cancelled")); };
    });
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
  function fmtLeft(s) {
    if (s <= 0) return "0m";
    if (s < 3600) return Math.ceil(s / 60) + "m";
    if (s < 86400) return (s / 3600).toFixed(1) + "h";
    return Math.floor(s / 86400) + "d";
  }

  function applyStatus(st) {
    enabled = st.enabled !== false;
    subscribed = !!st.subscribed;
    mode = st.mode || null;
    secondsLeft = st.secondsLeft || 0;
    renderBadge();
    return subscribed;
  }
  function checkStatus() {
    if (!wallet) return Promise.resolve(false);
    return j(RELAY + "/api/sub/status?wallet=" + wallet).then(applyStatus).catch(function () { return subscribed; });
  }

  function setMsg(t, isErr) {
    var el = overlay && overlay.querySelector("#cwp-msg");
    if (el) { el.textContent = t; el.style.color = isErr ? "#ff3b4e" : "#8a8a99"; }
  }

  // small floating balance/time-left chip while active
  function renderBadge() {
    if (!subscribed || mode == null) { if (badge) { badge.remove(); badge = null; } return; }
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "cwp-badge";
      badge.style.cssText = "position:fixed;bottom:10px;left:10px;z-index:2147483000;background:#111116;border:1px solid #26262f;border-radius:8px;padding:5px 9px;font:11px/1 \"SF Mono\",ui-monospace,Menlo,monospace;color:#8a8a99;cursor:pointer";
      badge.title = "add time";
      badge.onclick = function () { watched = FREE_SECONDS; showOverlay(); };
      document.documentElement.appendChild(badge);
    }
    badge.innerHTML = mode === "credit"
      ? '<span style="color:#2bd576">⛽</span> ' + fmtLeft(secondsLeft) + ' left'
      : mode === "stream"
        ? '<span style="color:#2bd576">🌊</span> streaming · ' + fmtLeft(secondsLeft)
        : '<span style="color:#2bd576">✓</span> pass · ' + fmtLeft(secondsLeft);
  }

  function tierCard(id, big, unit, tag, sel) {
    return '<div class="cwp-opt' + (sel ? " sel" : "") + '" data-kind="' + id + '">' +
      '<div class="amt">' + big + '</div><div class="unit">' + unit + '</div>' +
      '<div class="tag">' + (tag || "") + '</div></div>';
  }

  function showOverlay() {
    if (overlay || (subscribed && watched < FREE_SECONDS) || enabled === false) return;
    if (subscribed && mode) return; // still funded — no wall
    var rate = (info && info.payg && info.payg.rateSolPerHour) || 0.05;
    var presets = (info && info.payg && info.payg.presetsSol) || [0.1, 0.25, 1];

    overlay = document.createElement("div");
    overlay.id = "cwp-overlay";
    overlay.innerHTML =
      '<style>' +
      '#cwp-overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(8,8,12,.82);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;font-family:"SF Mono",ui-monospace,Menlo,monospace;color:#e8e8ee}' +
      '#cwp-card{background:#111116;border:1px solid #26262f;border-radius:12px;padding:28px;max-width:470px;width:94%;text-align:center}' +
      '#cwp-card h1{font-size:18px;margin:0 0 6px;letter-spacing:.05em}#cwp-card h1 .skull{color:#ff3b4e}' +
      '.cwp-seg{display:flex;gap:6px;margin:16px 0 8px;background:#0c0c10;border:1px solid #26262f;border-radius:9px;padding:4px}' +
      '.cwp-seg button{flex:1;background:transparent;border:none;color:#8a8a99;font:inherit;padding:7px;border-radius:6px;cursor:pointer}' +
      '.cwp-seg button.on{background:#16161d;color:#e8e8ee}' +
      '#cwp-opts{display:flex;gap:8px;margin:8px 0 4px}' +
      '.cwp-opt{flex:1;background:#16161d;border:1px solid #26262f;border-radius:10px;padding:14px 6px;cursor:pointer;transition:border-color .1s}' +
      '.cwp-opt.sel{border-color:#2bd576}' +
      '.cwp-opt .amt{font-size:22px;font-weight:700;color:#2bd576}' +
      '.cwp-opt .unit{font-size:10px;color:#8a8a99;margin-top:2px}' +
      '.cwp-opt .tag{font-size:9px;color:#ffb02e;margin-top:5px;min-height:11px}' +
      '#cwp-sub{font-size:11px;color:#8a8a99;min-height:16px;margin:6px 0 2px}' +
      '#cwp-go{background:#2bd576;border:none;border-radius:8px;color:#08080c;font:inherit;font-weight:700;padding:12px 22px;cursor:pointer;width:100%;margin-top:12px}' +
      '#cwp-go:disabled{opacity:.5;cursor:wait}' +
      '#cwp-msg{font-size:11px;color:#8a8a99;margin-top:10px;min-height:26px}' +
      '#cwp-fine{font-size:10px;color:#55555f;margin-top:8px;line-height:1.5}' +
      '</style>' +
      '<div id="cwp-card">' +
      '<h1><span class="skull">☠</span> aggr.sh</h1>' +
      '<div style="color:#8a8a99;font-size:12px">5 free minutes are up. Only pay for the time you watch.</div>' +
      '<div style="color:#ffb02e;font-size:10px;margin-top:4px">🔥 all fees buy &amp; burn $BUCKINGHAM</div>' +
      '<div class="cwp-seg" id="cwp-seg">' +
      (info && info.stream && info.stream.enabled ? '<button data-m="stream" class="on">🌊 stream</button>' : '') +
      '<button data-m="payg"' + (info && info.stream && info.stream.enabled ? '' : ' class="on"') + '>⛽ prepay</button>' +
      '<button data-m="flat">flat pass</button>' +
      '</div>' +
      '<div id="cwp-opts"></div>' +
      '<div id="cwp-sub"></div>' +
      '<button id="cwp-go">connect wallet &amp; pay</button>' +
      '<div id="cwp-msg"></div>' +
      '<div id="cwp-fine">one upfront transfer · verified on-chain<br/>pay-as-you-go burns only while this tab is open, at ' + rate + ' SOL/hr</div>' +
      '</div>';
    document.documentElement.appendChild(overlay);

    var streamOn = info && info.stream && info.stream.enabled;
    var seg = streamOn ? "stream" : "payg";
    function renderOpts() {
      var box = overlay.querySelector("#cwp-opts");
      var sub = overlay.querySelector("#cwp-sub");
      if (seg === "stream") {
        box.innerHTML = [6, 24, 72].map(function (hrs, i) {
          return tierCard("stream:" + hrs, hrs + "h", "window", "~" + (rate * hrs).toFixed(hrs * rate < 1 ? 2 : 1) + " SOL", i === 0);
        }).join("");
        choice = { kind: "stream", hours: 6 };
        sub.textContent = "authorize once — funds stay in YOUR wallet, pulled 0.05/hr per minute watched, revoke any time";
      } else if (seg === "payg") {
        box.innerHTML = presets.map(function (sol, i) {
          var hrs = sol / rate;
          return tierCard("payg:" + Math.round(sol * 1e9), sol, "SOL", "~" + (hrs >= 1 ? hrs.toFixed(0) + "h" : Math.round(hrs * 60) + "m"), i === 1);
        }).join("");
        choice = { kind: "payg", lamports: Math.round(presets[1] * 1e9) };
        sub.textContent = "deposit burns at " + rate + " SOL/hr, only while open — top up any time";
      } else {
        box.innerHTML = tierCard("day", 1, "SOL · 1 day", "", false) + tierCard("month", 18, "SOL · 30 days", "save 40%", true);
        choice = { kind: "month" };
        sub.textContent = "unlimited access for the whole window";
      }
      box.querySelectorAll(".cwp-opt").forEach(function (el) {
        el.onclick = function () {
          box.querySelectorAll(".cwp-opt").forEach(function (x) { x.classList.remove("sel"); });
          el.classList.add("sel");
          var k = el.dataset.kind;
          if (k.indexOf("payg:") === 0) choice = { kind: "payg", lamports: +k.split(":")[1] };
          else if (k.indexOf("stream:") === 0) choice = { kind: "stream", hours: +k.split(":")[1] };
          else choice = { kind: k };
        };
      });
    }
    overlay.querySelectorAll("#cwp-seg button").forEach(function (b) {
      b.onclick = function () {
        overlay.querySelectorAll("#cwp-seg button").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        seg = b.dataset.m;
        renderOpts();
      };
    });
    renderOpts();

    overlay.querySelector("#cwp-go").onclick = function () {
      var btn = this;
      btn.disabled = true;
      var sel = choice;
      setMsg("choose a wallet…");
      pickWallet().then(function (adapter) {
        wa = adapter;
        setMsg("connecting " + adapter.name + "…");
        return wa.connect();
      }).then(function (pubkey) {
        wallet = pubkey;
        localStorage.setItem(LSK_WALLET, wallet);
        return checkStatus();
      }).then(function (already) {
        if (already) return "done";
        if (sel.kind === "stream") return runStream(sel.hours);
        return runPayment(sel);
      }).then(function (r) {
        if (r === "done") {
          subscribed = true;
          setMsg("funded — welcome to the carnage");
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

  // sign a base64 tx and wait for on-chain confirmation
  function signAndWait(txB64, label) {
    setMsg(label);
    return loadWeb3().then(function (w3) {
      var tx = w3.VersionedTransaction.deserialize(b64ToBytes(txB64));
      return wa.signAndSend(tx);
    }).then(function (sig) {
      var signature = sigStr(sig);
      setMsg("confirming " + signature.slice(0, 8) + "…");
      return signature;
    });
  }

  // flat pass / prepay: one transfer, then confirm
  function runPayment(sel) {
    return j(RELAY + "/api/sub/tx", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: wallet, kind: sel.kind, lamports: sel.lamports }),
    }).then(function (out) {
      if (!out || out.error) throw new Error((out && out.error) || "tx build failed");
      return signAndWait(out.tx, "approve " + (Number(out.lamports) / 1e9).toFixed(2) + " SOL in your wallet…").then(function (signature) {
        return new Promise(function (resolve) {
          var tries = 0;
          (function poll() {
            j(RELAY + "/api/sub/confirm", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ wallet: wallet, kind: sel.kind, signature: signature }),
            }).then(function (st) {
              if (st.subscribed) { applyStatus(st); return resolve("done"); }
              // hard error (payment failed / wrong wallet) → stop; pending → keep polling
              if (st.error && !/not found|not confirmed|pending|confirming/i.test(st.error)) {
                setMsg(st.error, true); return resolve("error");
              }
              setMsg("confirming payment…");
              if (++tries > 45) return resolve("timeout");
              setTimeout(poll, 2000);
            }).catch(function () { setTimeout(poll, 2000); });
          })();
        });
      });
    });
  }

  // streaming: authorize once (2 sigs for first-timers: init authority, then
  // the recurring delegation). Funds stay in your wallet; pulled per minute.
  function runStream(hours) {
    function build() {
      return j(RELAY + "/api/sub/stream/tx", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: wallet, hours: hours }),
      }).then(function (out) {
        if (!out || out.error) throw new Error((out && out.error) || "authorization build failed");
        return out;
      });
    }
    // poll build() until it returns the delegate step (authority now on-chain)
    function waitDelegate(tries) {
      return build().then(function (out) {
        if (out.step === "delegate") return out;
        if ((tries || 0) > 40) throw new Error("setup didn't confirm — check your balance & retry");
        return new Promise(function (r) { setTimeout(r, 2500); }).then(function () { return waitDelegate((tries || 0) + 1); });
      });
    }
    function delegate(out) {
      return signAndWait(out.tx, "approve the stream authorization in your wallet…").then(function (signature) {
        return new Promise(function (resolve) {
          var tries = 0;
          (function poll() {
            j(RELAY + "/api/sub/stream/confirm", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ wallet: wallet, hours: hours, nonce: out.nonce, signature: signature }),
            }).then(function (st) {
              if (st.subscribed) { applyStatus(st); return resolve("done"); }
              if (st.error) setMsg(st.error, true);
              else setMsg("confirming authorization…");
              if (++tries > 45) return resolve("timeout");
              setTimeout(poll, 2000);
            }).catch(function () { setTimeout(poll, 2000); });
          })();
        });
      });
    }
    return build().then(function (out) {
      if (out.step === "delegate") return delegate(out);
      // first-timer: sign the authority setup, wait until it's live, then delegate
      return signAndWait(out.tx, "approve setup (1/2) in your wallet…").then(function () {
        setMsg("setup confirmed — preparing the stream authorization…");
        return waitDelegate(0).then(delegate);
      });
    });
  }

  function hideOverlay() { if (overlay) { overlay.remove(); overlay = null; } }

  // watch-time accounting for the free window (visibility-gated)
  setInterval(function () {
    if (document.visibilityState !== "visible") return;
    if (!subscribed) {
      watched += 5;
      localStorage.setItem(LSK_TIME, String(watched));
      if (watched >= FREE_SECONDS && enabled !== false) showOverlay();
    }
  }, 5000);

  // pay-as-you-go meter: burn credit only while the tab is open + funded
  setInterval(function () {
    if (document.visibilityState !== "visible" || !subscribed || !wallet) return;
    j(RELAY + "/api/sub/meter", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: wallet }),
    }).then(function (st) {
      applyStatus(st);
      if (!st.subscribed) { watched = FREE_SECONDS; showOverlay(); }
    }).catch(function () {});
  }, 10000);

  // boot
  j(RELAY + "/api/sub/info").then(function (i) {
    info = i; enabled = i.enabled !== false;
    if (!enabled) return;
    checkStatus().then(function (ok) {
      if (ok) hideOverlay();
      else if (watched >= FREE_SECONDS) showOverlay();
    });
  }).catch(function () { enabled = false; });
})();

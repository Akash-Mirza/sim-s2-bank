import type { FastifyInstance } from "fastify";
import type { Env } from "../../config/env.js";
import { MODE } from "../../domain/constants.js";

export interface ConsoleRouteDeps {
  env: Env;
}

/**
 * The ops console (`S2-10`).
 *
 * One self-contained HTML page served by the API process, so it ships through the
 * same Vercel function and rewrite as everything else — no second deployment, no
 * static build, no CORS surface. The page itself is public; every read and write it
 * makes goes through `/ops/v1` and carries a session token.
 */
const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>S2 Simulator — Ops Console</title>
<style>
  :root { color-scheme: dark; --bg:#0b0f16; --panel:#131925; --line:#243044; --text:#e6edf7; --muted:#8ea0b8; --accent:#4da3ff; --bad:#ff6b6b; --good:#3ddc97; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { display:flex; align-items:center; gap:12px; padding:14px 20px; border-bottom:1px solid var(--line); background:var(--panel); }
  header h1 { font-size:15px; margin:0; letter-spacing:.02em; }
  header .spacer { flex:1; }
  header .who { color:var(--muted); font-size:12px; }
  main { padding:20px; max-width:1180px; margin:0 auto; }
  button { background:#1c2739; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 10px; font:inherit; cursor:pointer; }
  button:hover { border-color:var(--accent); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#06111f; font-weight:600; }
  button.danger { color:var(--bad); }
  input { background:#0f1520; border:1px solid var(--line); border-radius:6px; color:var(--text); padding:8px 10px; font:inherit; width:100%; }
  label { display:block; margin-bottom:12px; color:var(--muted); font-size:12px; }
  #login { max-width:340px; margin:60px auto; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:20px; }
  nav#tabs { display:flex; gap:6px; margin-bottom:14px; flex-wrap:wrap; }
  nav#tabs button.active { border-color:var(--accent); color:var(--accent); }
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); font-size:12.5px; vertical-align:top; }
  th { color:var(--muted); font-weight:600; background:#0f1520; }
  tr:last-child td { border-bottom:none; }
  td .muted, .muted { color:var(--muted); }
  .error { color:var(--bad); min-height:18px; margin:8px 0 0; }
  .pill { display:inline-block; padding:1px 7px; border-radius:999px; border:1px solid var(--line); font-size:11px; }
  .pill.good { color:var(--good); border-color:#1f6b4d; }
  .pill.bad { color:var(--bad); border-color:#7a2c2c; }
  #toast { position:fixed; right:20px; bottom:20px; display:flex; flex-direction:column; gap:8px; }
  #toast div { background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--good); padding:8px 12px; border-radius:6px; font-size:12.5px; }
  #toast div.bad { border-left-color:var(--bad); }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; }
</style>
</head>
<body>
<header>
  <h1>S2 Bank Simulator</h1>
  <span class="pill">mode: sim</span>
  <span class="spacer"></span>
  <span class="who" id="who"></span>
  <button id="logout" hidden>Sign out</button>
</header>
<main>
  <section id="login">
    <form id="login-form">
      <h2 style="margin:0 0 16px;font-size:15px">Ops sign in</h2>
      <label>Email <input id="email" type="email" autocomplete="username" required /></label>
      <label>Password <input id="password" type="password" autocomplete="current-password" required /></label>
      <button class="primary" type="submit">Sign in</button>
      <p class="error" id="login-error"></p>
    </form>
  </section>
  <section id="app" hidden>
    <nav id="tabs">
      <button data-tab="accounts" class="active">Accounts</button>
      <button data-tab="payouts">Payouts</button>
      <button data-tab="scenarios">Scenarios</button>
      <button data-tab="webhooks">Webhooks</button>
      <button data-tab="audit">Audit</button>
    </nav>
    <div id="panel"></div>
  </section>
</main>
<div id="toast"></div>
<script>
(function () {
  var token = sessionStorage.getItem("s2ops") || "";
  var me = null;
  var currentTab = "accounts";

  function q(id) { return document.getElementById(id); }
  function newKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return String(Date.now()) + "-" + String(Math.random()).slice(2);
  }
  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function toast(message, bad) {
    var node = document.createElement("div");
    if (bad) node.className = "bad";
    node.textContent = message;
    q("toast").appendChild(node);
    setTimeout(function () { node.remove(); }, 5000);
  }
  function table(headers, rows) {
    var head = headers.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("");
    var body = rows.length
      ? rows.map(function (row) {
          return "<tr>" + row.map(function (cell) { return "<td>" + cell + "</td>"; }).join("") + "</tr>";
        }).join("")
      : '<tr><td class="muted" colspan="' + headers.length + '">nothing yet</td></tr>';
    return "<table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>";
  }
  function pill(status) {
    var good = ["delivered", "settled", "active", "open"].indexOf(status) >= 0;
    var bad = ["dead", "failed", "returned", "cancelled", "disabled"].indexOf(status) >= 0;
    return '<span class="pill ' + (good ? "good" : bad ? "bad" : "") + '">' + esc(status) + "</span>";
  }
  function short(id) { return "<code>" + esc(String(id).slice(0, 8)) + "</code>"; }

  async function api(path, options) {
    options = options || {};
    var headers = {
      "content-type": "application/json",
      "idempotency-key": options.idempotencyKey || newKey(),
    };
    if (token) headers.authorization = "Bearer " + token;
    var response = await fetch(path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    var text = await response.text();
    var data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (error) { data = { raw: text }; }
    if (!response.ok) {
      var err = data && data.error ? data.error : null;
      if (response.status === 401) signOut(true);
      throw new Error(err ? err.code + ": " + err.message : "HTTP " + response.status);
    }
    return data;
  }

  function signIn(session, user) {
    token = session;
    me = user;
    sessionStorage.setItem("s2ops", token);
    q("login").hidden = true;
    q("app").hidden = false;
    q("logout").hidden = false;
    q("who").textContent = user.display_name + " · " + user.role;
    render();
  }
  function signOut(expired) {
    token = "";
    sessionStorage.removeItem("s2ops");
    q("login").hidden = false;
    q("app").hidden = true;
    q("logout").hidden = true;
    q("who").textContent = "";
    if (expired) q("login-error").textContent = "session expired, sign in again";
  }

  async function loadAccounts() {
    var data = await api("/ops/v1/accounts?limit=25");
    var rows = data.data.map(function (account) {
      return [
        "<code>" + esc(account.iban) + "</code><br><span class='muted'>" + esc(account.product_code) + "</span>",
        pill(account.status),
        esc(account.balance.available),
        esc(account.balance.held),
        esc(account.balance.ledger),
        '<button onclick="creditAccount(\\'' + account.id + '\\',\\'' + esc(account.iban) + '\\')">Credit</button>',
      ];
    });
    q("panel").innerHTML = table(["IBAN", "Status", "Available", "Held", "Ledger", ""], rows);
  }

  async function loadPayouts() {
    var data = await api("/ops/v1/payouts?limit=25");
    var rows = data.data.map(function (payout) {
      var actions = '<button onclick="advancePayout(\\'' + payout.id + '\\')">Advance</button> ' +
        '<button onclick="armScenario(\\'' + payout.id + '\\')">Arm fault</button> ' +
        (payout.status === "settled" ? '<button class="danger" onclick="reversePayout(\\'' + payout.id + '\\')">Reverse</button>' : "");
      return [
        short(payout.id),
        pill(payout.status),
        esc(payout.amount) + " " + esc(payout.currency),
        esc(payout.beneficiary.name),
        esc(payout.settled_amount === null ? "" : payout.settled_amount),
        actions,
      ];
    });
    q("panel").innerHTML = table(["ID", "Status", "Amount", "Beneficiary", "Settled", ""], rows);
  }

  async function loadScenarios() {
    var data = await api("/ops/v1/scenarios?limit=25");
    var rows = data.data.map(function (scenario) {
      return [
        esc(scenario.kind),
        pill(scenario.status),
        short(scenario.payout_id),
        esc(scenario.shortfall === null ? "" : scenario.shortfall),
        scenario.status === "armed"
          ? '<button class="danger" onclick="disarmScenario(\\'' + scenario.id + '\\')">Disarm</button>'
          : "",
      ];
    });
    q("panel").innerHTML = table(["Kind", "Status", "Payout", "Shortfall", ""], rows);
  }

  async function loadWebhooks() {
    var data = await api("/ops/v1/webhooks/deliveries?limit=25");
    var rows = data.data.map(function (delivery) {
      return [
        pill(delivery.status),
        esc(delivery.attempts),
        esc(delivery.last_status_code === null ? "" : delivery.last_status_code),
        short(delivery.event_id),
        '<button onclick="replayDelivery(\\'' + delivery.id + '\\')">Replay</button>',
      ];
    });
    q("panel").innerHTML = table(["Status", "Attempts", "HTTP", "Event", ""], rows);
  }

  async function loadAudit() {
    var data = await api("/ops/v1/audit?limit=30");
    var rows = data.data.map(function (entry) {
      return [
        '<span class="muted">' + esc(new Date(entry.at).toLocaleString()) + "</span>",
        esc(entry.actor),
        esc(entry.action),
        esc(entry.entity_type) + " " + short(entry.entity_id === null ? "" : entry.entity_id),
      ];
    });
    q("panel").innerHTML = table(["At", "Actor", "Action", "Entity"], rows);
  }

  function render() {
    var loaders = {
      accounts: loadAccounts,
      payouts: loadPayouts,
      scenarios: loadScenarios,
      webhooks: loadWebhooks,
      audit: loadAudit,
    };
    q("panel").innerHTML = '<p class="muted">loading ' + currentTab + "…</p>";
    loaders[currentTab]().catch(function (error) {
      q("panel").innerHTML = '<p class="error">' + esc(error.message) + "</p>";
    });
  }

  window.creditAccount = function (id, iban) {
    var amount = prompt("Amount to credit " + iban + " (AED)");
    if (!amount) return;
    api("/ops/v1/accounts/" + id + "/simulate-credit", { method: "POST", body: { amount: amount } })
      .then(function () { toast("credit posted"); return loadAccounts(); })
      .catch(function (error) { toast(error.message, true); });
  };
  window.advancePayout = function (id) {
    api("/ops/v1/payouts/" + id + "/advance", { method: "POST", body: {} })
      .then(function (data) { toast("payout " + data.payout.status); return loadPayouts(); })
      .catch(function (error) { toast(error.message, true); });
  };
  window.reversePayout = function (id) {
    if (!confirm("Return settled funds for this payout?")) return;
    api("/ops/v1/payouts/" + id + "/reverse", { method: "POST", body: {} })
      .then(function () { toast("payout returned"); return loadPayouts(); })
      .catch(function (error) { toast(error.message, true); });
  };
  window.armScenario = function (payoutId) {
    var kind = prompt("Scenario: underpaid, sanctions_hold, bank_timeout, returned", "underpaid");
    if (!kind) return;
    var shortfall = kind === "underpaid" ? prompt("Shortfall AED (blank = 10%)", "") : "";
    var body = { payout_id: payoutId, kind: kind };
    if (shortfall) body.shortfall = shortfall;
    api("/ops/v1/scenarios", { method: "POST", body: body })
      .then(function () { toast("scenario armed"); return loadScenarios(); })
      .catch(function (error) { toast(error.message, true); });
  };
  window.disarmScenario = function (id) {
    api("/ops/v1/scenarios/" + id, { method: "DELETE", body: {} })
      .then(function () { toast("scenario disarmed"); return loadScenarios(); })
      .catch(function (error) { toast(error.message, true); });
  };
  window.replayDelivery = function (id) {
    api("/ops/v1/webhooks/deliveries/" + id + "/replay", { method: "POST", body: {} })
      .then(function () { toast("delivery re-armed"); return loadWebhooks(); })
      .catch(function (error) { toast(error.message, true); });
  };

  q("login-form").addEventListener("submit", function (event) {
    event.preventDefault();
    q("login-error").textContent = "";
    api("/ops/v1/auth/login", {
      method: "POST",
      body: { email: q("email").value, password: q("password").value },
    })
      .then(function (data) { signIn(data.token, data.user); })
      .catch(function (error) { q("login-error").textContent = error.message; });
  });

  q("logout").addEventListener("click", function () {
    api("/ops/v1/auth/logout", { method: "POST", body: {} })
      .catch(function () { /* the session may already be gone */ })
      .then(function () { signOut(false); });
  });

  q("tabs").addEventListener("click", function (event) {
    var button = event.target.closest("button[data-tab]");
    if (!button) return;
    currentTab = button.getAttribute("data-tab");
    Array.prototype.forEach.call(q("tabs").children, function (node) {
      node.classList.toggle("active", node === button);
    });
    render();
  });

  if (token) {
    api("/ops/v1/auth/me")
      .then(function (data) { signIn(token, data.user); })
      .catch(function () { signOut(false); });
  }
})();
</script>
</body>
</html>`;

export function registerConsoleRoutes(app: FastifyInstance, deps: ConsoleRouteDeps): void {
  app.get("/ops", async (_request, reply) => reply.redirect("/ops/console"));

  app.get("/ops/console", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    reply.header("cache-control", "no-store");
    reply.header("x-sim-mode", MODE);
    return CONSOLE_HTML;
  });

  // Expose just enough for a load balancer or a curl smoke test.
  app.get("/ops/v1/console/info", async () => ({
    mode: MODE,
    console: "/ops/console",
    login: "/ops/v1/auth/login",
    version: deps.env.version,
  }));
}

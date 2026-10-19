#!/usr/bin/env node
// Local approval dashboard. This is the ONLY place a draft becomes a real HCB
// transfer: a human selects drafts and presses Approve.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { api, HcbError } from "./hcb.js";
import { listDrafts, getDraft, transition } from "./store.js";
import { DASHBOARD_PORT, loadConfig } from "./config.js";

const CSRF = randomBytes(24).toString("hex");
const ALLOWED_HOSTS = new Set([`127.0.0.1:${DASHBOARD_PORT}`, `localhost:${DASHBOARD_PORT}`]);
const html = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

const usd = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function balances(orgIds) {
  const out = {};
  await Promise.all(
    [...new Set(orgIds)].map(async (id) => {
      try {
        const o = await api.organization(id, ["balance_cents"]);
        out[id] = { balance_cents: o.balance_cents, frozen: o.financially_frozen };
      } catch (e) {
        out[id] = { error: e.message };
      }
    })
  );
  return out;
}

// Serialise approvals so balance checks and sends from two clicks can't interleave.
let approving = Promise.resolve();

async function approve(ids) {
  const drafts = ids.map(getDraft).filter(Boolean);
  const approvable = drafts.filter((d) => d.status === "pending" || d.status === "failed");
  if (approvable.length === 0) return { status: 409, body: { error: "None of the selected drafts can be approved." } };

  // HCB skips its own balance check for admins, so check here for everyone.
  const totals = {};
  for (const d of approvable) totals[d.from_org_id] = (totals[d.from_org_id] || 0) + d.amount_cents;
  const bal = await balances(Object.keys(totals));
  const problems = [];
  for (const [org, total] of Object.entries(totals)) {
    const b = bal[org];
    const name = approvable.find((d) => d.from_org_id === org).from_org_name ?? org;
    if (b.error) problems.push(`Couldn't read ${name}'s balance: ${b.error}`);
    else if (b.frozen) problems.push(`${name} is financially frozen.`);
    else if (total > b.balance_cents) problems.push(`${name}: selected ${usd(total)} but only ${usd(b.balance_cents)} available.`);
  }
  if (problems.length) return { status: 409, body: { error: problems.join(" ") } };

  const results = [];
  for (const d of approvable) {
    if (!transition(d.id, ["pending", "failed"], "sending", { approved_at: new Date().toISOString(), error: null })) {
      results.push({ id: d.id, status: getDraft(d.id).status, skipped: true });
      continue;
    }
    try {
      const t = await api.createTransfer(d.from_org_id, {
        to_organization_id: d.to_org_id,
        name: d.name,
        amount_cents: d.amount_cents,
      });
      transition(d.id, ["sending"], "sent", { hcb_transfer_id: t.id, hcb_status: t.status });
    } catch (e) {
      // 4xx: HCB rejected it, nothing was created. Anything else (5xx, timeout,
      // network) might have gone through, so it needs a human to check.
      const definite = e instanceof HcbError && e.status >= 400 && e.status < 500;
      transition(d.id, ["sending"], definite ? "failed" : "unknown", { error: e.message });
    }
    results.push(getDraft(d.id));
  }
  return { status: 200, body: { results } };
}

const server = createServer(async (req, res) => {
  // Block DNS-rebinding and cross-site requests: only our own origin may talk to us.
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, { error: "bad host" });
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    });
    return res.end(html.replace("__CSRF__", CSRF).replace("__HCB_BASE__", loadConfig().baseUrl));
  }
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

  if (url.pathname.startsWith("/api/")) {
    const origin = req.headers.origin;
    if (req.headers["x-csrf"] !== CSRF || (origin && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, "")))) {
      return send(res, 403, { error: "Reload the dashboard (session token changed)." });
    }
    try {
      if (req.method === "GET" && url.pathname === "/api/drafts") {
        return send(res, 200, { drafts: listDrafts() });
      }
      if (req.method === "GET" && url.pathname === "/api/me") {
        return send(res, 200, await api.me());
      }
      if (req.method === "GET" && url.pathname === "/api/balances") {
        const orgs = listDrafts().filter((d) => ["pending", "failed"].includes(d.status)).map((d) => d.from_org_id);
        return send(res, 200, await balances(orgs));
      }
      if (req.method === "POST" && url.pathname === "/api/approve") {
        const { ids } = await readJson(req);
        if (!Array.isArray(ids)) return send(res, 400, { error: "ids required" });
        const run = approving.then(() => approve(ids));
        approving = run.catch(() => {});
        const r = await run;
        return send(res, r.status, r.body);
      }
      if (req.method === "POST" && url.pathname === "/api/cancel") {
        const { ids } = await readJson(req);
        const cancelled = (ids || []).filter((id) => transition(id, ["pending", "failed"], "cancelled"));
        return send(res, 200, { cancelled });
      }
      if (req.method === "POST" && url.pathname === "/api/resolve") {
        // For `unknown` drafts after the human has checked HCB.
        const { id, outcome } = await readJson(req);
        if (!["sent", "failed"].includes(outcome)) return send(res, 400, { error: "outcome must be sent or failed" });
        const okay = transition(id, ["unknown"], outcome, { error: outcome === "failed" ? "Marked not sent after manual check." : null });
        return send(res, okay ? 200 : 409, okay ? getDraft(id) : { error: "Draft isn't in unknown state." });
      }
    } catch (e) {
      return send(res, e instanceof HcbError ? 502 : 500, { error: e.message });
    }
  }
  send(res, 404, { error: "not found" });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${DASHBOARD_PORT} is in use — the dashboard is probably already running at http://127.0.0.1:${DASHBOARD_PORT}/`);
    process.exit(1);
  }
  throw e;
});

server.listen(DASHBOARD_PORT, "127.0.0.1", () => {
  // Only once we own the port (so no other dashboard is mid-send): a send that
  // was in flight when a previous dashboard died may or may not have reached
  // HCB. Never resend those automatically.
  for (const d of listDrafts("sending")) {
    transition(d.id, ["sending"], "unknown", { error: "Dashboard stopped mid-send. Check HCB before retrying." });
  }
  console.log(`HCB disbursement dashboard: http://127.0.0.1:${DASHBOARD_PORT}/`);
});

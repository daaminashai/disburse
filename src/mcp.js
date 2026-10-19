#!/usr/bin/env node
// MCP server: lets an agent look up HCB organizations and *draft* disbursements.
// Deliberately has no tool that sends money. Drafts only go out when a human
// selects them in the local dashboard and presses Approve.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { api, HcbError } from "./hcb.js";
import { createDraft, listDrafts, getDraft, transition } from "./store.js";
import { DASHBOARD_PORT } from "./config.js";

const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}/`;
const usd = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] });
const wrap = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return fail(e);
  }
};

const summarizeOrg = (o) => ({
  id: o.id,
  name: o.name,
  slug: o.slug,
  balance: o.balance_cents != null ? usd(o.balance_cents) : undefined,
  balance_cents: o.balance_cents,
  financially_frozen: o.financially_frozen || undefined,
});

const summarizeDraft = (d) => ({
  id: d.id,
  status: d.status,
  from: `${d.from_org_name ?? d.from_org_id} (${d.from_org_id})`,
  to: `${d.to_org_name ?? d.to_org_id} (${d.to_org_id})`,
  amount: usd(d.amount_cents),
  name: d.name,
  rationale: d.rationale ?? undefined,
  warning: d.warning ?? undefined,
  error: d.error ?? undefined,
  hcb_transfer_id: d.hcb_transfer_id ?? undefined,
  created_at: d.created_at,
});

async function dashboardRunning() {
  try {
    const r = await fetch(`${DASHBOARD_URL}health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureDashboard() {
  if (await dashboardRunning()) return;
  const script = fileURLToPath(new URL("./dashboard.js", import.meta.url));
  spawn(process.execPath, [script], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await dashboardRunning()) return;
  }
  throw new Error(`Dashboard didn't start. Run \`npm run dashboard\` in the disburse folder.`);
}

function openInBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

const server = new McpServer({ name: "hcb-disburse", version: "0.1.0" });

server.registerTool(
  "whoami",
  {
    title: "Who am I on HCB",
    description: "Show the HCB user this server is logged in as.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  wrap(async () => {
    const me = await api.me();
    return ok({ id: me.id, name: me.name, email: me.email });
  })
);

server.registerTool(
  "list_organizations",
  {
    title: "List my HCB organizations",
    description:
      "List the HCB organizations the logged-in user belongs to, with available balances. Use these ids as `from_organization` when drafting.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  wrap(async () => {
    const orgs = await api.organizations(["balance_cents"]);
    return ok(orgs.map(summarizeOrg));
  })
);

server.registerTool(
  "lookup_organization",
  {
    title: "Look up an HCB organization",
    description:
      "Resolve an HCB organization by public id (org_…) or slug (the part after hcb.hackclub.com/). Only works for orgs the user can read.",
    inputSchema: { organization: z.string().min(1).describe("org_… id or slug") },
    annotations: { readOnlyHint: true },
  },
  wrap(async ({ organization }) => ok(summarizeOrg(await api.organization(organization, ["balance_cents"]))))
);

const draftInput = z.object({
  from_organization: z.string().min(1).describe("Source org: org_… id or slug. Must be one of the user's organizations."),
  to_organization: z.string().min(1).describe("Destination org: org_… id or slug."),
  amount_cents: z.number().int().positive().describe("Amount in cents, e.g. 2500 for $25.00."),
  name: z.string().min(1).max(200).describe("Transfer name/reason shown on both ledgers on HCB."),
  rationale: z.string().max(2000).optional().describe("Why you're proposing this. Shown to the approver only; not sent to HCB."),
});

async function resolveOrg(idOrSlug, cache) {
  if (cache.has(idOrSlug)) return cache.get(idOrSlug);
  const p = api.organization(idOrSlug, ["balance_cents"]).then(
    (o) => ({ org: o }),
    (e) => ({ error: e })
  );
  cache.set(idOrSlug, p);
  return p;
}

server.registerTool(
  "draft_disbursements",
  {
    title: "Draft HCB disbursements",
    description:
      "Create one or more DRAFT transfers between HCB organizations. Nothing is sent: a human must open the dashboard (open_dashboard), select drafts and press Approve. Validates that the source org is readable and flags drafts that exceed its balance.",
    inputSchema: { disbursements: z.array(draftInput).min(1).max(100) },
  },
  wrap(async ({ disbursements }) => {
    const cache = new Map();
    const created = [];
    const rejected = [];
    const pendingBySource = new Map();
    for (const d of listDrafts("pending")) {
      pendingBySource.set(d.from_org_id, (pendingBySource.get(d.from_org_id) || 0) + d.amount_cents);
    }

    for (const [i, d] of disbursements.entries()) {
      const from = await resolveOrg(d.from_organization, cache);
      if (from.error) {
        rejected.push({ index: i, reason: `Source org "${d.from_organization}": ${from.error.message}` });
        continue;
      }
      const src = from.org;
      if (src.financially_frozen) {
        rejected.push({ index: i, reason: `${src.name} is financially frozen on HCB.` });
        continue;
      }

      const to = await resolveOrg(d.to_organization, cache);
      const warnings = [];
      let dest = to.org;
      if (to.error) {
        // The user may be allowed to send to orgs they can't read; HCB decides at send time.
        if (!/^org_/.test(d.to_organization) && to.error instanceof HcbError && to.error.status === 404) {
          rejected.push({ index: i, reason: `Destination "${d.to_organization}" not found on HCB.` });
          continue;
        }
        warnings.push(`Couldn't verify destination (${to.error.message}); HCB will check permissions at send time.`);
      } else if (dest.id === src.id) {
        rejected.push({ index: i, reason: "Source and destination are the same organization." });
        continue;
      }

      const queued = (pendingBySource.get(src.id) || 0) + d.amount_cents;
      if (src.balance_cents != null && queued > src.balance_cents) {
        warnings.push(`Pending drafts from ${src.name} total ${usd(queued)}, more than its ${usd(src.balance_cents)} balance.`);
      }
      pendingBySource.set(src.id, queued);

      created.push(
        createDraft({
          from_org_id: src.id,
          from_org_name: src.name,
          from_org_slug: src.slug,
          to_org_id: dest?.id ?? d.to_organization,
          to_org_name: dest?.name,
          to_org_slug: dest?.slug,
          amount_cents: d.amount_cents,
          name: d.name,
          rationale: d.rationale,
          warning: warnings.join(" ") || null,
        })
      );
    }

    return ok({
      drafted: created.map(summarizeDraft),
      rejected,
      next_step: created.length
        ? `Nothing has been sent. Ask the user to review and approve in the dashboard (call open_dashboard, or visit ${DASHBOARD_URL}).`
        : undefined,
    });
  })
);

server.registerTool(
  "list_drafts",
  {
    title: "List drafted disbursements",
    description: "List drafts and their status (pending, sending, sent, failed, unknown, cancelled).",
    inputSchema: {
      status: z.enum(["pending", "sending", "sent", "failed", "unknown", "cancelled"]).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  wrap(async ({ status }) => ok(listDrafts(status).map(summarizeDraft)))
);

server.registerTool(
  "cancel_draft",
  {
    title: "Cancel a draft",
    description: "Cancel a pending draft so it can't be approved. Can't undo a transfer that was already sent.",
    inputSchema: { id: z.string().describe("Draft id (drf_…)") },
    annotations: { destructiveHint: false },
  },
  wrap(async ({ id }) => {
    const d = getDraft(id);
    if (!d) throw new Error(`No draft ${id}.`);
    if (!transition(id, ["pending", "failed"], "cancelled")) throw new Error(`Draft ${id} is ${d.status}; only pending or failed drafts can be cancelled.`);
    return ok(summarizeDraft(getDraft(id)));
  })
);

server.registerTool(
  "open_dashboard",
  {
    title: "Open the approval dashboard",
    description:
      "Start (if needed) and open the local approval dashboard in the user's browser, where they select drafts and press Approve to send them.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  wrap(async () => {
    await ensureDashboard();
    openInBrowser(DASHBOARD_URL);
    const n = listDrafts("pending").length;
    return ok(`Opened ${DASHBOARD_URL} — ${n} draft(s) waiting for approval.`);
  })
);

await server.connect(new StdioServerTransport());

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { DB_PATH } from "./config.js";

// Draft lifecycle:
//   pending  -> (human approves in dashboard) -> sending -> sent | failed | unknown
//   pending  -> cancelled
//   failed   -> pending (human chooses "retry")
// Only the dashboard moves a draft out of `pending` toward HCB.
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    from_org_id TEXT NOT NULL,
    from_org_name TEXT,
    from_org_slug TEXT,
    to_org_id TEXT NOT NULL,
    to_org_name TEXT,
    to_org_slug TEXT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    name TEXT NOT NULL,
    rationale TEXT,
    warning TEXT,
    hcb_transfer_id TEXT,
    hcb_status TEXT,
    error TEXT,
    approved_at TEXT
  );
`);

const now = () => new Date().toISOString();

export function createDraft(d) {
  const id = `drf_${randomUUID().slice(0, 8)}`;
  const t = now();
  db.prepare(
    `INSERT INTO drafts (id, created_at, updated_at, status, from_org_id, from_org_name, from_org_slug,
       to_org_id, to_org_name, to_org_slug, amount_cents, name, rationale, warning)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, t, t, d.from_org_id, d.from_org_name ?? null, d.from_org_slug ?? null,
    d.to_org_id, d.to_org_name ?? null, d.to_org_slug ?? null,
    d.amount_cents, d.name, d.rationale ?? null, d.warning ?? null);
  return getDraft(id);
}

export function getDraft(id) {
  return db.prepare("SELECT * FROM drafts WHERE id = ?").get(id);
}

export function listDrafts(status) {
  return status
    ? db.prepare("SELECT * FROM drafts WHERE status = ? ORDER BY created_at DESC").all(status)
    : db.prepare("SELECT * FROM drafts ORDER BY created_at DESC").all();
}

// Atomic compare-and-set so two approvals (two tabs, or dashboard + anything
// else) can never both claim the same draft and send it twice.
export function transition(id, from, to, fields = {}) {
  const cols = Object.keys(fields);
  const sets = ["status = ?", "updated_at = ?", ...cols.map((c) => `${c} = ?`)].join(", ");
  const r = db
    .prepare(`UPDATE drafts SET ${sets} WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`)
    .run(to, now(), ...cols.map((c) => fields[c]), id, ...from);
  return r.changes === 1;
}

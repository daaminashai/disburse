import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { TOKEN_PATH, loadConfig } from "./config.js";

export class HcbError extends Error {
  constructor(status, body) {
    const msgs = body?.messages?.length ? body.messages.join("; ") : body?.error || `HTTP ${status}`;
    super(msgs);
    this.status = status;
    this.body = body;
  }
}

export function readToken() {
  if (!existsSync(TOKEN_PATH)) return null;
  return JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
}

export function saveToken(tokenResponse) {
  const token = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    scope: tokenResponse.scope,
    // Doorkeeper returns created_at in seconds; fall back to now.
    obtained_at: (tokenResponse.created_at || Math.floor(Date.now() / 1000)) * 1000,
    expires_in: tokenResponse.expires_in ?? null,
  };
  const tmp = `${TOKEN_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
  renameSync(tmp, TOKEN_PATH);
  return token;
}

function isExpiringSoon(token) {
  if (!token.expires_in) return false;
  return Date.now() > token.obtained_at + (token.expires_in - 120) * 1000;
}

export async function oauthToken(params) {
  const { baseUrl, clientId, clientSecret } = loadConfig();
  const res = await fetch(`${baseUrl}/api/v4/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HcbError(res.status, body);
  return saveToken(body);
}

async function refresh(stale) {
  // The MCP server and dashboard are separate processes sharing one token file.
  // If the other one already refreshed, use its token instead of burning ours.
  const current = readToken();
  if (current && current.access_token !== stale.access_token && !isExpiringSoon(current)) return current;
  if (!stale.refresh_token) throw new Error("HCB token expired and has no refresh token. Run `npm run login`.");
  try {
    return await oauthToken({ grant_type: "refresh_token", refresh_token: stale.refresh_token });
  } catch (e) {
    const latest = readToken();
    if (latest && latest.access_token !== stale.access_token) return latest;
    throw new Error(`Couldn't refresh HCB token (${e.message}). Run \`npm run login\` again.`);
  }
}

export async function hcb(path, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const { baseUrl } = loadConfig();
  let token = readToken();
  if (!token) throw new Error("Not logged in to HCB. Run `npm run login` in the disburse folder.");
  if (isExpiringSoon(token)) token = await refresh(token);

  const send = (t) =>
    fetch(`${baseUrl}/api/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${t.access_token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

  let res = await send(token);
  // A 401 is returned by HCB's auth filter before the action runs, so retrying
  // once with a fresh token can't double-send a transfer.
  if (res.status === 401) {
    token = await refresh(token);
    res = await send(token);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: "non_json_response", messages: [text.slice(0, 200)] };
  }
  if (!res.ok) throw new HcbError(res.status, json);
  return json;
}

const expandQuery = (expand) => (expand.length ? `?expand=${expand.join(",")}` : "");

export const api = {
  me: () => hcb("/user"),
  organizations: (expand = []) => hcb(`/user/organizations${expandQuery(expand)}`),
  organization: (id, expand = []) => hcb(`/organizations/${encodeURIComponent(id)}${expandQuery(expand)}`),
  createTransfer: (fromOrgId, { to_organization_id, name, amount_cents }) =>
    hcb(`/organizations/${encodeURIComponent(fromOrgId)}/transfers`, {
      method: "POST",
      body: { to_organization_id, name, amount_cents },
    }),
};

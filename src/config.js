import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Everything sensitive lives outside the repo, in a 0700 directory.
export const HOME_DIR = process.env.DISBURSE_HOME || join(homedir(), ".hcb-disburse");
mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });

export const CONFIG_PATH = join(HOME_DIR, "config.json");
export const TOKEN_PATH = join(HOME_DIR, "token.json");
export const DB_PATH = join(HOME_DIR, "drafts.sqlite");

export const DASHBOARD_PORT = Number(process.env.DISBURSE_PORT || 4848);
export const LOGIN_PORT = Number(process.env.DISBURSE_LOGIN_PORT || 4747);
export const REDIRECT_URI = `http://localhost:${LOGIN_PORT}/callback`;

// Least privilege: `restricted` turns on per-action scope enforcement in HCB,
// so this token can only list orgs, read the user, and create transfers.
export const SCOPES = "restricted organizations:read users:read transfers:write";

export function loadConfig() {
  const file = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
  return {
    baseUrl: (process.env.HCB_BASE_URL || file.baseUrl || "https://hcb.hackclub.com").replace(/\/$/, ""),
    clientId: process.env.HCB_CLIENT_ID || file.clientId,
    clientSecret: process.env.HCB_CLIENT_SECRET || file.clientSecret,
  };
}

#!/usr/bin/env node
// One-time setup: save your HCB OAuth app's client id/secret, then sign in via
// the browser (authorization-code flow) to get a v4 API token + refresh token.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { CONFIG_PATH, TOKEN_PATH, LOGIN_PORT, REDIRECT_URI, SCOPES, loadConfig } from "./config.js";
import { oauthToken, api } from "./hcb.js";

async function whoami() {
  const me = await api.me();
  console.log(`Logged in to HCB as ${me.name} <${me.email}> (${me.id})`);
}

if (process.argv.includes("--whoami")) {
  await whoami();
  process.exit(0);
}

let cfg = loadConfig();
if (!cfg.clientId || !cfg.clientSecret || process.argv.includes("--reconfigure")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Redirect URI your HCB OAuth app must allow: ${REDIRECT_URI}`);
  console.log(`Scopes it must be registered with:            ${SCOPES}\n`);
  const baseUrl = (await rl.question(`HCB base URL [${cfg.baseUrl}]: `)) || cfg.baseUrl;
  const clientId = (await rl.question("OAuth client ID (UID): ")).trim();
  const clientSecret = (await rl.question("OAuth client secret: ")).trim();
  rl.close();
  const existing = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, baseUrl, clientId, clientSecret }, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600); // mode above only applies when the file is new
  cfg = loadConfig();
}

const state = randomBytes(16).toString("hex");
const authorizeUrl = new URL(`${cfg.baseUrl}/api/v4/oauth/authorize`);
authorizeUrl.search = new URLSearchParams({
  client_id: cfg.clientId,
  redirect_uri: REDIRECT_URI,
  response_type: "code",
  scope: SCOPES,
  state,
}).toString();

const done = new Promise((resolve, reject) => {
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, REDIRECT_URI);
    if (url.pathname !== "/callback") return res.writeHead(404).end();
    const finish = (msg, err) => {
      res.writeHead(err ? 400 : 200, { "Content-Type": "text/html" });
      res.end(`<body style="font:16px system-ui;padding:3rem">${msg} You can close this tab.</body>`);
      srv.close();
      err ? reject(err) : resolve();
    };
    if (url.searchParams.get("state") !== state) return finish("State mismatch.", new Error("OAuth state mismatch"));
    if (url.searchParams.get("error")) {
      const e = url.searchParams.get("error_description") || url.searchParams.get("error");
      return finish(`HCB said: ${e}.`, new Error(e));
    }
    try {
      await oauthToken({ grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: REDIRECT_URI });
      finish("Signed in to HCB.");
    } catch (e) {
      finish(`Token exchange failed: ${e.message}.`, e);
    }
  });
  srv.listen(LOGIN_PORT, "localhost"); // must match REDIRECT_URI host
});

console.log(`\nOpening HCB to authorize…\nIf the browser doesn't open, visit:\n${authorizeUrl}\n`);
const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
spawn(opener, [authorizeUrl.toString()], { stdio: "ignore", detached: true }).unref();

try {
  await done;
  console.log(`Token saved to ${TOKEN_PATH}`);
  await whoami();
  process.exit(0);
} catch (e) {
  console.error(`Login failed: ${e.message}`);
  process.exit(1);
}

# disburse

An MCP server that lets an AI agent **draft** transfers (disbursements) between
[HCB](https://hcb.hackclub.com) organizations, plus a local dashboard where **you**
select drafts and press **Approve**. Nothing is sent until you do.

```
agent ──MCP──▶ draft_disbursements ──▶ ~/.hcb-disburse/drafts.sqlite
                                              │
you ──browser──▶ http://127.0.0.1:4848  ◀─────┘
                 select ✓  ✓  ✓  → Approve → POST /api/v4/organizations/:org/transfers
```

The MCP server has no tool that moves money. Only the dashboard calls HCB's
transfer endpoint, and only for drafts you selected.

---

## 1. Get an HCB OAuth application

The HCB v4 API only uses OAuth 2.0 tokens (`Authorization: Bearer hcb_…`); there are
no personal API keys. You need an OAuth application to get a token for your account.

On HCB, the OAuth application page (`/api/v4/oauth/applications`) is **admin-only**:
Doorkeeper's `admin_authenticator` redirects anyone who isn't an HCB admin.

- **If you're an HCB admin:** go to <https://hcb.hackclub.com/api/v4/oauth/applications/new>.
- **If you're not:** ask the HCB team (in [#hcb-dev](https://hackclub.slack.com/archives/C068U0JMV19)
  or at hcb@hackclub.com) to register one with the values below and send you its
  client ID and secret.

Register it with these values:

| Field        | Value |
|--------------|-------|
| Name         | anything, e.g. `disburse (your name)` |
| Redirect URI | `http://localhost:4747/callback` |
| Scopes       | `restricted organizations:read users:read transfers:write` |
| Confidential | checked |

The `restricted` scope makes HCB enforce the other scopes. Without it, a token
keeps full access to the whole v4 API. With it, this token can only list your
organizations, read your profile, and create transfers. It can't touch cards,
grants, invoices, ACH, or wires.

## 2. Install and log in

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`).

```bash
npm install
```

```bash
npm run login
```

The command asks for the client ID and secret, opens HCB in your browser, and
asks you to approve. You get an access token and a refresh token. Both are saved
to `~/.hcb-disburse/token.json` (mode `0600`), and the client secret goes to
`~/.hcb-disburse/config.json`. Access tokens expire after 2 hours. The tools
refresh them automatically, so you only need to run login again if the refresh
token gets revoked.

Check that it worked:

```bash
npm run whoami
```

## 3. Add the MCP server to your client

**Claude Code:**

```bash
claude mcp add hcb-disburse -- node "/absolute/path/to/disburse/src/mcp.js"
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hcb-disburse": {
      "command": "node",
      "args": ["/absolute/path/to/disburse/src/mcp.js"]
    }
  }
}
```

### Tools

| Tool | What it does |
|------|--------------|
| `whoami` | Shows the HCB user you're logged in as. |
| `list_organizations` | Lists your organizations with their available balances. |
| `lookup_organization` | Resolves an org by `org_…` ID or slug. |
| `draft_disbursements` | Creates 1–100 drafts. Checks orgs and flags drafts that would overdraw the source. **Doesn't send anything.** |
| `list_drafts` | Lists drafts, optionally filtered by status. |
| `cancel_draft` | Cancels a pending or failed draft. |
| `open_dashboard` | Starts the dashboard if it isn't running and opens it in your browser. |

Example prompt: *"Send $250 from hq-grants to assemble for the venue deposit,
and $100 to robotics for parts. Then open the dashboard."*

## 4. Approve in the dashboard

The agent can open it for you with `open_dashboard`, or you can start it yourself:

```bash
npm run dashboard
```

Then go to <http://127.0.0.1:4848/>. Tick the drafts you want, or tick the header
box to select all, and press **Approve & send N · $total**. Each selected draft is
sent to HCB once, in order, and moved to History with HCB's transfer ID.

- **Balance guard.** Before sending, the dashboard re-reads each source org's
  balance and refuses the whole batch if any source would overdraw. (HCB skips
  its own balance check for HCB admins, so the dashboard checks for everyone.)
- **failed — retry?** HCB rejected the transfer and nothing was created. The
  error is shown on the draft. You can fix the cause and approve it again, or
  cancel it.
- **unknown.** The request timed out, or HCB returned a 5xx. The transfer may or
  may not exist. The dashboard never re-sends these automatically. Check the org's
  transfers on HCB, then click *It went through* or *It didn't*.
- On HCB, a sent transfer's status can be `completed`, or `pending` if HCB's
  team needs to review it.

## Permissions HCB enforces

`POST /api/v4/organizations/:id/transfers` (`DisbursementPolicy#create?`) requires
you to be a **manager** on the source org. You also need to be a manager on the
destination, unless the source org's plan allows unrestricted disbursements.
If you aren't, the draft fails with `not_authorized`.

## Files

| Path | Contents |
|------|----------|
| `~/.hcb-disburse/config.json` | Base URL, client ID and secret (0600) |
| `~/.hcb-disburse/token.json` | Access and refresh token (0600) |
| `~/.hcb-disburse/drafts.sqlite` | Drafts and their history |

Environment overrides: `DISBURSE_HOME`, `DISBURSE_PORT` (default 4848),
`DISBURSE_LOGIN_PORT` (default 4747), `HCB_BASE_URL`, `HCB_CLIENT_ID`,
`HCB_CLIENT_SECRET`.

## Security notes

- The dashboard binds to `127.0.0.1` only. It rejects foreign `Host` and `Origin`
  headers, which blocks DNS rebinding and cross-site requests, and it requires a
  per-session token that is embedded in the page.
- The approval gate applies to **MCP tools**. If your agent also has unrestricted
  shell access on this machine, it could read `~/.hcb-disburse/token.json` and call
  HCB directly. Don't allow your agent to read that directory.
- To revoke access, go to HCB → Settings → Security → authorized apps, or run
  `rm ~/.hcb-disburse/token.json`.

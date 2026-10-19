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


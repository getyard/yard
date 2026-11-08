# yard

**Undo for everything your agents touch.**

Agents send email, change Stripe subscriptions and write to databases, and none of it comes with an undo. `yard` sits between your agent and its MCP servers. It journals every write, snapshots what's about to change, holds the actions that can't be taken back, and lets you reverse a run with one command.

```bash
npm i -g @getyard/cli
```

## Wrap an MCP server

Change one line in your agent's MCP config. The agent doesn't know yard is there.

```json
{
  "mcpServers": {
    "stripe": {
      "command": "yard",
      "args": ["proxy", "--name", "stripe", "--", "npx", "-y", "@stripe/mcp", "--tools=all"],
      "env": { "STRIPE_SECRET_KEY": "sk_..." }
    }
  }
}
```

## Undo a run

```bash
yard runs                     # every agent session
yard show run_8f2             # what it did, step by step
yard undo run_8f2 --from 3    # preview what will be reversed
yard undo run_8f2 --from 3 --yes
```

## What gets reversed

| Server | Action | How yard handles it |
|---|---|---|
| Stripe | create customer / product / price / payment link | Deleted or deactivated on undo |
| Stripe | create invoice | Draft deleted, finalized voided |
| Stripe | update subscription | Snapshot before, restored on undo |
| Stripe | refund, cancel subscription | Held 2 min; undo = never happens |
| Email | send / reply / forward | Held 60s; undo = never sent |
| Postgres | writes | Journaled (row-level undo is next) |
| Anything else | writes | Journaled and flagged |

Reads pass straight through untouched.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `YARD_HOME` | `~/.yard` | Where the journal lives |
| `YARD_RUN` | auto | Group several servers under one run id |
| `YARD_EMAIL_HOLD_MS` | `60000` | Email hold window |
| `YARD_HOLD_MS` | per action | Override every hold window |

## Develop

```bash
npm install
npm run build
./test/e2e.sh
```

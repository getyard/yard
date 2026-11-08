# yard

**Undo for everything your agents touch.**

Agents send email, change Stripe subscriptions and write to databases, and none of it comes with an undo. `yard` sits between your agent and its MCP servers. It journals every write, snapshots what's about to change, holds the actions that can't be taken back, and lets you reverse a run with one command.

```bash
npm i -g @getyard/cli
```

## Wrap a hosted MCP server (Stripe)

yard connects to the hosted server itself and passes your key along. In Claude Code:

```bash
claude mcp add stripe -e STRIPE_SECRET_KEY=sk_test_... -- yard proxy --name stripe --url https://mcp.stripe.com
```

Any other hosted server works the same way:

```bash
yard proxy --name myserver --url https://example.com/mcp --bearer-env MY_TOKEN
yard proxy --name myserver --url https://example.com/mcp --header "X-Api-Key: abc"
```

## Wrap a local MCP server

```bash
claude mcp add myserver -- yard proxy --name myserver -- npx -y some-mcp-server
```

## Undo a run

`yard undo` calls Stripe directly, so the key needs to be in your shell too:

```bash
export STRIPE_SECRET_KEY=sk_test_...
yard runs                     # every agent session
yard show run_8f2             # what it did, step by step
yard undo run_8f2 --from 3    # preview what will be reversed
yard undo run_8f2 --from 3 --yes
yard log                      # every tool call yard saw, reads included
```

## What gets reversed on Stripe

Stripe's MCP does writes through one generic tool, `stripe_api_write`. yard works from what it can see rather than from operation names:

| What the agent did | How yard reverses it |
|---|---|
| Created a customer, coupon, invoice item, webhook endpoint or test clock | Deleted |
| Created a product, price, payment link, promotion code or portal configuration | Archived / deactivated |
| Created an invoice | Draft deleted, open invoice voided |
| Created a checkout session | Expired |
| Created a subscription | Cancelled (a first payment it already collected is not refunded) |
| Updated any object | Snapshotted before the write; undo puts back exactly the fields the agent changed |
| Deleted, cancelled, voided, finalized, paid or sent something | **Held for 2 minutes**; undo means it never happens |
| Refunds, payouts, transfers, Treasury money moves | Recorded; Stripe already asks a human to confirm these in the Dashboard |

## Other servers

| Server | Action | How yard handles it |
|---|---|---|
| Email | send / reply / forward | Held 60s; undo = never sent |
| Postgres | writes | Recorded (row-level undo is next) |
| Anything else | anything that isn't a read | Recorded and flagged |

Reads pass straight through untouched.

## Good to know

- **Holds only release while the agent session is open.** If the session ends first, the held action never runs and the journal marks it `dropped`.
- **Stripe keys:** Stripe MCP stops accepting full-access secret keys and untagged restricted keys in December 2026. Use an agent API key (Agent badge in the Dashboard) or OAuth before then.
- **The journal stays on your machine** in `~/.yard`, and includes snapshots of the objects the agent changed.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `YARD_HOME` | `~/.yard` | Where the journal lives |
| `YARD_RUN` | auto | Group several servers under one run id |
| `YARD_EMAIL_HOLD_MS` | `60000` | Email hold window |
| `YARD_HOLD_MS` | per action | Override every hold window |
| `STRIPE_SECRET_KEY` / `STRIPE_AGENT_KEY` | | Key yard uses for Stripe snapshots and undo |

## Develop

```bash
npm install
npm run build
npm test
```

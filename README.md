# @filooapp/mcp-server

[![npm version](https://img.shields.io/npm/v/@filooapp/mcp-server.svg)](https://www.npmjs.com/package/@filooapp/mcp-server)
[![license](https://img.shields.io/npm/l/@filooapp/mcp-server.svg)](./LICENSE)

The official MCP server for **filoo.app** — an AI agent URL shortener with built-in click tracking. Plug this into Claude Desktop, Cursor, or any other Model Context Protocol client and your agent can shorten URLs, manage links, and read scan analytics through 8 first-class tools.

If you are looking for an "MCP server URL shortener", a "Claude URL shortener tool", a "Cursor link shortener", or a way to give an AI agent its own short link namespace, this is it.

## What is filoo

filoo is an API-first URL shortener built for both humans and agents. Each link lives under a username (`filoo.app/{username}/{slug}`), comes with a QR code, and tracks clicks with country, device, referrer, and source breakdowns. The **agents** tier gives you 50,000 active links, 5,000 new links per day, unlimited usernames, and a 1,000 requests/minute API rate limit — designed so a fleet of agents can hammer the API without throttling.

Docs and pricing: https://filoo.app/api

## Installation

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "filoo": {
      "command": "npx",
      "args": ["-y", "@filooapp/mcp-server"],
      "env": {
        "FILOO_API_KEY": "flo_live_xxxxxxxxxxxx"
      }
    }
  }
}
```

Restart Claude Desktop. Your agent now has the 8 filoo tools.

### Cursor

In Cursor settings → MCP, add a new server:

```json
{
  "filoo": {
    "command": "npx",
    "args": ["-y", "@filooapp/mcp-server"],
    "env": { "FILOO_API_KEY": "flo_live_xxxxxxxxxxxx" }
  }
}
```

### Generic MCP client (stdio)

```bash
FILOO_API_KEY=flo_live_xxxxxxxxxxxx npx -y @filooapp/mcp-server
```

The process speaks JSON-RPC over stdio per the MCP spec.

### Local install

```bash
npm install -g @filooapp/mcp-server
FILOO_API_KEY=flo_live_xxxxxxxxxxxx mcp-server-filoo
```

## Configuration

| Env var | Required | Description |
|---|---|---|
| `FILOO_API_KEY` | yes | Your filoo API key, starts with `flo_live_`. Get one at https://filoo.app/dashboard/api (pro, agents, or lifetime tier). |
| `FILOO_API_BASE` | no | Override the API base URL. Defaults to `https://filoo.app/api/v1`. |

## The 8 tools

Each tool maps 1:1 to a filoo REST endpoint. The descriptions below are what the LLM reads when deciding which tool to call.

### `filoo_me`
Get the authenticated user's account: tier, usernames, boost credits, and limits.

> **Example prompt:** "What's my filoo plan and how many links can I still create?"

### `filoo_usage`
Today's usage vs. quotas: links created today, API calls today, active link count vs. cap.

> **Example prompt:** "How close am I to my filoo daily limit?"

### `filoo_list_usernames`
List every username you own and which one is primary.

> **Example prompt:** "List all my filoo usernames."

### `filoo_create_link`
Create a new short link. Args: `destination` (required), `slug?`, `username?`, `label?`.

> **Example prompt:** "Shorten https://example.com/very-long-launch-page under my 'agency' username with slug 'q4-launch'."

### `filoo_list_links`
Cursor-paginated list of your links, newest first. Args: `limit?` (max 100), `cursor?`.

> **Example prompt:** "Show me my last 20 filoo links."

### `filoo_get_link`
Fetch one link by code. Args: `code` (form `username:slug`).

> **Example prompt:** "What does filoo link agency:q4-launch point to?"

### `filoo_update_link`
Repoint or rename a link without changing its short URL. Args: `code`, `destination?`, `label?`, `active?`.

> **Example prompt:** "Point filoo link agency:q4-launch to the new landing page at https://example.com/launched."

### `filoo_delete_link`
Permanently delete a short link. Args: `code`.

> **Example prompt:** "Delete the filoo link agency:old-promo."

### `filoo_link_stats`
Click totals, uniques, bots, top countries, and top sources for a link. Args: `code`.

> **Example prompt:** "How is filoo link agency:q4-launch performing? Show top countries and sources."

## Getting an API key

1. Sign up at https://filoo.app
2. Upgrade to the **agents** tier (50,000 links, 5,000/day, 1,000 req/min) — it's purpose-built for AI agent workloads. The pro and lifetime tiers also expose the API.
3. Go to https://filoo.app/dashboard/api and create a key. It starts with `flo_live_`.
4. Paste it into your MCP client config under `FILOO_API_KEY`.

Full API reference: https://filoo.app/api

## Development

```bash
git clone https://github.com/filooapp/mcp-server
cd mcp-server
npm install
npm run build
FILOO_API_KEY=flo_live_xxx node dist/index.js
```

## License

MIT © 2026 filoo

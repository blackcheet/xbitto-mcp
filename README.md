# Xbitto MCP

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent (Claude, Cursor, or any MCP client)
work in your [Xbitto](https://xbitto.com) creator account: create short links and paywall links, fill an
access code pool with hundreds of items at once, and upload galleries, videos and whole series of episodes
from your computer.

It runs on your own computer. Files go **straight from your computer to your own Bunny account**, using
upload addresses the Xbitto API signs. They never pass through Xbitto.

Full docs: [xbitto.com/docs](https://xbitto.com/docs).

## What You Need

- Node.js 20 or newer
- An Xbitto account with a verified email and at least one payout wallet
- An API key: in the Xbitto dashboard, **Settings → API Keys → Create Key**. Copy it right away; it is shown once.
- For the Vault: Bunny Stream (videos, series) and/or Bunny Storage (galleries) connected in **Settings**

## Install

There is no npm package yet; the server installs straight from this repository.

The dashboard's **AI Agents** page shows these steps with your new key already filled in.

**Claude Desktop**: Settings → Developer → Edit Config. **Cursor**: `~/.cursor/mcp.json`. If the file
already has `"mcpServers"`, put the `xbitto` entry inside it, then restart the app.

```json
{
  "mcpServers": {
    "xbitto": {
      "command": "npx",
      "args": ["-y", "github:blackcheet/xbitto-mcp"],
      "env": { "XBITTO_API_KEY": "xb_your_key" }
    }
  }
}
```

**Claude Code**

```sh
claude mcp add xbitto -e XBITTO_API_KEY=xb_your_key -- npx -y github:blackcheet/xbitto-mcp
```

**ChatGPT Desktop** uses the Codex settings: add this to `~/.codex/config.toml`
(Windows: `%USERPROFILE%\.codex\config.toml`) and restart ChatGPT.

```toml
[mcp_servers.xbitto]
command = "npx"
args = ["-y", "github:blackcheet/xbitto-mcp"]
startup_timeout_sec = 120

[mcp_servers.xbitto.env]
XBITTO_API_KEY = "xb_your_key"
```

**Grok Build**: add this to `~/.grok/config.toml`, then check it with `grok mcp doctor xbitto`.

```toml
[mcp_servers.xbitto]
command = "npx"
args = ["-y", "github:blackcheet/xbitto-mcp"]
env = { XBITTO_API_KEY = "xb_your_key" }
startup_timeout_sec = 120
```

The first start downloads the server from GitHub, so it can take a little longer. On Windows, if an app
can't start `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "github:blackcheet/xbitto-mcp"]`.

To stay on one version, add a tag: `github:blackcheet/xbitto-mcp#v0.1.0`.

## What It Can Do

| Tool | What it does |
|---|---|
| `whoami` | The account the key belongs to and its credit balance |
| `list_wallets` | Your payout wallets (paywalls use their ids) |
| `list_links`, `get_link` | Your links and their paywall settings |
| `create_link` | A short link to a URL (its destination can't be changed later) |
| `set_paywall` | Sell a link: price, title, description, cover, access code or a pool of items |
| `add_pool_items` | Add license keys, logins or invite links to a pool, from a list or a text file, 100 per request |
| `get_pool_stats` | How many pool items are left and used |
| `create_gallery` | Sell 1–20 pictures from a folder |
| `create_video` | Sell a video, with an optional preview clip |
| `create_series` | Sell up to 100 episodes for one price, first few free |
| `add_episodes` | Add episodes to the end of a series |
| `get_upload_job` | Follow an upload running in the background |
| `list_vault`, `get_vault_item` | Your Vault items and whether they are ready |
| `list_orders`, `get_order` | Your orders |
| `confirm_payment`, `reject_payment` | Decide a payment on hold (only when you say so) |

Example prompts:

- "Create a paywall link to https://example.com/course for 9 USDT and add the keys in `keys.txt` to its pool."
- "Upload the episodes in `D:\Drama\Night Train` as a series called Night Train, 3 USDT, first 2 free."

Uploads run in the background, so a long series doesn't block the agent: it starts the upload and checks
progress with `get_upload_job`. Uploads stop if the MCP server stops; what already arrived stays.

## What a Key Can't Do

An API key can't add or change payout wallets, connect Bunny, change the password, email or other account
settings, buy credits, pay promoters, run paid wallet checks, export or delete the account, or create
other keys. Do those in the dashboard. Remove a key any time under **Settings → API Keys**.

Keep the key secret: anyone who has it can create and change your links and Vault items.

## Network

The server connects directly to `api.xbitto.com` and to Bunny. It doesn't use the `HTTP_PROXY` setting. If
your network blocks or misroutes Bunny's upload address, use a system-wide VPN or proxy (TUN mode).

## Settings

| Variable | Default | |
|---|---|---|
| `XBITTO_API_KEY` | — | Required |
| `XBITTO_API_URL` | `https://api.xbitto.com` | Only for testing against another server |

## Development

```sh
npm install
npm run check   # typecheck, tests, and a check that dist/ is up to date
npm run build   # rebuild dist/index.js (committed, so a GitHub install needs no build)
```

## License

MIT

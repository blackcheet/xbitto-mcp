---
name: xbitto
description: Work in a creator's Xbitto account through the xbitto MCP tools - create short links and paywall links, fill access code pools in bulk, and upload Vault galleries, videos and series of episodes from local files. Use when the user mentions Xbitto, paywall links, access codes or license keys to sell, or uploading episodes, a short drama, videos or a picture set to sell.
---

# Xbitto

Xbitto turns a short link into a paid link: consumers pay USDT (TRON) or USDC (Solana) straight to the
creator's wallet, and get what was sold. The `xbitto` MCP tools act in the creator's account with their
API key.

## Words

- **Creator**: the account owner (the user). **Consumer**: whoever pays. **Promoter**: sells for a commission.
- **Gated link**: a link with a paywall. After paying, the consumer gets the destination and, optionally,
  an access code: one code for everyone (`codeMode: "same"`) or their own **items** from a pool
  (`codeMode: "unique"`), one per order or up to `maxPerOrder` (at most 50).
- **Vault**: content the creator sells from their own Bunny account: a gallery (1–20 pictures), a video
  (with an optional preview clip), or a series (up to 100 episodes, first few free).
- **Store** (My Store): one public page of the creator's paid links and Vault items, grouped by **tag**.
  Every item is off the store until switched on.

## How to Work

1. Start with `whoami`. `canCreate` says what the account can make right now and `missing` what the user
   has to fix in the dashboard first (verified email, a payout wallet, Bunny connected, links left today,
   credits above 0). Tell the user before creating anything that couldn't sell.
2. Ask for everything a create tool needs before calling it: a link's destination can never be changed, and
   every link counts against today's allowance even if deleted. A destination is a public http(s) address,
   not an IP, a local host or an Xbitto short link. Prices are decimal strings (`"5"`, `"4.99"`), in USDT/USDC,
   and each sale costs the Sales Fee shown by `whoami` in credits.
3. Leave `payoutWalletIds` out unless the user names wallets: the first usable wallet on each network is used.
4. **Selling items from a pool** (keys, accounts, invites):
   `create_link` → `set_paywall` with `codeMode: "unique"` (and a `codeLabel` such as "License Key") → `add_pool_items`.
   Pass a file path for long lists; the tool trims, removes repeats and sends 100 per request. A pool holds up to 1000 unused items.
   Ask whether one consumer may buy several at once: if so, pass `maxPerOrder` (2–50). The price is per item; the Sales Fee is
   charged once per order, on its total.
5. **Uploads** (`create_gallery`, `create_video`, `create_series`, `add_episodes`) return a `jobId` at once.
   Poll `get_upload_job` every 30 seconds or so and report progress; don't start the same upload twice.
   After uploading, Bunny encodes videos; `get_vault_item` shows when they are ready.
6. **Series**: a folder is taken in natural name order (EP2 before EP10). `freeCount` is at most half the
   episodes. It takes orders once at least `freeCount + 1` episodes (and at least 2) are ready.
7. `set_paywall` replaces the paywall settings: to change one field, read the link with `get_link` first and pass the rest back.
   The access code, unused pool items and the items an order received are never shown to an API key; leave `accessCode`
   out to keep the saved one.
8. `confirm_payment` and `reject_payment` can't be undone. Only call them after the user has decided.
9. **Store**: `set_tag` tags an item (up to 24 characters, not a web address; `""` removes it). `set_store_visibility`
   with `show: true` makes the item's title, price, picture and tag public on the store, so only do it when the user
   asks. `get_store` is `null` until the creator opens the store in the dashboard; opening, closing, naming it and changing its link are dashboard only.

## What the Key Can't Do

Payout wallets, Bunny connections, account settings, opening, closing or renaming the store, buying credits,
paying promoters, paid wallet checks, data export and deletion are dashboard only. Say so and point the user to https://app.xbitto.com.

## Content

Xbitto refuses unsafe destinations and words without saying why (`target_unsafe`). Don't try to get around
it by rewording. Covers and posters are third-party https image URLs; Xbitto stores only the address.

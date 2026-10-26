import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Api } from "./api.js";
import { registerCodesTools } from "./tools/codes.js";
import { registerContentTools } from "./tools/content.js";
import { registerLinkTools } from "./tools/links.js";
import { registerOrderTools } from "./tools/orders.js";

declare const VERSION: string;

export function createServer(api: Api) {
  const server = new McpServer(
    { name: "xbitto", version: typeof VERSION === "string" ? VERSION : "dev" },
    {
      instructions:
        "Tools for a creator's Xbitto account: short links, Gated links, Codes (keys, accounts and the like, each consumer getting their own), and Content: galleries, videos and dramas. " +
        "Before creating anything, call whoami: it says what the account can create now and what the user must fix in the dashboard first. " +
        "Ask the user for every detail a create tool needs (each tool's description lists them) before calling it: a link's destination can never be changed. " +
        "Prices are decimal strings in USDT/USDC. Uploads run in the background: start one, then follow it with get_upload_job. " +
        "When Xbitto refuses content as target_unsafe it gives no reason; don't try to get around it by rewording. " +
        "Payout wallets, Bunny connections and account settings can only be changed in the Xbitto dashboard.",
    },
  );
  registerLinkTools(server, api);
  registerCodesTools(server, api);
  registerContentTools(server, api);
  registerOrderTools(server, api);
  return server;
}

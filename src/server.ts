import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Api } from "./api.js";
import { registerLinkTools } from "./tools/links.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerVaultTools } from "./tools/vault.js";

declare const VERSION: string;

export function createServer(api: Api) {
  const server = new McpServer(
    { name: "xbitto", version: typeof VERSION === "string" ? VERSION : "dev" },
    {
      instructions:
        "Tools for a creator's Xbitto account: short links, Gated links with access code pools, and Vault galleries, videos and series. " +
        "Prices are decimal strings in USDT/USDC. Uploads run in the background: start one, then follow it with get_upload_job. " +
        "Payout wallets, Bunny connections and account settings can only be changed in the Xbitto dashboard.",
    },
  );
  registerLinkTools(server, api);
  registerVaultTools(server, api);
  registerOrderTools(server, api);
  return server;
}

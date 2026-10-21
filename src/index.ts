#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { apiFromEnv } from "./api.js";
import { createServer } from "./server.js";

// The Xbitto MCP server, run on the creator's own computer over stdio. Signed in with the API key in
// XBITTO_API_KEY; files are read from this computer and sent straight to the creator's Bunny account.

async function main() {
  await createServer(apiFromEnv()).connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout is the protocol; anything for a person goes to stderr.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Api } from "../api.js";

// Shared pieces of the tools: how a result is returned, and the paywall fields every paid item takes.

export const ok = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
export const fail = (error: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
});

// Every tool's handler goes through this, so an API refusal reaches the agent as a sentence, not a crash.
export const handle =
  <A>(run: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await run(args));
    } catch (error) {
      return fail(error);
    }
  };

export const code = z.string().regex(/^[0-9A-Za-z]{1,32}$/, "a short code, e.g. aB3xY9").describe("The link's short code (the part after the domain).");

// The paywall fields, as the dashboard's paywall form sends them. Saving replaces the paywall's settings:
// a field left out takes its default, not its earlier value.
export const paywallFields = {
  title: z.string().min(1).max(120).describe("What the consumer sees as the title."),
  description: z
    .string()
    .max(1000)
    .optional()
    .describe("Shown before payment. Supports **bold**, _italic_ and lists with '- ' or '1. '. Links show as plain text."),
  price: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/)
    .describe('Price in USDT/USDC as a decimal string, e.g. "5" or "4.99": above 0, at most 1000000. The Sales Fee (see whoami) comes out of credits per sale.'),
  payoutWalletIds: z
    .array(z.string())
    .optional()
    .describe("Wallet ids from list_wallets, at most one per network. Left out: the first usable wallet on each network."),
  verifyPayer: z
    .boolean()
    .optional()
    .describe("Screen the consumer's wallet before showing the payment address (each real check costs credits). Only when whoami shows walletScreening."),
};

type PaywallInput = { title: string; description?: string; price: string; payoutWalletIds?: string[]; verifyPayer?: boolean };

type Wallet = { id: string; chain: string; asset: string; blacklistedAt: number | null };

// The request body for a paywall, with the wallets filled in when the agent named none.
export async function paywallBody(api: Api, input: PaywallInput, extra: Record<string, unknown> = {}) {
  const payoutAddressIds = input.payoutWalletIds?.length ? input.payoutWalletIds : await defaultWallets(api);
  if (payoutAddressIds.length === 0) throw new Error("The account has no payout wallet. Add one in the Xbitto dashboard under Wallet.");
  return {
    title: input.title,
    description: input.description ?? "",
    price: input.price,
    payoutAddressIds,
    ...(input.verifyPayer === undefined ? {} : { verifyPayer: input.verifyPayer }),
    ...extra,
  };
}

async function defaultWallets(api: Api): Promise<string[]> {
  const { addresses } = await api.get<{ addresses: Wallet[] }>("/api/payout-addresses");
  const picked = new Map<string, string>();
  for (const wallet of addresses) {
    const rail = `${wallet.chain}:${wallet.asset}`;
    if (wallet.blacklistedAt === null && !picked.has(rail)) picked.set(rail, wallet.id);
  }
  return [...picked.values()];
}

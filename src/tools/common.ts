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

// A list's filters as a query string, the empty ones left out.
export const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
};

export const code = z.string().regex(/^[0-9A-Za-z]{1,32}$/, "a short code, e.g. aB3xY9").describe("The link's short code (the part after the domain).");

// The paywall fields, as the dashboard's paywall form sends them. Saving replaces the paywall's settings:
// a field left out takes its default, not its earlier value.
export const paywallFields = {
  title: z.string().min(1).max(120).describe("What the consumer sees as the title."),
  description: z
    .string()
    .max(2000)
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
  translations: z
    .partialRecord(
      z.enum(["en", "zh", "tr", "vi", "th", "es", "pt"]),
      z.strictObject({ title: z.string().max(120).optional(), description: z.string().max(2000).optional() }),
    )
    .optional()
    .describe(
      "The title and description again in other languages, e.g. { es: { title, description } }. Consumers see their own language; any other language, " +
        "and a field left empty, shows the title and description above. Share previews always use those. Left out: kept as they are; {} removes them all.",
    ),
};

type Translations = Partial<Record<string, { title?: string; description?: string }>>;
type PaywallInput = { title: string; description?: string; price: string; payoutWalletIds?: string[]; verifyPayer?: boolean; translations?: Translations };

type Wallet = { id: string; chain: string; asset: string; blacklistedAt: number | null };

// A cover address: an https image URL, or "" to take the cover away.
export const coverField = z
  .union([z.string().url().max(2048), z.literal("")])
  .optional()
  .describe('A third-party https image URL for the cover. Xbitto stores only the address. "" removes the cover; left out keeps the saved one.');

// What a paywall holds now, as the API returns it to its owner (routes/paywalls.ts ownerView).
export type SavedPaywall = {
  title: string;
  description: string;
  priceMicro: number;
  payoutAddressIds: string[];
  coverUrl: string | null;
  coverBlur: number;
  codeLabel: string | null;
  maxPerOrder: number;
};

export async function getSavedPaywall(api: Api, code: string): Promise<SavedPaywall | null> {
  const { paywall } = await api.get<{ paywall: SavedPaywall | null }>(`/api/links/${code}/paywall`);
  return paywall;
}

// Micro-USDT back into the decimal string the API takes: 4990000 is "4.99".
export function priceText(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const fraction = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

// Saving replaces every setting a paywall has, so a save that changes some fields starts from the saved
// ones: whatever the agent leaves out keeps its saved value (the access code and the Codes note are kept
// by the API itself when they are left out). Title and price are only needed for a paywall with none yet.
export function keepSaved<A extends { title?: string; price?: string; description?: string; payoutWalletIds?: string[]; coverUrl?: string }>(
  args: A,
  saved: SavedPaywall | null,
) {
  const title = args.title ?? saved?.title;
  const price = args.price ?? (saved ? priceText(saved.priceMicro) : undefined);
  if (!title || !price) throw new Error("This link has no paywall yet, so a title and a price are needed to set one.");
  const payoutWalletIds = args.payoutWalletIds?.length ? args.payoutWalletIds : saved?.payoutAddressIds;
  return {
    ...args,
    title,
    price,
    description: args.description ?? saved?.description ?? "",
    payoutWalletIds: payoutWalletIds?.length ? payoutWalletIds : undefined,
    coverUrl: args.coverUrl === undefined ? (saved?.coverUrl ?? undefined) : args.coverUrl || undefined,
  };
}

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
    ...(input.translations === undefined ? {} : { translations: input.translations }),
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

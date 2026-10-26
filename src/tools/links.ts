import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { code, handle, paywallBody, paywallFields, query } from "./common.js";

// The account, links, Gated links' paywalls, tags and the store.

// A tag, as long as the API takes it.
export const TAG_MAX_LENGTH = 24;

type Me = { user: { email: string; emailVerified: boolean; frozen: boolean } };
type Wallets = { addresses: { chain: string; asset: string; blacklistedAt: number | null }[]; rails: { chain: string; asset: string }[] };
type Quota = { quota: { used: number; limit: number } };
type PayerPolicy = { fees: { baseMicro: number; percentBasisPoints: number }; scoringAvailable: boolean };

const NETWORK_NAMES: Record<string, string> = { solana: "Solana", tron: "TRON" };
const amount = (micro: number) => String(micro / 1_000_000);

// What the account can make right now, read from the same answers the dashboard reads, so an agent can
// ask the user for what is missing before it creates a link that counts against today's allowance.
export async function readiness(api: Api) {
  const [me, credits, quota, wallets, stream, storage, paywalls, policy] = await Promise.all([
    api.get<Me>("/api/auth/me"),
    api.get<{ balanceMicro: number }>("/api/credits/summary"),
    api.get<Quota>("/api/links/quota"),
    api.get<Wallets>("/api/payout-addresses"),
    api.get<{ connection: unknown }>("/api/vault/connection"),
    api.get<{ storage: unknown }>("/api/vault/storage"),
    api.get<{ open: boolean }>("/api/account/paywalls"),
    api.get<PayerPolicy>("/api/account/payer-policy"),
  ]);
  const { user } = me;
  const usable = (rail: { chain: string; asset: string }) =>
    wallets.addresses.some((wallet) => wallet.chain === rail.chain && wallet.asset === rail.asset && wallet.blacklistedAt === null);
  const networks = wallets.rails.map((rail) => ({ network: NETWORK_NAMES[rail.chain] ?? rail.chain, coin: rail.asset, wallet: usable(rail) }));
  const linksLeft = Math.max(0, quota.quota.limit - quota.quota.used);

  const missing: string[] = [];
  if (!user.emailVerified) missing.push("The email isn't verified: verify it in the Xbitto dashboard.");
  if (user.frozen) missing.push("The account is restricted by consumer complaints: nothing new can be created. The user can appeal under Notification in the dashboard.");
  if (linksLeft === 0) missing.push("Today's link allowance is used up (it resets at 00:00 UTC; deleted links count too).");
  if (!paywalls.open) missing.push("Paid content is paused on Xbitto for now: only free links can be created.");
  if (!networks.some((rail) => rail.wallet)) missing.push("No usable payout wallet: add one in the dashboard under Wallet before selling anything.");
  if (stream.connection === null) missing.push("Bunny Stream isn't connected (needed for videos and dramas): connect it in the dashboard under Settings.");
  if (storage.storage === null) missing.push("Bunny Storage isn't connected (needed for galleries): connect it in the dashboard under Settings.");
  if (credits.balanceMicro <= 0) missing.push("The credit balance is not above 0, so paid links take no orders until credits are bought in the dashboard under Usage.");

  const canCreate = user.emailVerified && !user.frozen && linksLeft > 0;
  const canSell = canCreate && paywalls.open && networks.some((rail) => rail.wallet);
  return {
    account: { email: user.email, emailVerified: user.emailVerified, restricted: user.frozen },
    linksToday: { used: quota.quota.used, limit: quota.quota.limit, left: linksLeft },
    credits: amount(credits.balanceMicro),
    // Taken from the creator's credits each time a consumer's payment is delivered.
    salesFee: `${amount(policy.fees.baseMicro)} + ${policy.fees.percentBasisPoints / 100}% of the price`,
    payoutNetworks: networks,
    bunny: { stream: stream.connection !== null, storage: storage.storage !== null },
    walletScreening: policy.scoringAvailable,
    canCreate: {
      freeLink: canCreate,
      gatedLink: canSell,
      codes: canSell,
      gallery: canSell && storage.storage !== null,
      video: canSell && stream.connection !== null,
      drama: canSell && stream.connection !== null,
    },
    missing,
  };
}

export function registerLinkTools(server: McpServer, api: Api) {
  server.registerTool(
    "whoami",
    {
      title: "Who Am I",
      description:
        "The Xbitto account this API key belongs to and what it can create right now: links left today, payout wallets, " +
        "Bunny connections, credits and the Sales Fee. Call it before creating anything; `missing` says what the user must fix in the dashboard first.",
      annotations: { readOnlyHint: true },
    },
    handle(() => readiness(api)),
  );

  server.registerTool(
    "list_wallets",
    {
      title: "List Payout Wallets",
      description: "The account's payout wallets. Paywalls take their ids (one per network). Wallets can only be added in the dashboard.",
      annotations: { readOnlyHint: true },
    },
    handle(() => api.get("/api/payout-addresses")),
  );

  server.registerTool(
    "list_links",
    {
      title: "List Links",
      description: "The account's links, newest first, ten a page. Pass nextCursor back as cursor for the next page.",
      inputSchema: {
        q: z.string().max(100).optional().describe("Search the short code, destination and paid title."),
        kind: z.enum(["redirect", "paywall"]).optional(),
        status: z.enum(["active", "disabled", "blocked"]).optional(),
        tag: z.string().optional().describe("Only links with this tag."),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args: { q?: string; kind?: string; status?: string; tag?: string; cursor?: string }) => api.get(`/api/links${query(args)}`)),
  );

  server.registerTool(
    "get_link",
    { title: "Get Link", description: "One link with its paywall settings.", inputSchema: { code }, annotations: { readOnlyHint: true } },
    handle(({ code }: { code: string }) => api.get(`/api/links/${code}`)),
  );

  server.registerTool(
    "set_tag",
    {
      title: "Set Tag",
      description:
        "Tag a link, Codes item or Content item, or remove its tag with an empty one. A tag groups items in the dashboard and on the creator's " +
        "store, where consumers see it.",
      inputSchema: {
        code,
        tag: z.string().max(TAG_MAX_LENGTH).describe(`The tag, up to ${TAG_MAX_LENGTH} characters, not a web address; "" for none.`),
      },
    },
    handle(({ code, tag }: { code: string; tag: string }) => api.put(`/api/links/${code}/tag`, { tag })),
  );

  server.registerTool(
    "get_store",
    {
      title: "Get Store",
      description:
        "The creator's store (My Store): its public link, name and whether it is open, and its tags (by name) with how many items each shows. " +
        "Consumers browse it by type (link, codes, gallery, video, drama) and then by tag. " +
        "Null when the creator has never opened it; opening, closing, naming it and changing its link are done in the dashboard.",
      annotations: { readOnlyHint: true },
    },
    handle(async () => {
      const [{ store }, { tags }] = await Promise.all([api.get<{ store: unknown }>("/api/store"), api.get<{ tags: unknown[] }>("/api/store/tags")]);
      return { store, tags };
    }),
  );

  server.registerTool(
    "set_store_visibility",
    {
      title: "Show in Store",
      description:
        "Show a paid link, Codes item or Content item on the creator's store, or take it off. Every item is off until switched on. Showing one makes its " +
        "title, price, picture and tag public to anyone with the store link, so confirm with the user first. Free links can't be shown.",
      inputSchema: { code, show: z.boolean().describe("true to show it on the store, false to take it off.") },
    },
    handle(({ code, show }: { code: string; show: boolean }) => api.put(`/api/links/${code}/store`, { on: show })),
  );

  server.registerTool(
    "create_link",
    {
      title: "Create Link",
      description:
        "Create a short link to a destination URL. Its destination can never be changed afterwards, and every link counts against " +
        "today's allowance even if deleted, so confirm the exact URL with the user first. To sell it, call set_paywall on it next: " +
        "check with whoami that a Gated link can be made before creating the link.",
      inputSchema: {
        targetUrl: z
          .string()
          .url()
          .max(2048)
          .describe("The destination: a public http or https address, up to 2048 characters. Not an IP address, a local host, a URL with a username or password, or an Xbitto short link."),
      },
    },
    handle(({ targetUrl }: { targetUrl: string }) => api.post("/api/links", { targetUrl })),
  );

  server.registerTool(
    "set_paywall",
    {
      title: "Set Paywall",
      description:
        "Turn a link into a Gated link (or update its paywall): consumers pay to get the destination and, optionally, an access code " +
        "such as an extraction code or a password, the same for everyone. Ask the user for the title and price, and whether there is a code, before calling. " +
        "Replaces the paywall's settings, so pass every field you want kept. The access code is never shown to an API key; leave accessCode out to keep the one saved. " +
        "To sell accounts, keys or other codes each consumer gets their own of, use create_codes instead.",
      inputSchema: {
        code,
        ...paywallFields,
        coverUrl: z.string().url().optional().describe("A third-party https image URL for the cover. Xbitto stores only the address."),
        blurCover: z.boolean().optional().describe("Blur the cover on the landing page."),
        accessCode: z.string().max(500).optional().describe('The code every consumer gets with the link; "" for none. Left out: the one saved is kept.'),
      },
    },
    handle(
      async (args: {
        code: string;
        title: string;
        description?: string;
        price: string;
        payoutWalletIds?: string[];
        verifyPayer?: boolean;
        coverUrl?: string;
        blurCover?: boolean;
        accessCode?: string;
      }) => {
        const body = await paywallBody(api, args, {
          coverUrl: args.coverUrl ?? null,
          coverBlur: args.blurCover ?? false,
          ...(args.accessCode === undefined ? {} : { accessCode: args.accessCode }),
        });
        return api.post(`/api/links/${args.code}/paywall`, body);
      },
    ),
  );
}

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { readItemLines } from "../files.js";
import { code, handle, paywallBody, paywallFields } from "./common.js";

// The account, links, paywalls and the access code pool of a Gated link.

// The API takes this many pool items in one request, each at most this long.
export const POOL_ADD_MAX = 100;
export const POOL_ITEM_MAX_LENGTH = 200;
// A tag, as long as the API takes it.
export const TAG_MAX_LENGTH = 24;

// Every line of this file becomes something a consumer can buy, so only a plain list is read: a .txt or
// .csv file of reasonable size, never whatever file an instruction hidden in a web page names.
const ITEMS_FILE_MAX_BYTES = 2 * 1024 * 1024;

async function readItemsFile(path: string): Promise<string> {
  if (![".txt", ".csv"].includes(extname(path).toLowerCase())) throw new Error("The items file must be a .txt or .csv file.");
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`Not a file: ${path}`);
  if (info.size > ITEMS_FILE_MAX_BYTES) throw new Error("The items file is larger than 2 MB.");
  return readFile(path, "utf8");
}

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
};

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
  if (stream.connection === null) missing.push("Bunny Stream isn't connected (needed for videos and series): connect it in the dashboard under Settings.");
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
      gallery: canSell && storage.storage !== null,
      video: canSell && stream.connection !== null,
      series: canSell && stream.connection !== null,
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
        "Tag a link or Vault item, or remove its tag with an empty one. A tag groups items in the dashboard and on the creator's " +
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
        "Consumers browse it by type (link, gallery, video, drama) and then by tag. " +
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
        "Show a paid link or Vault item on the creator's store, or take it off. Every item is off until switched on. Showing one makes its " +
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
        "Turn a link into a Gated link (or update its paywall): consumers pay to get the destination and, optionally, an access code. " +
        "Ask the user for the title and price, and whether there is a code to give (one for everyone, or items from a pool) before calling. " +
        "Replaces the paywall's settings, so pass every field you want kept. The access code is never shown to an API key; leave accessCode out to keep the one saved. " +
        "For items from a pool use codeMode 'unique' and fill the pool with add_pool_items; maxPerOrder lets one consumer buy several in one order (ask the user).",
      inputSchema: {
        code,
        ...paywallFields,
        coverUrl: z.string().url().optional().describe("A third-party https image URL for the cover. Xbitto stores only the address."),
        blurCover: z.boolean().optional().describe("Blur the cover on the landing page."),
        codeMode: z.enum(["same", "unique"]).optional().describe("'same': one code for every consumer. 'unique': each order takes its own items from the pool."),
        maxPerOrder: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "In 'unique' mode: how many items one order may buy (1–50). The landing page then asks how many; the price is per item and the Sales Fee is charged once per order, on its total. Left out: 1, one item per order.",
          ),
        accessCode: z.string().max(500).optional().describe("The code every consumer gets, in 'same' mode. Left out: none."),
        codeLabel: z.string().max(40).optional().describe('What the consumer page calls the code, e.g. "License Key".'),
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
        codeMode?: "same" | "unique";
        maxPerOrder?: number;
        accessCode?: string;
        codeLabel?: string;
      }) => {
        const body = await paywallBody(api, args, {
          coverUrl: args.coverUrl ?? null,
          coverBlur: args.blurCover ?? false,
          codeMode: args.codeMode ?? "same",
          maxPerOrder: args.maxPerOrder ?? 1,
          codeLabel: args.codeLabel ?? "",
          ...(args.accessCode === undefined ? {} : { accessCode: args.accessCode }),
        });
        return api.post(`/api/links/${args.code}/paywall`, body);
      },
    ),
  );

  server.registerTool(
    "add_pool_items",
    {
      title: "Add Pool Items",
      description:
        "Add items (license keys, account logins, invite links…) to a Gated link's pool; each delivered order takes one. " +
        "Give `items` or `file` (a text file, one item per line). Blank lines and repeats are dropped, items over 200 characters are skipped and counted, " +
        "items already in the pool are counted, not added twice. Sent 100 at a time; a pool holds up to 1000 unused items.",
      inputSchema: {
        code,
        items: z.array(z.string()).optional(),
        file: z.string().optional().describe("Path to a .txt or .csv file the user named, one item per line (at most 2 MB)."),
      },
    },
    handle(async ({ code, items, file }: { code: string; items?: string[]; file?: string }) => {
      if ((items === undefined) === (file === undefined)) throw new Error("Give either items or file.");
      const text = file !== undefined ? await readItemsFile(file) : items!.join("\n");
      const lines = readItemLines(text, POOL_ITEM_MAX_LENGTH);
      let added = 0;
      let alreadyThere = 0;
      let given = 0;
      let stats: unknown = null;
      for (let start = 0; start < lines.items.length; start += POOL_ADD_MAX) {
        const part = lines.items.slice(start, start + POOL_ADD_MAX);
        try {
          const answer = await api.post<{ added: number; duplicates: number; served: number; stats: unknown }>(`/api/links/${code}/access-codes`, { codes: part });
          added += answer.added;
          alreadyThere += answer.duplicates;
          given += answer.served;
          stats = answer.stats;
        } catch (error) {
          // What went in stays in; say how far it got.
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`${reason} Added ${added} of ${lines.items.length} before stopping.`);
        }
      }
      return {
        added,
        alreadyInPool: alreadyThere,
        tooLong: lines.tooLong,
        // Orders that had paid while the pool was empty receive the new items first.
        givenToWaitingOrders: given,
        pool: stats,
      };
    }),
  );

  server.registerTool(
    "get_pool_stats",
    {
      title: "Get Pool Stats",
      description: "How many items a Gated link's pool has left and how many were given to orders.",
      inputSchema: { code },
      annotations: { readOnlyHint: true },
    },
    handle(({ code }: { code: string }) => api.get(`/api/links/${code}/access-codes/stats`)),
  );
}

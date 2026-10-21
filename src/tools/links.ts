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

export function registerLinkTools(server: McpServer, api: Api) {
  server.registerTool(
    "whoami",
    {
      title: "Who Am I",
      description: "The Xbitto account this API key belongs to, and its credit balance.",
      annotations: { readOnlyHint: true },
    },
    handle(async () => {
      const [me, credits] = await Promise.all([api.get<{ user: unknown }>("/api/auth/me"), api.get<unknown>("/api/credits/summary")]);
      return { ...me, credits };
    }),
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
        tag: z.string().optional(),
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
    "create_link",
    {
      title: "Create Link",
      description:
        "Create a short link to a destination URL. Its destination can never be changed afterwards. To sell it, call set_paywall on it next.",
      inputSchema: { targetUrl: z.string().url().describe("The destination, http or https.") },
    },
    handle(({ targetUrl }: { targetUrl: string }) => api.post("/api/links", { targetUrl })),
  );

  server.registerTool(
    "set_paywall",
    {
      title: "Set Paywall",
      description:
        "Turn a link into a Gated link (or update its paywall): consumers pay to get the destination and, optionally, an access code. " +
        "Replaces the paywall's settings, so pass every field you want kept. For one code per order use codeMode 'unique' and fill the pool with add_pool_items.",
      inputSchema: {
        code,
        ...paywallFields,
        coverUrl: z.string().url().optional().describe("A third-party https image URL for the cover. Xbitto stores only the address."),
        blurCover: z.boolean().optional().describe("Blur the cover on the landing page."),
        codeMode: z.enum(["same", "unique"]).optional().describe("'same': one code for every consumer. 'unique': each order takes one item from the pool."),
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
        accessCode?: string;
        codeLabel?: string;
      }) => {
        const body = await paywallBody(api, args, {
          coverUrl: args.coverUrl ?? null,
          coverBlur: args.blurCover ?? false,
          codeMode: args.codeMode ?? "same",
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

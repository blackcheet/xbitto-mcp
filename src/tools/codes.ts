import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { readCodeLines } from "../files.js";
import { code, handle, paywallBody, paywallFields, query } from "./common.js";

// Codes: accounts, license keys, proxies, gift cards and the like, sold one or several to an order. Each
// consumer gets codes of their own from the item's stock, which the creator fills.

// The API takes this many codes in one request, each one line of at most this many characters. One call
// of a tool takes at most CODES_CALL_MAX, as one Add in the dashboard does; an account holds at most
// 10,000 unsold codes across all its items.
export const CODES_PER_REQUEST = 100;
export const CODE_MAX_LENGTH = 500;
export const CODES_CALL_MAX = 1000;

// Every line of this file becomes something a consumer can buy, so only a plain list is read: a .txt or
// .csv file of reasonable size, never whatever file an instruction hidden in a web page names.
const CODES_FILE_MAX_BYTES = 2 * 1024 * 1024;

async function readCodesFile(path: string): Promise<string> {
  if (![".txt", ".csv"].includes(extname(path).toLowerCase())) throw new Error("The codes file must be a .txt or .csv file.");
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`Not a file: ${path}`);
  if (info.size > CODES_FILE_MAX_BYTES) throw new Error("The codes file is larger than 2 MB.");
  return readFile(path, "utf8");
}

// The codes a tool was given, as a list or as a file, read a line a code.
async function readCodes({ codes, file }: { codes?: string[]; file?: string }) {
  if ((codes === undefined) === (file === undefined)) throw new Error("Give either codes or file.");
  const lines = readCodeLines(file !== undefined ? await readCodesFile(file) : codes!.join("\n"), CODE_MAX_LENGTH);
  if (lines.codes.length === 0) throw new Error(`No codes to add: every line was empty${lines.tooLong ? ` or over ${CODE_MAX_LENGTH} characters` : ""}.`);
  if (lines.codes.length > CODES_CALL_MAX) throw new Error(`At most ${CODES_CALL_MAX} codes in one call. Split the list.`);
  return lines;
}

type Added = { added: number; duplicates: number; served: number; stats: unknown };

// Sends codes to an item's stock CODES_PER_REQUEST at a time, in order. What went in before a refusal
// stays in stock; the error says how far it got.
async function sendCodes(api: Api, item: string, codes: string[], sentBefore = 0, total = codes.length) {
  const sum = { added: 0, duplicates: 0, served: 0, stats: null as unknown };
  for (let start = 0; start < codes.length; start += CODES_PER_REQUEST) {
    try {
      const answer = await api.post<Added>(`/api/codes/${item}/stock`, { codes: codes.slice(start, start + CODES_PER_REQUEST) });
      sum.added += answer.added;
      sum.duplicates += answer.duplicates;
      sum.served += answer.served;
      sum.stats = answer.stats;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason} Added ${sentBefore + sum.added} of ${total} codes to ${item} before stopping; add the rest with add_codes.`);
    }
  }
  return sum;
}

const codesInput = {
  codes: z.array(z.string()).optional().describe("The codes, one per entry. A login is one code, written on one line, e.g. user:password."),
  file: z.string().optional().describe("Path to a .txt or .csv file the user named, one code per line (at most 2 MB)."),
};

const itemFields = {
  ...paywallFields,
  coverUrl: z.string().url().optional().describe("A third-party https image URL for the cover. Xbitto stores only the address."),
  blurCover: z.boolean().optional().describe("Blur the cover on the landing page."),
  codeLabel: z.string().max(40).optional().describe('What the order page calls the codes, e.g. "License Key". Left out: "Your Code".'),
  maxPerOrder: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("How many codes one order may buy (1–50). Above 1 the landing page asks how many; the price is per code. Left out: 1."),
  note: z
    .string()
    .max(2000)
    .optional()
    .describe("Instructions shown with the codes after payment, e.g. login steps. Plain text, line breaks kept. Never shown to an API key."),
};

type ItemArgs = {
  title: string;
  description?: string;
  price: string;
  payoutWalletIds?: string[];
  verifyPayer?: boolean;
  coverUrl?: string;
  blurCover?: boolean;
  codeLabel?: string;
  maxPerOrder?: number;
  note?: string;
};

// The item's paywall settings, as the dashboard's form sends them.
const itemBody = (api: Api, args: ItemArgs) =>
  paywallBody(api, args, {
    coverUrl: args.coverUrl ?? null,
    coverBlur: args.blurCover ?? false,
    codeLabel: args.codeLabel ?? "",
    maxPerOrder: args.maxPerOrder ?? 1,
    ...(args.note === undefined ? {} : { note: args.note }),
  });

export function registerCodesTools(server: McpServer, api: Api) {
  server.registerTool(
    "list_codes",
    {
      title: "List Codes Items",
      description: "The account's Codes items, newest first, ten a page, each with its stock counted. Pass nextCursor back as cursor for the next page.",
      inputSchema: {
        q: z.string().max(100).optional().describe("Search the short code and title."),
        status: z.enum(["active", "disabled", "blocked"]).optional(),
        tag: z.string().optional().describe("Only items with this tag."),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args: { q?: string; status?: string; tag?: string; cursor?: string }) => api.get(`/api/codes${query(args)}`)),
  );

  server.registerTool(
    "get_codes",
    {
      title: "Get Codes Item",
      description:
        "One Codes item: its settings, its redeem link and its stock — `left` unsold, `used` given to orders, `waiting` owed to orders " +
        "that paid while it was short (codes added next go to them first). The codes themselves and the note are never shown to an API key.",
      inputSchema: { code },
      annotations: { readOnlyHint: true },
    },
    handle(({ code }: { code: string }) => api.get(`/api/codes/${code}`)),
  );

  server.registerTool(
    "create_codes",
    {
      title: "Create Codes Item",
      description:
        "Sell codes — accounts, license keys, proxies, gift cards — each consumer getting their own from the item's stock. " +
        "It is created with its codes: give `codes` or `file`, one code per line (blank lines and repeats dropped, lines over 500 characters skipped and counted), up to 1000 in one call. " +
        "Ask the user for the title, price, the codes and whether there is a redeem link before calling: the redeem link can never be changed, " +
        "and every item counts against today's link allowance even if deleted. Check with whoami that it can be made first.",
      inputSchema: {
        ...itemFields,
        ...codesInput,
        redeemUrl: z
          .string()
          .url()
          .max(2048)
          .optional()
          .describe("Where the codes are used, e.g. a redeem page: the order page shows a button to it. Can't be changed later. Left out: none."),
      },
    },
    handle(async (args: ItemArgs & { codes?: string[]; file?: string; redeemUrl?: string }) => {
      const lines = await readCodes(args);
      const first = lines.codes.slice(0, CODES_PER_REQUEST);
      const body = await itemBody(api, args);
      const { code } = await api.post<{ code: string }>("/api/codes", { ...body, codes: first, ...(args.redeemUrl ? { redeemUrl: args.redeemUrl } : {}) });
      const rest = await sendCodes(api, code, lines.codes.slice(CODES_PER_REQUEST), first.length, lines.codes.length);
      return { code, added: first.length + rest.added, alreadyInStock: rest.duplicates, tooLong: lines.tooLong };
    }),
  );

  server.registerTool(
    "update_codes",
    {
      title: "Update Codes Item",
      description:
        "Change a Codes item's title, price, description, cover, label, Max per Order or note. Replaces its settings, so pass every field you want kept; " +
        "leave `note` out to keep the saved one (an API key never sees it). The redeem link can't be changed. Price changes apply to new orders only.",
      inputSchema: { code, ...itemFields },
    },
    handle(async (args: ItemArgs & { code: string }) => api.post(`/api/links/${args.code}/paywall`, await itemBody(api, args))),
  );

  server.registerTool(
    "add_codes",
    {
      title: "Add Codes",
      description:
        "Add codes to a Codes item's stock: give `codes` or `file`, one code per line, up to 1000 in one call. Blank lines and repeats are dropped, " +
        "lines over 500 characters are skipped and counted, codes already in stock are counted, not added twice. " +
        "Orders that paid while the item was short get the new codes first. An account holds up to 10,000 unsold codes across its items.",
      inputSchema: { code, ...codesInput },
    },
    handle(async (args: { code: string; codes?: string[]; file?: string }) => {
      const lines = await readCodes(args);
      const sum = await sendCodes(api, args.code, lines.codes);
      return { added: sum.added, alreadyInStock: sum.duplicates, tooLong: lines.tooLong, givenToWaitingOrders: sum.served, stock: sum.stats };
    }),
  );
}

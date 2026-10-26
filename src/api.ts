// A small client for the Xbitto API, signed in with a personal API key.
//
// The key is read once from the environment and only ever sent in the Authorization header: it is never
// logged and never returned in a tool's output.

export const DEFAULT_API_URL = "https://api.xbitto.com";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(explain(status, code));
    this.name = "ApiError";
  }
}

// What the API's error codes mean, said the way an agent can act on them. Anything not listed is passed
// on by its code: the API is the authority on what it refuses.
const MESSAGES: Record<string, string> = {
  unauthorized: "The API key is missing, wrong or was removed. Create a key on the AI Agents page of the Xbitto dashboard and set XBITTO_API_KEY.",
  region_blocked: "Xbitto isn't available from the place this computer connects from. See the Terms: https://xbitto.com/terms",
  api_key_forbidden:"API keys can't do this. Do it in the Xbitto dashboard.",
  email_not_verified: "The account's email isn't verified yet. Verify it in the Xbitto dashboard first.",
  account_frozen: "The account is restricted, so it can't create or change content.",
  account_suspended: "The account is suspended. Its API keys no longer work.",
  paywalls_paused: "Paid content is temporarily paused on Xbitto.",
  bunny_not_connected: "Bunny Stream isn't connected. Connect it in the Xbitto dashboard under Settings.",
  storage_not_connected: "Bunny Storage isn't connected. Connect it in the Xbitto dashboard under Settings.",
  bunny_unreachable: "Bunny Stream didn't answer. Try again in a moment.",
  storage_unreachable: "Bunny Storage didn't answer. Try again in a moment.",
  daily_link_quota: "The account has created every link it can today.",
  rate_limited: "Too many requests. Wait a minute and try again.",
  target_unsafe: "Xbitto can't accept this content.",
  target_unreachable: "The destination's domain doesn't resolve. Check the address.",
  target_immutable: "A link's destination can't be changed.",
  invalid_url: "The destination isn't a valid URL. Give a full address starting with https:// or http://.",
  target_too_long: "The destination is longer than 2048 characters.",
  unsupported_protocol: "Only http and https destinations can be shortened.",
  credentials_not_allowed: "Remove the username and password from the URL.",
  host_not_allowed: "This destination isn't allowed: use a public website address, not an IP address, a local host or an Xbitto short link.",
  destination_required: "This link was made before a destination was required, so it has nothing to sell. Create a new link.",
  invalid_free_count: "Free episodes can be at most half of all episodes.",
  invalid_price: "The price isn't valid. Give it as a decimal string, e.g. \"5\" or \"4.99\".",
  invalid_payout_address: "The payout wallets aren't valid. Use ids from list_wallets, at most one per network.",
  invalid_cover_url: "The cover must be an https image URL.",
  invalid_images: "The images aren't valid: 1–20 JPEG, PNG, WebP, GIF or AVIF files, each at most 20 MB.",
  screening_unavailable: "Wallet screening isn't available on the platform right now.",
  series_full: "A series holds at most 100 episodes.",
  pool_full: "The pool holds at most 1000 unused items.",
  insufficient_stock: "Not that many items are left for one order.",
  invalid_tag: "A tag can be up to 24 characters and can't be a web address.",
  tag_unsafe: "Xbitto can't accept this tag. Change it and try again.",
  not_found: "Not found. Check the code or id.",
  invalid_input: "The request wasn't valid.",
  code_unavailable: "Xbitto couldn't assign a short code. Try again.",
};

function explain(status: number, code: string): string {
  return MESSAGES[code] ?? `Xbitto refused the request (${status} ${code}).`;
}

export type Api = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
};

type Options = {
  baseUrl: string;
  key: string;
  fetch?: typeof fetch;
  // Waits between attempts; tests pass zeros.
  backoffMs?: number[];
};

const RETRY_STATUSES = new Set([502, 503, 504]);

export function createApi({ baseUrl, key, fetch: fetcher = fetch, backoffMs = [2000, 5000, 10000, 20000] }: Options): Api {
  const root = baseUrl.replace(/\/+$/, "");

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const read = method === "GET";
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetcher(`${root}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            "User-Agent": "xbitto-mcp",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        // A write that never got an answer may have happened, so only a read is tried again.
        if (read && attempt < backoffMs.length) {
          await wait(backoffMs[attempt]!);
          continue;
        }
        throw new Error(`Couldn't reach Xbitto at ${root}: ${error instanceof Error ? error.message : String(error)}`);
      }

      // A 429 was refused before anything happened, so it is safe to repeat even for a write.
      const retry = res.status === 429 || (read && RETRY_STATUSES.has(res.status));
      if (retry && attempt < backoffMs.length) {
        await wait(backoffMs[attempt]!);
        continue;
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      const data = text ? safeJson(text) : null;
      if (!res.ok) {
        const code = (data as { error?: { code?: unknown } } | null)?.error?.code;
        if (typeof code === "string") throw new ApiError(res.status, code);
        // The API answers every refusal in JSON; a 403 page without it was sent by Cloudflare in front,
        // which turns away the regions Xbitto doesn't serve.
        throw new ApiError(res.status, res.status === 403 ? "region_blocked" : "http_error");
      }
      return data as T;
    }
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body ?? {}),
    put: (path, body) => request("PUT", path, body ?? {}),
    delete: (path) => request("DELETE", path),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The client the server runs with, from the environment. Throws a message the agent can relay when the
// key is missing, rather than starting a server whose every tool fails.
export function apiFromEnv(env: NodeJS.ProcessEnv = process.env): Api {
  const key = env.XBITTO_API_KEY?.trim();
  if (!key) throw new Error("XBITTO_API_KEY is not set. Create a key on the AI Agents page of the Xbitto dashboard.");
  return createApi({ baseUrl: env.XBITTO_API_URL?.trim() || DEFAULT_API_URL, key });
}

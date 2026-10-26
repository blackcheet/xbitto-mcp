import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, wait } from "../src/api.js";
import { fakeApi, fakeBunny, KEY, mcpClient, pngHeader, type Call } from "./fakes.js";

let bunny: Awaited<ReturnType<typeof fakeBunny>>;
beforeAll(async () => {
  bunny = await fakeBunny();
});
afterAll(() => bunny.close());

const wallets = { addresses: [{ id: "w-sol", chain: "solana", asset: "USDC", blacklistedAt: null }, { id: "w-tron", chain: "tron", asset: "USDT", blacklistedAt: null }] };
const grant = (videoId: string) => ({ endpoint: `${bunny.origin}/tus`, libraryId: "764011", videoId, signature: `sig-${videoId}`, expires: Math.floor(Date.now() / 1000) + 6 * 3600 });

async function finished(call: Awaited<ReturnType<typeof mcpClient>>["call"], jobId: string) {
  for (let i = 0; i < 200; i++) {
    const job = (await call("get_upload_job", { jobId })).json;
    if (job.state !== "running") return job;
    await wait(20);
  }
  throw new Error("job never finished");
}

describe("add_codes", () => {
  it("sends 250 codes as 100 + 100 + 50 and adds up what came back", async () => {
    const { api, calls } = fakeApi((call) => {
      const codes = (call.body as { codes: string[] }).codes;
      return { body: { added: codes.length - 1, duplicates: 1, served: 0, stats: { left: 7 } } };
    });
    const { call } = await mcpClient(api);
    const codes = Array.from({ length: 250 }, (_, i) => `KEY-${i}`);
    const result = await call("add_codes", { code: "aB3xY9", codes: [...codes, "KEY-0", "", "y".repeat(501)] });
    expect(calls.map((c) => (c.body as { codes: string[] }).codes.length)).toEqual([100, 100, 50]);
    expect(calls.every((c) => c.path === "/api/codes/aB3xY9/stock")).toBe(true);
    expect(result.json).toEqual({ added: 247, alreadyInStock: 3, tooLong: 1, givenToWaitingOrders: 0, stock: { left: 7 } });
  });

  it("reads only a .txt or .csv list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xbitto-mcp-"));
    await writeFile(join(dir, "id_ed25519"), "secret");
    await writeFile(join(dir, "keys.csv"), "A\nB\n");
    const { api, calls } = fakeApi(() => ({ body: { added: 2, duplicates: 0, served: 0, stats: {} } }));
    const { call } = await mcpClient(api);
    expect((await call("add_codes", { code: "aB3xY9", file: join(dir, "id_ed25519") })).text).toMatch(/\.txt or \.csv/);
    expect(calls).toHaveLength(0);
    expect((await call("add_codes", { code: "aB3xY9", file: join(dir, "keys.csv") })).json).toMatchObject({ added: 2 });
    expect((calls[0]!.body as { codes: string[] }).codes).toEqual(["A", "B"]);
  });

  it("takes at most 1000 codes in one call, and none is no call", async () => {
    const { api, calls } = fakeApi(() => ({ body: { added: 0, duplicates: 0, served: 0, stats: {} } }));
    const { call } = await mcpClient(api);
    expect((await call("add_codes", { code: "aB3xY9", codes: Array.from({ length: 1001 }, (_, i) => `K${i}`) })).text).toMatch(/At most 1000/);
    expect((await call("add_codes", { code: "aB3xY9", codes: ["", "  "] })).text).toMatch(/No codes to add/);
    expect(calls).toHaveLength(0);
  });

  it("says how far it got when the API stops it", async () => {
    let n = 0;
    const { api } = fakeApi(() => (++n === 1 ? { body: { added: 100, duplicates: 0, served: 0, stats: {} } } : { status: 409, body: { error: { code: "codes_full" } } }));
    const { call } = await mcpClient(api);
    const result = await call("add_codes", { code: "aB3xY9", codes: Array.from({ length: 150 }, (_, i) => `K${i}`) });
    expect(result.error).toBe(true);
    expect(result.text).toMatch(/at most 10,000 unsold codes, all together\. Added 100 of 150 codes to aB3xY9/);
  });
});

describe("create_codes", () => {
  it("creates the item with its first 100 codes, then sends the rest to its stock", async () => {
    const { api, calls } = fakeApi((c: Call) => {
      if (c.path === "/api/payout-addresses") return { body: wallets };
      if (c.path === "/api/codes") return { status: 201, body: { code: "C0des1" } };
      const codes = (c.body as { codes: string[] }).codes;
      return { body: { added: codes.length, duplicates: 0, served: 0, stats: { left: 150 } } };
    });
    const { call } = await mcpClient(api);
    const result = await call("create_codes", {
      title: "Proxy Keys",
      price: "3",
      codes: Array.from({ length: 150 }, (_, i) => `P-${i}`),
      redeemUrl: "https://redeem.example.com/",
      codeLabel: "Proxy",
      maxPerOrder: 5,
      note: "Use within 30 days.",
    });
    expect(result.json).toEqual({ code: "C0des1", added: 150, alreadyInStock: 0, tooLong: 0 });
    const create = calls.find((c) => c.path === "/api/codes")!;
    expect(create.body).toMatchObject({
      title: "Proxy Keys",
      price: "3",
      payoutAddressIds: ["w-sol", "w-tron"],
      redeemUrl: "https://redeem.example.com/",
      codeLabel: "Proxy",
      maxPerOrder: 5,
      note: "Use within 30 days.",
    });
    expect((create.body as { codes: string[] }).codes).toHaveLength(100);
    const stock = calls.filter((c) => c.path === "/api/codes/C0des1/stock");
    expect(stock.map((c) => (c.body as { codes: string[] }).codes)).toEqual([Array.from({ length: 50 }, (_, i) => `P-${100 + i}`)]);
  });

  it("sends no redeem link when there is none, and makes nothing without codes", async () => {
    const { api, calls } = fakeApi((c: Call) => (c.path === "/api/payout-addresses" ? { body: wallets } : { status: 201, body: { code: "C0des2" } }));
    const { call } = await mcpClient(api);
    expect((await call("create_codes", { title: "Keys", price: "1", codes: [] })).text).toMatch(/No codes to add/);
    expect(calls).toHaveLength(0);
    await call("create_codes", { title: "Keys", price: "1", codes: ["K-1"] });
    const create = calls.find((c) => c.path === "/api/codes")!;
    expect(create.body).not.toHaveProperty("redeemUrl");
    expect(create.body).not.toHaveProperty("note");
    expect(calls.some((c) => c.path.endsWith("/stock"))).toBe(false);
  });
});

describe("set_paywall", () => {
  it("sends an access code only when given, and no Codes fields", async () => {
    const { api, calls } = fakeApi((c: Call) => (c.path === "/api/payout-addresses" ? { body: wallets } : { body: { paywall: {} } }));
    const { call } = await mcpClient(api);
    await call("set_paywall", { code: "aB3xY9", title: "Course", price: "9" });
    await call("set_paywall", { code: "aB3xY9", title: "Course", price: "9", accessCode: "PIN-1" });
    const saves = calls.filter((c) => c.path === "/api/links/aB3xY9/paywall").map((c) => c.body as Record<string, unknown>);
    expect(saves[0]).not.toHaveProperty("accessCode");
    expect(saves[1]).toMatchObject({ accessCode: "PIN-1" });
    for (const body of saves) for (const field of ["codeMode", "codeLabel", "maxPerOrder", "note"]) expect(body).not.toHaveProperty(field);
  });
});

describe("create_drama", () => {
  it("makes the drama, then each part of episodes, and uploads them in order to Bunny", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xbitto-mcp-"));
    for (const name of ["EP10.mp4", "EP2.mp4", "EP1.mp4"]) await writeFile(join(dir, name), Buffer.alloc(1000, 1));
    let video = 0;
    const { api, calls } = fakeApi((c: Call) => {
      if (c.path === "/api/payout-addresses") return { body: wallets };
      if (c.path === "/api/content/series") return { status: 201, body: { code: "Ser1es" } };
      if (c.path === "/api/content/Ser1es/episodes") {
        const files = (c.body as { files: { name: string }[] }).files;
        return { status: 201, body: { uploads: files.map(() => ({ id: `e${++video}`, upload: grant(`v${video}`) })) } };
      }
      return undefined;
    });
    const { call } = await mcpClient(api);
    const started = await call("create_drama", { episodes: dir, title: "Night Train", price: "3", freeCount: 1 });
    expect(started.json).toMatchObject({ code: "Ser1es", files: 3 });

    const create = calls.find((c) => c.path === "/api/content/series")!;
    expect(create.body).toMatchObject({ title: "Night Train", price: "3", freeCount: 1, payoutAddressIds: ["w-sol", "w-tron"], coverUrl: null });
    const job = await finished(call, started.json.jobId);
    expect(job).toMatchObject({ state: "done", total: 3, done: 3, failed: [] });
    expect((calls.find((c) => c.path === "/api/content/Ser1es/episodes")!.body as { files: { name: string }[] }).files.map((f) => f.name)).toEqual([
      "EP1.mp4",
      "EP2.mp4",
      "EP10.mp4",
    ]);
    const uploads = [...bunny.tus.values()].filter((upload) => upload.metadata.title?.startsWith("Night Train"));
    expect(uploads.map((upload) => [upload.metadata.title, upload.headers.videoId, upload.bytes])).toEqual([
      ["Night Train · 1", "v1", 1000],
      ["Night Train · 2", "v2", 1000],
      ["Night Train · 3", "v3", 1000],
    ]);
    expect(uploads[0]!.headers.signature).toBe("sig-v1");
  });

  it("signs an episode again when its part's grant is nearly spent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xbitto-mcp-"));
    await writeFile(join(dir, "EP1.mp4"), Buffer.alloc(10, 1));
    const now = Math.floor(Date.now() / 1000);
    const { api, calls } = fakeApi((c: Call) => {
      if (c.path === "/api/payout-addresses") return { body: wallets };
      if (c.path === "/api/content/series") return { status: 201, body: { code: "Old1" } };
      if (c.path === "/api/content/Old1/episodes") return { status: 201, body: { uploads: [{ id: "e1", upload: { ...grant("stale"), expires: now + 60 } }] } };
      if (c.path === "/api/content/Old1/episodes/e1/upload") return { body: { upload: { ...grant("fresh"), expires: now + 21600 } } };
      return undefined;
    });
    const { call } = await mcpClient(api);
    const started = await call("create_drama", { episodes: dir, title: "Resign", price: "1", freeCount: 0 });
    expect((await finished(call, started.json.jobId)).state).toBe("done");
    expect(calls.some((c) => c.path === "/api/content/Old1/episodes/e1/upload")).toBe(true);
    expect([...bunny.tus.values()].find((upload) => upload.metadata.title === "Resign · 1")!.headers.videoId).toBe("fresh");
  });

  it("refuses more free episodes than half before asking the API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xbitto-mcp-"));
    for (const name of ["a.mp4", "b.mp4"]) await writeFile(join(dir, name), "x");
    const { api, calls } = fakeApi(() => undefined);
    const { call } = await mcpClient(api);
    const result = await call("create_drama", { episodes: dir, title: "T", price: "1", freeCount: 2 });
    expect(result.error).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("create_gallery", () => {
  it("tells the API each picture's type, bytes and pixels, puts them to Storage, confirms and sets the cover", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xbitto-mcp-"));
    await writeFile(join(dir, "2.png"), pngHeader(400, 300));
    await writeFile(join(dir, "10.png"), pngHeader(300, 400));
    const { api, calls } = fakeApi((c) => {
      if (c.path === "/api/payout-addresses") return { body: wallets };
      if (c.path === "/api/content/galleries")
        return { status: 201, body: { code: "Ga11ry", uploads: [{ id: "i1", url: `${bunny.origin}/storage/a` }, { id: "i2", url: `${bunny.origin}/storage/b` }] } };
      if (c.path === "/api/content/Ga11ry/images/confirm") return { body: { images: [{ id: "i1", uploaded: true }, { id: "i2", uploaded: true }] } };
      if (c.path === "/api/content/Ga11ry/cover") return { status: 204 };
      return undefined;
    });
    const { call } = await mcpClient(api);
    const started = await call("create_gallery", { images: dir, title: "Set", price: "2", coverIndex: 1, payoutWalletIds: ["w-tron"] });
    expect(started.error).toBe(false);
    const job = await finished(call, started.json.jobId);
    expect(job).toMatchObject({ state: "done", done: 2 });

    const create = calls.find((c) => c.path === "/api/content/galleries")!.body as { images: unknown[]; payoutAddressIds: string[] };
    expect(create.payoutAddressIds).toEqual(["w-tron"]);
    expect(create.images).toEqual([
      { type: "image/png", size: 97, width: 400, height: 300 },
      { type: "image/png", size: 97, width: 300, height: 400 },
    ]);
    expect(bunny.puts.get("/storage/a")).toEqual({ type: "image/png", bytes: 97 });
    expect(calls.find((c) => c.path === "/api/content/Ga11ry/cover")!.body).toEqual({ imageId: "i2" });
  });
});

describe("whoami", () => {
  const answers = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    "/api/auth/me": { user: { email: "c@example.com", emailVerified: true, frozen: false } },
    "/api/credits/summary": { balanceMicro: 4_500_000 },
    "/api/links/quota": { quota: { used: 3, limit: 15 } },
    "/api/payout-addresses": { addresses: [wallets.addresses[1]], rails: [{ chain: "solana", asset: "USDC" }, { chain: "tron", asset: "USDT" }] },
    "/api/content/connection": { connection: { libraryId: "1" } },
    "/api/content/storage": { storage: null },
    "/api/account/paywalls": { open: true },
    "/api/account/payer-policy": { fees: { baseMicro: 200_000, percentBasisPoints: 500 }, scoringAvailable: false },
    ...over,
  });
  const ask = async (over?: Record<string, unknown>) => {
    const table = answers(over);
    const { api } = fakeApi((c) => (c.path in table ? { body: table[c.path] } : undefined));
    return (await (await mcpClient(api)).call("whoami")).json;
  };

  it("says what the account can create and what is missing", async () => {
    expect(await ask()).toEqual({
      account: { email: "c@example.com", emailVerified: true, restricted: false },
      linksToday: { used: 3, limit: 15, left: 12 },
      credits: "4.5",
      salesFee: "0.2 + 5% of the price",
      payoutNetworks: [
        { network: "Solana", coin: "USDC", wallet: false },
        { network: "TRON", coin: "USDT", wallet: true },
      ],
      bunny: { stream: true, storage: false },
      walletScreening: false,
      canCreate: { freeLink: true, gatedLink: true, codes: true, gallery: false, video: true, drama: true },
      missing: [expect.stringMatching(/Bunny Storage isn't connected/)],
    });
  });

  it("holds back paid items without a wallet or while paid content is paused", async () => {
    const noWallet = await ask({ "/api/payout-addresses": { addresses: [], rails: [{ chain: "tron", asset: "USDT" }] } });
    expect(noWallet.canCreate).toMatchObject({ freeLink: true, gatedLink: false, codes: false, video: false });
    expect(noWallet.missing).toContainEqual(expect.stringMatching(/No usable payout wallet/));

    const paused = await ask({ "/api/account/paywalls": { open: false }, "/api/credits/summary": { balanceMicro: 0 } });
    expect(paused.canCreate).toMatchObject({ freeLink: true, gatedLink: false });
    expect(paused.missing).toEqual(expect.arrayContaining([expect.stringMatching(/paused/), expect.stringMatching(/credit balance/)]));

    const spent = await ask({ "/api/links/quota": { quota: { used: 15, limit: 15 } } });
    expect(spent.canCreate.freeLink).toBe(false);
  });
});

describe("the store", () => {
  it("tags an item and shows it on the store", async () => {
    const { api, calls } = fakeApi((c) => {
      if (c.path === "/api/links/aB3xY9/tag") return { body: { tag: (c.body as { tag: string }).tag } };
      if (c.path === "/api/links/aB3xY9/store") return { body: { inStore: (c.body as { on: boolean }).on } };
      return undefined;
    });
    const { call } = await mcpClient(api);
    expect((await call("set_tag", { code: "aB3xY9", tag: "Videos" })).json).toEqual({ tag: "Videos" });
    expect((await call("set_store_visibility", { code: "aB3xY9", show: true })).json).toEqual({ inStore: true });
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["PUT", "/api/links/aB3xY9/tag", { tag: "Videos" }],
      ["PUT", "/api/links/aB3xY9/store", { on: true }],
    ]);
  });

  it("reads the store with its tags, and explains a refused tag", async () => {
    const store = { slug: "IFTVjD1T", url: "https://xbit.my/s/IFTVjD1T", name: "Night Owl", description: "", open: true, closedByAdmin: false };
    const { api } = fakeApi((c) =>
      c.path === "/api/store"
        ? { body: { store } }
        : c.path === "/api/store/tags"
          ? { body: { tags: [{ name: "Videos", items: 2, shown: 1 }] } }
          : { status: 400, body: { error: { code: "tag_unsafe" } } },
    );
    const { call } = await mcpClient(api);
    expect((await call("get_store")).json).toEqual({ store, tags: [{ name: "Videos", items: 2, shown: 1 }] });
    expect((await call("set_tag", { code: "aB3xY9", tag: "nope" })).text).toMatch(/can't accept this tag/);
  });
});

describe("error codes", () => {
  it("explain a refused destination by its public reason", async () => {
    const { api } = fakeApi(() => ({ status: 400, body: { error: { code: "host_not_allowed" } } }));
    const result = await (await mcpClient(api)).call("create_link", { targetUrl: "https://xbit.my/abc" });
    expect(result.error).toBe(true);
    expect(result.text).toMatch(/Xbitto short link/);
  });

  it("tell a region block in front of the API from a refusal by it", async () => {
    const blocked = createApi({
      baseUrl: "https://api.test",
      key: KEY,
      fetch: (async () => new Response("<html>Sorry, you have been blocked</html>", { status: 403, headers: { "Content-Type": "text/html" } })) as typeof fetch,
    });
    expect((await (await mcpClient(blocked)).call("whoami")).text).toMatch(/^Xbitto isn't available from the place this computer connects from\. See the Terms/);
    // A 403 the API itself answers keeps its own meaning.
    const forbidden = fakeApi(() => ({ status: 403, body: { error: { code: "api_key_forbidden" } } }));
    expect((await (await mcpClient(forbidden.api)).call("whoami")).text).toMatch(/API keys can't do this/);
  });
});

describe("the key", () => {
  it("never shows up in what a tool says", async () => {
    const { api } = fakeApi(() => ({ status: 401, body: { error: { code: "unauthorized" } } }));
    const { call } = await mcpClient(api);
    const result = await call("whoami");
    expect(result.error).toBe(true);
    expect(result.text).toMatch(/AI Agents page/);
    expect(result.text).not.toContain(KEY);
  });
});

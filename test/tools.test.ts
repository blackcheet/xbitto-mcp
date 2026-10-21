import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wait } from "../src/api.js";
import { fakeApi, fakeBunny, KEY, mcpClient, pngHeader, type Call } from "./fakes.js";

let bunny: Awaited<ReturnType<typeof fakeBunny>>;
beforeAll(async () => {
  bunny = await fakeBunny();
});
afterAll(() => bunny.close());

const wallets = { addresses: [{ id: "w-sol", chain: "solana", asset: "USDC", blacklistedAt: null }, { id: "w-tron", chain: "tron", asset: "USDT", blacklistedAt: null }] };
const grant = (videoId: string) => ({ endpoint: `${bunny.origin}/tus`, libraryId: "764011", videoId, signature: `sig-${videoId}`, expires: 1 });

async function finished(call: Awaited<ReturnType<typeof mcpClient>>["call"], jobId: string) {
  for (let i = 0; i < 200; i++) {
    const job = (await call("get_upload_job", { jobId })).json;
    if (job.state !== "running") return job;
    await wait(20);
  }
  throw new Error("job never finished");
}

describe("add_pool_items", () => {
  it("sends 250 items as 100 + 100 + 50 and adds up what came back", async () => {
    const { api, calls } = fakeApi((call) => {
      const codes = (call.body as { codes: string[] }).codes;
      return { body: { added: codes.length - 1, duplicates: 1, served: 0, stats: { left: 7 } } };
    });
    const { call } = await mcpClient(api);
    const items = Array.from({ length: 250 }, (_, i) => `KEY-${i}`);
    const result = await call("add_pool_items", { code: "aB3xY9", items: [...items, "KEY-0", "", "y".repeat(300)] });
    expect(calls.map((c) => (c.body as { codes: string[] }).codes.length)).toEqual([100, 100, 50]);
    expect(calls.every((c) => c.path === "/api/links/aB3xY9/access-codes")).toBe(true);
    expect(result.json).toEqual({ added: 247, alreadyInPool: 3, tooLong: 1, givenToWaitingOrders: 0, pool: { left: 7 } });
  });

  it("says how far it got when the API stops it", async () => {
    let n = 0;
    const { api } = fakeApi(() => (++n === 1 ? { body: { added: 100, duplicates: 0, served: 0, stats: {} } } : { status: 409, body: { error: { code: "pool_full" } } }));
    const { call } = await mcpClient(api);
    const result = await call("add_pool_items", { code: "aB3xY9", items: Array.from({ length: 150 }, (_, i) => `K${i}`) });
    expect(result.error).toBe(true);
    expect(result.text).toMatch(/at most 1000 unused items\. Added 100 of 150/);
  });
});

describe("create_series", () => {
  it("makes the series, then each part of episodes, and uploads them in order to Bunny", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xbitto-mcp-"));
    for (const name of ["EP10.mp4", "EP2.mp4", "EP1.mp4"]) await writeFile(join(dir, name), Buffer.alloc(1000, 1));
    let video = 0;
    const { api, calls } = fakeApi((c: Call) => {
      if (c.path === "/api/payout-addresses") return { body: wallets };
      if (c.path === "/api/vault/series") return { status: 201, body: { code: "Ser1es" } };
      if (c.path === "/api/vault/Ser1es/episodes") {
        const files = (c.body as { files: { name: string }[] }).files;
        return { status: 201, body: { uploads: files.map(() => ({ id: `e${++video}`, upload: grant(`v${video}`) })) } };
      }
      return undefined;
    });
    const { call } = await mcpClient(api);
    const started = await call("create_series", { episodes: dir, title: "Night Train", price: "3", freeCount: 1 });
    expect(started.json).toMatchObject({ code: "Ser1es", files: 3 });

    const create = calls.find((c) => c.path === "/api/vault/series")!;
    expect(create.body).toMatchObject({ title: "Night Train", price: "3", freeCount: 1, payoutAddressIds: ["w-sol", "w-tron"], coverUrl: null });
    const job = await finished(call, started.json.jobId);
    expect(job).toMatchObject({ state: "done", total: 3, done: 3, failed: [] });
    expect((calls.find((c) => c.path === "/api/vault/Ser1es/episodes")!.body as { files: { name: string }[] }).files.map((f) => f.name)).toEqual([
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

  it("refuses more free episodes than half before asking the API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xbitto-mcp-"));
    for (const name of ["a.mp4", "b.mp4"]) await writeFile(join(dir, name), "x");
    const { api, calls } = fakeApi(() => undefined);
    const { call } = await mcpClient(api);
    const result = await call("create_series", { episodes: dir, title: "T", price: "1", freeCount: 2 });
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
      if (c.path === "/api/vault/galleries")
        return { status: 201, body: { code: "Ga11ry", uploads: [{ id: "i1", url: `${bunny.origin}/storage/a` }, { id: "i2", url: `${bunny.origin}/storage/b` }] } };
      if (c.path === "/api/vault/Ga11ry/images/confirm") return { body: { images: [{ id: "i1", uploaded: true }, { id: "i2", uploaded: true }] } };
      if (c.path === "/api/vault/Ga11ry/cover") return { status: 204 };
      return undefined;
    });
    const { call } = await mcpClient(api);
    const started = await call("create_gallery", { images: dir, title: "Set", price: "2", coverIndex: 1, payoutWalletIds: ["w-tron"] });
    expect(started.error).toBe(false);
    const job = await finished(call, started.json.jobId);
    expect(job).toMatchObject({ state: "done", done: 2 });

    const create = calls.find((c) => c.path === "/api/vault/galleries")!.body as { images: unknown[]; payoutAddressIds: string[] };
    expect(create.payoutAddressIds).toEqual(["w-tron"]);
    expect(create.images).toEqual([
      { type: "image/png", size: 97, width: 400, height: 300 },
      { type: "image/png", size: 97, width: 300, height: 400 },
    ]);
    expect(bunny.puts.get("/storage/a")).toEqual({ type: "image/png", bytes: 97 });
    expect(calls.find((c) => c.path === "/api/vault/Ga11ry/cover")!.body).toEqual({ imageId: "i2" });
  });
});

describe("the key", () => {
  it("never shows up in what a tool says", async () => {
    const { api } = fakeApi(() => ({ status: 401, body: { error: { code: "unauthorized" } } }));
    const { call } = await mcpClient(api);
    const result = await call("whoami");
    expect(result.error).toBe(true);
    expect(result.text).toMatch(/API Keys/);
    expect(result.text).not.toContain(KEY);
  });
});

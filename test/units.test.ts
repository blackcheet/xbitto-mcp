import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api.js";
import { compareNames, imagePixels, imageType, pickFiles, readItemLines } from "../src/files.js";
import { fakeApi, KEY, pngHeader } from "./fakes.js";

describe("pool item lines", () => {
  it("trims, drops blanks and repeats, and counts lines that are too long", () => {
    const text = " KEY-1 \r\n\nKEY-2\nKEY-1\n" + "x".repeat(201) + "\nKEY-3";
    expect(readItemLines(text, 200)).toEqual({ items: ["KEY-1", "KEY-2", "KEY-3"], tooLong: 1 });
  });

  it("counts characters, not UTF-16 units", () => {
    expect(readItemLines("😀".repeat(200), 200).items).toHaveLength(1);
  });
});

describe("local files", () => {
  it("orders a folder the way a person numbers episodes and keeps a list as given", async () => {
    expect(["EP10.mp4", "EP2.mp4", "ep1.mp4"].sort(compareNames)).toEqual(["ep1.mp4", "EP2.mp4", "EP10.mp4"]);
    const dir = await mkdtemp(join(tmpdir(), "xbitto-mcp-"));
    for (const name of ["EP10.mp4", "EP2.mp4", "EP1.mp4", "notes.txt", ".hidden.mp4"]) await writeFile(join(dir, name), "x");
    expect((await pickFiles(dir, [".mp4"])).map((file) => file.name)).toEqual(["EP1.mp4", "EP2.mp4", "EP10.mp4"]);
    expect((await pickFiles([join(dir, "EP10.mp4"), join(dir, "EP1.mp4")], [".mp4"])).map((file) => file.name)).toEqual(["EP10.mp4", "EP1.mp4"]);
    await expect(pickFiles([join(dir, "notes.txt")], [".mp4"])).rejects.toThrow(/Not an accepted file type/);
  });

  it("tells a picture's type from its bytes and reads its size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xbitto-mcp-"));
    const png = join(dir, "named.jpg");
    await writeFile(png, pngHeader(3, 2));
    expect(await imageType(png)).toBe("image/png");
    expect(await imagePixels(png)).toEqual({ width: 3, height: 2 });
    const text = join(dir, "fake.png");
    await writeFile(text, "not a picture at all");
    expect(await imageType(text)).toBeNull();
  });
});

describe("API client", () => {
  it("sends the key only in the header and says what an error code means", async () => {
    const { api, calls } = fakeApi(() => ({ status: 403, body: { error: { code: "api_key_forbidden" } } }));
    const error = await api.post("/api/payout-addresses").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toMatch(/dashboard/);
    expect((error as Error).message).not.toContain(KEY);
    expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
  });

  it("repeats a 429 but never a write that may have happened", async () => {
    let n = 0;
    const limited = fakeApi(() => (++n < 3 ? { status: 429, body: { error: { code: "rate_limited" } } } : { body: { ok: true } }));
    expect(await limited.api.post("/api/links", {})).toEqual({ ok: true });
    expect(limited.calls).toHaveLength(3);

    const down = fakeApi(() => ({ status: 503, body: { error: { code: "code_unavailable" } } }));
    await expect(down.api.post("/api/links", {})).rejects.toThrow();
    expect(down.calls).toHaveLength(1);
    await expect(down.api.get("/api/links")).rejects.toThrow();
    expect(down.calls).toHaveLength(5);
  });
});

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApi } from "../src/api.js";
import { createServer as createMcpServer } from "../src/server.js";

// A stand-in for the Xbitto API (a fetch function answering by route) and for Bunny (a local HTTP
// server taking presigned PUTs and tus uploads), so the tools run end to end without either.

export type Call = { method: string; path: string; body: unknown; auth: string | null };
export type Route = (call: Call) => { status?: number; body?: unknown } | undefined;

export const KEY = "xb_test_key_never_shown_00000000000000000000";

export function fakeApi(route: Route) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: headers.get("Authorization"),
    };
    calls.push(call);
    const answer = route(call) ?? { status: 404, body: { error: { code: "not_found" } } };
    const status = answer.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(answer.body ?? {}), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, api: createApi({ baseUrl: "https://api.test", key: KEY, fetch: fetcher, backoffMs: [0, 0, 0] }) };
}

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => resolve(Buffer.concat(parts)));
  });

export type TusUpload = { metadata: Record<string, string>; headers: Record<string, string | undefined>; bytes: number; length: number };

export async function fakeBunny() {
  const puts = new Map<string, { type: string | undefined; bytes: number }>();
  const tus = new Map<string, TusUpload>();
  let next = 0;
  const server = createServer(async (req, res) => {
    const path = req.url ?? "/";
    const body = await readBody(req);
    if (req.method === "PUT" && path.startsWith("/storage/")) {
      puts.set(path, { type: req.headers["content-type"], bytes: body.length });
      return res.writeHead(200).end();
    }
    const tusHeaders = { "Tus-Resumable": "1.0.0" };
    if (req.method === "POST" && path === "/tus") {
      const metadata: Record<string, string> = {};
      for (const pair of String(req.headers["upload-metadata"] ?? "").split(",")) {
        const [key, value] = pair.trim().split(" ");
        if (key) metadata[key] = Buffer.from(value ?? "", "base64").toString("utf8");
      }
      const id = String(++next);
      tus.set(id, {
        metadata,
        headers: { signature: req.headers["authorizationsignature"] as string, videoId: req.headers["videoid"] as string },
        bytes: 0,
        length: Number(req.headers["upload-length"]),
      });
      return res.writeHead(201, { ...tusHeaders, Location: `/tus/${id}` }).end();
    }
    const upload = tus.get(path.split("/")[2] ?? "");
    if (upload && req.method === "PATCH") {
      upload.bytes += body.length;
      return res.writeHead(204, { ...tusHeaders, "Upload-Offset": String(upload.bytes) }).end();
    }
    if (upload && req.method === "HEAD") return res.writeHead(200, { ...tusHeaders, "Upload-Offset": String(upload.bytes), "Upload-Length": String(upload.length) }).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, puts, tus, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

// An MCP client talking to the server over an in-memory pair, as an agent would.
export async function mcpClient(api: ReturnType<typeof createApi>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(api).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      const text = result.content[0]?.text ?? "";
      return { error: result.isError === true, text, json: result.isError ? null : JSON.parse(text) };
    },
    client,
  };
}

// The start of a PNG of the given size: signature and IHDR, which is all a type or size reader looks at.
export function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(2, 17);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(64)]);
}

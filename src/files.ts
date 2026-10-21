import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { imageSize } from "image-size";

// Local files an upload tool was pointed at: a folder (its files, not its subfolders) or a list of files.

export type LocalFile = { path: string; name: string; size: number };

const names = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
// "EP2" before "EP10", as a person numbers episodes.
export const compareNames = (a: string, b: string) => names.compare(a, b);

const absolute = (path: string) => (isAbsolute(path) ? path : resolve(process.cwd(), path));

// A folder gives its files with an accepted extension, in natural name order. A list keeps the order it
// was given in, and every file in it must exist and have an accepted extension.
export async function pickFiles(input: string | string[], extensions: readonly string[]): Promise<LocalFile[]> {
  const accepted = (path: string) => extensions.includes(extname(path).toLowerCase());
  if (typeof input === "string") {
    const path = absolute(input);
    const info = await stat(path).catch(() => null);
    if (!info) throw new Error(`Not found: ${input}`);
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".") && accepted(entry.name)).map((entry) => entry.name);
      files.sort(compareNames);
      if (files.length === 0) throw new Error(`No ${extensions.join(", ")} files in ${input}`);
      return Promise.all(files.map((name) => describe(join(path, name))));
    }
    input = [input];
  }
  return Promise.all(
    input.map(async (given) => {
      if (!accepted(given)) throw new Error(`Not an accepted file type (${extensions.join(", ")}): ${given}`);
      return describe(absolute(given));
    }),
  );
}

async function describe(path: string): Promise<LocalFile> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`Not a file: ${path}`);
  return { path, name: basename(path), size: info.size };
}

export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"] as const;
export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"] as const;
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

// An image's type from its first bytes, not its name: the API is told what the file really is.
export async function imageType(path: string): Promise<string | null> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(16);
    await handle.read(head, 0, 16, 0);
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
    if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
    if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
    const brand = head.subarray(4, 12).toString("latin1");
    if (brand === "ftypavif" || brand === "ftypavis") return "image/avif";
    return null;
  } finally {
    await handle.close();
  }
}

// Width and height as the picture is shown (EXIF orientation 5–8 is turned a quarter), or null when they
// can't be read. Only the layout of the buyer's page uses them.
export async function imagePixels(path: string): Promise<{ width: number; height: number } | null> {
  try {
    const size = imageSize(await readFile(path));
    if (!size.width || !size.height) return null;
    const turned = size.orientation !== undefined && size.orientation >= 5 && size.orientation <= 8;
    return turned ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
  } catch {
    return null;
  }
}

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
};
export const videoType = (path: string) => VIDEO_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

// The items in a pasted list or a text file, one per line: trimmed, blank lines dropped, a repeat kept
// once, in the order given. Lines longer than `max` characters are counted apart, not cut.
export function readItemLines(text: string, max: number): { items: string[]; tooLong: number } {
  const items: string[] = [];
  const seen = new Set<string>();
  let tooLong = 0;
  for (const line of text.split(/\r\n?|\n/)) {
    const item = line.trim();
    if (item === "" || seen.has(item)) continue;
    if ([...item].length > max) {
      tooLong++;
      continue;
    }
    seen.add(item);
    items.push(item);
  }
  return { items, tooLong };
}

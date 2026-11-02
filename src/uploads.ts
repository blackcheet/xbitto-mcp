import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Upload, type DetailedError } from "tus-js-client";
import { wait } from "./api.js";

// Bytes go from this machine straight to the creator's own Bunny account, with the grants the Xbitto API
// signed. Nothing passes through Xbitto: the API only signs the upload and, afterwards, looks at what
// arrived.

// What the API hands out for one video: Bunny Stream's tus endpoint and a signature bound to that video.
// Said with a 403 from Bunny, which turns away some regions on its own.
const BUNNY_REGIONS = "Bunny doesn't serve some regions and networks.";

export type UploadGrant ={ endpoint: string; libraryId: string; videoId: string; signature: string; expires: number };

// A video file into its video in the creator's Bunny Stream library, resumable within this run: tus
// retries a dropped connection from where it got to. `onPercent` reports progress.
export function sendVideo(path: string, grant: UploadGrant, title: string, type: string, onPercent: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const upload = new Upload(createReadStream(path), {
      endpoint: grant.endpoint,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      // Parts of 50 MB, so a retry resends at most one part.
      chunkSize: 50 * 1024 * 1024,
      headers: {
        AuthorizationSignature: grant.signature,
        AuthorizationExpire: String(grant.expires),
        VideoId: grant.videoId,
        LibraryId: grant.libraryId,
      },
      metadata: { filetype: type, title },
      onProgress: (sent, total) => onPercent(total > 0 ? Math.floor((sent / total) * 100) : 0),
      onError: (error) => {
        const status = (error as DetailedError).originalResponse?.getStatus();
        reject(new Error(status === 403 ? `Bunny Stream refused the upload (403). ${BUNNY_REGIONS}` : `Bunny Stream refused the upload: ${error.message}`));
      },
      onSuccess: () => resolve(),
    });
    upload.start();
  });
}

// A picture to its presigned address in the creator's Bunny Storage zone. Pictures are at most 20 MB, so
// the file is read whole. A dropped connection or a busy answer (429, 5xx) is tried again: a PUT of the
// same file to the same address can be repeated safely.
const IMAGE_RETRY_MS = [2000, 5000, 10000];

export async function sendImage(url: string, path: string, type: string, fetcher: typeof fetch = fetch, backoffMs: number[] = IMAGE_RETRY_MS): Promise<void> {
  const body = await readFile(path);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetcher(url, { method: "PUT", headers: { "Content-Type": type, "Content-Length": String(body.length) }, body });
    } catch (error) {
      if (attempt < backoffMs.length) {
        await wait(backoffMs[attempt]!);
        continue;
      }
      throw new Error(`Couldn't reach Bunny Storage: ${error instanceof Error ? error.message : String(error)}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < backoffMs.length) {
      await wait(backoffMs[attempt]!);
      continue;
    }
    if (!res.ok) throw new Error(`Bunny Storage refused the upload (${res.status}).${res.status === 403 ? ` ${BUNNY_REGIONS}` : ""}`);
    return;
  }
}

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Upload } from "tus-js-client";

// Bytes go from this machine straight to the creator's own Bunny account, with the grants the Xbitto API
// signed. Nothing passes through Xbitto: the API only signs the upload and, afterwards, looks at what
// arrived.

// What the API hands out for one video: Bunny Stream's tus endpoint and a signature bound to that video.
export type UploadGrant = { endpoint: string; libraryId: string; videoId: string; signature: string; expires: number };

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
      onError: (error) => reject(new Error(`Bunny Stream refused the upload: ${error.message}`)),
      onSuccess: () => resolve(),
    });
    upload.start();
  });
}

// A picture to its presigned address in the creator's Bunny Storage zone. Pictures are at most 20 MB, so
// the file is read whole.
export async function sendImage(url: string, path: string, type: string, fetcher: typeof fetch = fetch): Promise<void> {
  const body = await readFile(path);
  const res = await fetcher(url, { method: "PUT", headers: { "Content-Type": type, "Content-Length": String(body.length) }, body });
  if (!res.ok) throw new Error(`Bunny Storage refused the upload (${res.status}).`);
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wait, type Api } from "../api.js";
import { IMAGE_EXTENSIONS, IMAGE_MAX_BYTES, imagePixels, imageType, pickFiles, VIDEO_EXTENSIONS, videoType, type LocalFile } from "../files.js";
import { getJob, jobSummary, listJobs, runItem, startJob, type Job } from "../jobs.js";
import { sendImage, sendVideo, type UploadGrant } from "../uploads.js";
import { code, handle, paywallBody, paywallFields } from "./common.js";

// Content: galleries in the creator's Bunny Storage zone, videos and dramas (short series in episodes) in
// their Bunny Stream library. Each tool creates the item first, so a refusal (a bad price, Bunny not
// connected) comes back at once; the files then go up in a background job the agent follows with
// get_upload_job.

export const GALLERY_MAX = 20;
export const DRAMA_MAX_EPISODES = 100;
// Episodes made in one request, the API's limit.
export const EPISODES_PER_REQUEST = 20;
// Pictures sent at once.
const IMAGE_CONCURRENCY = 3;

const files = z
  .union([z.string(), z.array(z.string()).min(1)])
  .describe("A folder (its files in natural name order: EP2 before EP10) or a list of file paths (kept in the order given).");

const limitDevices = z.boolean().optional().describe("Let each purchase open the content on only a few browsers.");

const started = (job: Job, code: string, extra: Record<string, unknown> = {}) => ({
  code,
  jobId: job.id,
  files: job.items.length,
  next: "Uploading in the background. Call get_upload_job with jobId to follow it.",
  ...extra,
});

export function registerContentTools(server: McpServer, api: Api) {
  server.registerTool(
    "create_gallery",
    {
      title: "Create Gallery",
      description:
        "Sell a gallery of 1–20 pictures (JPEG, PNG, WebP, GIF or AVIF, each at most 20 MB) from this computer. " +
        "They go straight to the creator's own Bunny Storage zone. One picture is the cover (blurred or not on the landing page). " +
        "Ask the user for the pictures, the title, the price and which picture is the cover before calling.",
      inputSchema: {
        images: files,
        ...paywallFields,
        coverIndex: z.number().int().min(0).optional().describe("Which picture is the cover, counting from 0. Default 0."),
        limitDevices,
      },
    },
    handle(async (args: { images: string | string[]; coverIndex?: number; limitDevices?: boolean } & Parameters<typeof paywallBody>[1]) => {
      const picked = await pickFiles(args.images, IMAGE_EXTENSIONS);
      if (picked.length > GALLERY_MAX) throw new Error(`A gallery holds at most ${GALLERY_MAX} pictures; got ${picked.length}.`);
      const described = await describeImages(picked);
      const cover = args.coverIndex ?? 0;
      if (cover >= picked.length) throw new Error(`coverIndex ${cover} is past the last picture.`);

      const body = await paywallBody(api, args, { images: described.map((entry) => entry.request), ...(args.limitDevices === undefined ? {} : { limitDevices: args.limitDevices }) });
      const created = await api.post<{ code: string; uploads: ImageGrant[] }>("/api/content/galleries", body);

      const job = startJob("gallery", picked.map((file) => file.name), async (job) => {
        job.code = created.code;
        const arrived = await sendGallery(api, job, created.code, described, created.uploads);
        // The cover asked for, or the first picture that arrived when that one didn't.
        const coverId = created.uploads[cover]!.id;
        const coverImage = arrived.find((image) => image.id === coverId) ?? arrived[0];
        if (coverImage) await api.post(`/api/content/${created.code}/cover`, { imageId: coverImage.id });
        return galleryMessage(arrived, created.uploads, " The gallery takes orders.");
      });
      return started(job, created.code);
    }),
  );

  server.registerTool(
    "add_images",
    {
      title: "Add Images",
      description:
        "Send pictures to an existing gallery. They first go to the places of pictures that never arrived (get_content shows those as " +
        "uploaded: false), in order, so give those same pictures first; any left over are added at the end, up to 20 pictures in all. " +
        "Use it to finish a gallery whose upload was cut off, or to add more pictures.",
      inputSchema: {
        code,
        images: files,
        coverIndex: z.number().int().min(0).optional().describe("Make one of these pictures the cover, counting from 0 among the ones given here. Left out: the cover stays."),
      },
    },
    handle(async ({ code, images, coverIndex }: { code: string; images: string | string[]; coverIndex?: number }) => {
      const picked = await pickFiles(images, IMAGE_EXTENSIONS);
      const described = await describeImages(picked);
      if (coverIndex !== undefined && coverIndex >= picked.length) throw new Error(`coverIndex ${coverIndex} is past the last picture.`);
      const { item } = await api.get<{ item: { media: string; images: { id: string; uploaded: boolean }[] } }>(`/api/content/${code}`);
      if (item.media !== "images") throw new Error(`${code} is not a gallery.`);
      const empty = item.images.filter((image) => !image.uploaded);
      const extra = described.slice(empty.length);
      if (item.images.length + extra.length > GALLERY_MAX) {
        throw new Error(`The gallery has ${item.images.length} pictures (${empty.length} not arrived) and holds at most ${GALLERY_MAX}.`);
      }

      // A fresh address for each place still empty, then new places for the rest.
      const grants: ImageGrant[] = [];
      for (const image of empty.slice(0, described.length)) {
        grants.push({ id: image.id, url: (await api.post<{ upload: ImageGrant }>(`/api/content/${code}/images/${image.id}/upload`)).upload.url });
      }
      if (extra.length > 0) {
        grants.push(...(await api.post<{ uploads: ImageGrant[] }>(`/api/content/${code}/images`, { images: extra.map((entry) => entry.request) })).uploads);
      }

      const job = startJob("images", picked.map((file) => file.name), async (job) => {
        job.code = code;
        const arrived = await sendGallery(api, job, code, described, grants);
        const coverImage = coverIndex === undefined ? undefined : arrived.find((image) => image.id === grants[coverIndex]!.id);
        if (coverImage) await api.post(`/api/content/${code}/cover`, { imageId: coverImage.id });
        return galleryMessage(arrived, grants, "");
      });
      return started(job, code, { filled: Math.min(empty.length, described.length), added: extra.length });
    }),
  );

  server.registerTool(
    "create_video",
    {
      title: "Create Video",
      description:
        "Sell a video from this computer, with an optional short preview clip that plays on the landing page. " +
        "Files go straight to the creator's own Bunny Stream library; the item takes orders once Bunny has finished encoding the main video. " +
        "A video has no cover: the preview clip is all consumers see before paying. Ask the user for the video, the title, the price and whether there is a preview clip before calling.",
      inputSchema: {
        video: z.string().describe("Path to the main video file."),
        previewClip: z.string().optional().describe("Path to a short preview clip (a separate file, not a cut of the main video)."),
        ...paywallFields,
        limitDevices,
      },
    },
    handle(async (args: { video: string; previewClip?: string; limitDevices?: boolean } & Parameters<typeof paywallBody>[1]) => {
      const [main] = await pickFiles([args.video], VIDEO_EXTENSIONS);
      const clip = args.previewClip ? (await pickFiles([args.previewClip], VIDEO_EXTENSIONS))[0] : undefined;
      const body = await paywallBody(api, args, args.limitDevices === undefined ? {} : { limitDevices: args.limitDevices });
      const created = await api.post<{ code: string; upload: UploadGrant }>("/api/content", body);

      const names = [main!.name, ...(clip ? [`${clip.name} (preview clip)`] : [])];
      const job = startJob("video", names, async (job) => {
        job.code = created.code;
        const ok = await runItem(job.items[0]!, (onPercent) => sendVideo(main!.path, created.upload, args.title, videoType(main!.path), onPercent));
        if (clip) {
          await runItem(job.items[1]!, async (onPercent) => {
            const { upload } = await api.post<{ upload: UploadGrant }>(`/api/content/${created.code}/teaser`);
            await sendVideo(clip.path, upload, `${args.title} (preview)`, videoType(clip.path), onPercent);
          });
        }
        return ok ? "Uploaded. Bunny is encoding it; the item takes orders once it is ready (check with get_content)." : null;
      });
      return started(job, created.code);
    }),
  );

  server.registerTool(
    "create_drama",
    {
      title: "Create Drama",
      description:
        "Sell a drama (a short series in episodes) for one price, with the first few episodes free. Up to 100 episodes from this computer, " +
        "numbered in the order given (a folder: natural name order). Files go straight to the creator's Bunny Stream library. " +
        "It takes orders once at least freeCount + 1 episodes (and at least 2) are ready. " +
        "Ask the user for the episodes, the title, the price and how many are free before calling.",
      inputSchema: {
        episodes: files,
        ...paywallFields,
        freeCount: z.number().int().min(0).max(50).describe("How many first episodes anyone can watch before paying. At most half of the episodes."),
        posterUrl: z.string().url().optional().describe("A third-party https poster image URL (a 3:4 portrait works best)."),
        blurPoster: z.boolean().optional(),
        limitDevices,
      },
    },
    handle(
      async (
        args: { episodes: string | string[]; freeCount: number; posterUrl?: string; blurPoster?: boolean; limitDevices?: boolean } & Parameters<typeof paywallBody>[1],
      ) => {
        const picked = await pickFiles(args.episodes, VIDEO_EXTENSIONS);
        if (picked.length > DRAMA_MAX_EPISODES) throw new Error(`A drama holds at most ${DRAMA_MAX_EPISODES} episodes; got ${picked.length}.`);
        if (args.freeCount > Math.floor(picked.length / 2)) throw new Error(`freeCount can be at most half of the episodes (${Math.floor(picked.length / 2)}).`);
        const body = await paywallBody(api, args, {
          freeCount: args.freeCount,
          coverUrl: args.posterUrl ?? null,
          coverBlur: args.blurPoster ?? false,
          ...(args.limitDevices === undefined ? {} : { limitDevices: args.limitDevices }),
        });
        const created = await api.post<{ code: string }>("/api/content/series", body);
        const job = startJob("drama", picked.map((file) => file.name), async (job) => {
          job.code = created.code;
          return uploadEpisodes(api, job, created.code, args.title, picked, 1);
        });
        return started(job, created.code);
      },
    ),
  );

  server.registerTool(
    "add_episodes",
    {
      title: "Add Episodes",
      description: "Add episodes to the end of an existing drama, numbered after the ones it has. People who bought it see them too.",
      inputSchema: { code, episodes: files },
    },
    handle(async ({ code, episodes }: { code: string; episodes: string | string[] }) => {
      const picked = await pickFiles(episodes, VIDEO_EXTENSIONS);
      const { item } = await api.get<{ item: { title: string; series: { total: number; maxEpisodes: number } | null } }>(`/api/content/${code}`);
      if (!item.series) throw new Error(`${code} is not a drama.`);
      if (item.series.total + picked.length > item.series.maxEpisodes) {
        throw new Error(`The drama has ${item.series.total} episodes and holds at most ${item.series.maxEpisodes}.`);
      }
      const job = startJob("episodes", picked.map((file) => file.name), async (job) => {
        job.code = code;
        return uploadEpisodes(api, job, code, item.title, picked, item.series!.total + 1);
      });
      return started(job, code, { firstNumber: item.series.total + 1 });
    }),
  );

  server.registerTool(
    "get_upload_job",
    {
      title: "Get Upload Job",
      description: "How an upload started by create_gallery, add_images, create_video, create_drama or add_episodes is going. Without jobId: the recent jobs.",
      inputSchema: { jobId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    handle(async ({ jobId }: { jobId?: string }) => {
      if (!jobId) return { jobs: listJobs().map(jobSummary) };
      const job = getJob(jobId);
      if (!job) throw new Error("No such job. Jobs last only while this MCP server runs.");
      return jobSummary(job);
    }),
  );

  server.registerTool(
    "list_content",
    {
      title: "List Content",
      description: "The account's Content items (galleries, videos, dramas), newest first, ten a page.",
      inputSchema: { cursor: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    handle(({ cursor }: { cursor?: string }) => api.get(`/api/content${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)),
  );

  server.registerTool(
    "get_content",
    {
      title: "Get Content Item",
      description: "One Content item: its state (uploading, processing, ready), paywall and, for a drama, how many episodes are ready.",
      inputSchema: { code },
      annotations: { readOnlyHint: true },
    },
    handle(({ code }: { code: string }) => api.get(`/api/content/${code}`)),
  );
}

type ImageGrant = { id: string; url: string };
type DescribedImage = { file: LocalFile; type: string; request: { type: string; size: number; width?: number; height?: number } };
type GalleryImage = { id: string; uploaded: boolean };

// What the API is told about each picture before it signs: its type read from the bytes, its size and pixels.
async function describeImages(picked: LocalFile[]): Promise<DescribedImage[]> {
  return Promise.all(
    picked.map(async (file) => {
      if (file.size > IMAGE_MAX_BYTES) throw new Error(`Larger than 20 MB: ${file.name}`);
      const type = await imageType(file.path);
      if (!type) throw new Error(`Not a JPEG, PNG, WebP, GIF or AVIF picture: ${file.name}`);
      const pixels = await imagePixels(file.path);
      return { file, type, request: { type, size: file.size, ...(pixels ?? {}) } };
    }),
  );
}

// Puts each picture to its grant, a few at a time, then has the API look in the zone for what arrived.
// Returns every picture of the gallery as the API now sees it.
async function sendGallery(api: Api, job: Job, code: string, described: DescribedImage[], grants: ImageGrant[]): Promise<GalleryImage[]> {
  const queue = described.map((entry, index) => ({ ...entry, grant: grants[index]!, item: job.items[index]! }));
  const workers = Array.from({ length: IMAGE_CONCURRENCY }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { file, type, grant, item } = next;
      await runItem(item, async () => sendImage(grant.url, file.path, type));
    }
  });
  await Promise.all(workers);

  // Bunny can take a moment to show a file that was just written, so ask again a few times.
  let images: GalleryImage[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await wait(1500 * attempt);
    images = (await api.post<{ images: GalleryImage[] }>(`/api/content/${code}/images/confirm`)).images;
    if (grants.every((grant) => images.find((image) => image.id === grant.id)?.uploaded !== false)) break;
  }
  return images;
}

function galleryMessage(images: GalleryImage[], grants: ImageGrant[], takesOrders: string): string {
  const sent = grants.filter((grant) => images.some((image) => image.id === grant.id && image.uploaded)).length;
  const missing = grants.length - sent;
  return (
    `${sent} of ${grants.length} pictures arrived.` +
    (images.some((image) => image.uploaded) ? takesOrders : "") +
    (missing > 0 ? ` Send the ${missing} that didn't with add_images.` : "")
  );
}

const RESIGN_BEFORE_S = 30 * 60;
const freshGrant = async (api: Api, code: string, episodeId: string) =>
  (await api.post<{ upload: UploadGrant }>(`/api/content/${code}/episodes/${episodeId}/upload`)).upload;

// Episodes in parts of EPISODES_PER_REQUEST, as the dashboard sends them: each part is made, then its
// files go up one after another, before the next part is asked for. A part that can't be made stops the
// job, keeping every episode already uploaded.
async function uploadEpisodes(api: Api, job: Job, code: string, title: string, picked: LocalFile[], first: number): Promise<string> {
  let uploaded = 0;
  for (let start = 0; start < picked.length; start += EPISODES_PER_REQUEST) {
    const part = picked.slice(start, start + EPISODES_PER_REQUEST);
    let uploads: { id: string; upload: UploadGrant }[];
    try {
      ({ uploads } = await api.post<{ uploads: { id: string; upload: UploadGrant }[] }>(`/api/content/${code}/episodes`, {
        files: part.map((file) => ({ name: file.name })),
      }));
    } catch (error) {
      // The drama itself exists, so what was skipped goes after the episodes it has.
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason} ${uploaded} of ${picked.length} episodes uploaded; send the ones skipped to ${code} with add_episodes.`);
    }
    for (const [index, file] of part.entries()) {
      const number = first + start + index;
      const ok = await runItem(job.items[start + index]!, async (onPercent) => {
        // A part's grants are signed when it is made (6 hours); on a slow connection the last episodes
        // of a part may start after that, so an almost-spent grant is signed again first.
        const grant = uploads[index]!.upload.expires - Date.now() / 1000 > RESIGN_BEFORE_S ? uploads[index]!.upload : await freshGrant(api, code, uploads[index]!.id);
        await sendVideo(file.path, grant, `${title} · ${number}`, videoType(file.path), onPercent);
      });
      if (ok) uploaded++;
    }
  }
  return `${uploaded} of ${picked.length} episodes uploaded. Bunny encodes each one; check get_content for how many are ready.`;
}

import { randomUUID } from "node:crypto";

// Uploads that outlive one tool call. A tool starts a job and returns its id at once; the agent asks
// get_upload_job how it is going. Jobs live in this process only: when the MCP server stops, so do they.

export type ItemState = "queued" | "uploading" | "done" | "failed" | "skipped";
export type JobItem = { name: string; state: ItemState; percent: number; error?: string };
export type Job = {
  id: string;
  kind: string;
  // The Content item the job fills, once it exists.
  code: string | null;
  state: "running" | "done" | "failed";
  items: JobItem[];
  message: string | null;
  startedAt: string;
  endedAt: string | null;
};

const KEEP = 20;
const jobs = new Map<string, Job>();

export function startJob(kind: string, names: string[], work: (job: Job) => Promise<string | null>): Job {
  const job: Job = {
    id: randomUUID(),
    kind,
    code: null,
    state: "running",
    items: names.map((name) => ({ name, state: "queued", percent: 0 })),
    message: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  jobs.set(job.id, job);
  for (const old of [...jobs.keys()].slice(0, Math.max(0, jobs.size - KEEP))) jobs.delete(old);

  void work(job).then(
    (message) => finish(job, message),
    (error: unknown) => finish(job, error instanceof Error ? error.message : String(error), true),
  );
  return job;
}

function finish(job: Job, message: string | null, failed = false) {
  // Anything never reached is left as skipped, so the summary says what didn't go.
  for (const item of job.items) if (item.state === "queued" || item.state === "uploading") item.state = "skipped";
  job.state = failed || job.items.some((item) => item.state === "failed" || item.state === "skipped") ? "failed" : "done";
  job.message = message;
  job.endedAt = new Date().toISOString();
}

export const getJob = (id: string) => jobs.get(id) ?? null;
export const listJobs = () => [...jobs.values()].reverse();

// Runs one item's upload, recording its state and progress; a failure is recorded, not thrown, so the
// rest of the job goes on.
export async function runItem(item: JobItem, upload: (onPercent: (percent: number) => void) => Promise<void>): Promise<boolean> {
  item.state = "uploading";
  item.percent = 0;
  try {
    await upload((percent) => (item.percent = percent));
    item.state = "done";
    item.percent = 100;
    return true;
  } catch (error) {
    item.state = "failed";
    item.error = error instanceof Error ? error.message : String(error);
    return false;
  }
}

// What get_upload_job shows: the counts first, then every file that isn't simply done.
export function jobSummary(job: Job) {
  const count = (state: ItemState) => job.items.filter((item) => item.state === state).length;
  return {
    id: job.id,
    kind: job.kind,
    code: job.code,
    state: job.state,
    message: job.message,
    total: job.items.length,
    done: count("done"),
    uploading: job.items.filter((item) => item.state === "uploading").map((item) => ({ name: item.name, percent: item.percent })),
    queued: count("queued"),
    failed: job.items.filter((item) => item.state === "failed").map((item) => ({ name: item.name, error: item.error })),
    skipped: job.items.filter((item) => item.state === "skipped").map((item) => item.name),
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  };
}

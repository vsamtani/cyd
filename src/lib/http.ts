import { createWriteStream } from "node:fs";
import { rename, mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname } from "node:path";
import {
  USER_AGENT,
  MIN_REQUEST_INTERVAL_MS,
  MAX_RETRIES,
} from "../config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Process-wide rate limiter. Every request (HEAD or GET, from any module)
 * goes through this single promise chain, so concurrent callers can never
 * exceed SEC's fair-access limit.
 */
let gate: Promise<void> = Promise.resolve();
function rateLimit(): Promise<void> {
  const prev = gate;
  let release!: () => void;
  gate = new Promise<void>((r) => (release = r));
  return prev.then(async () => {
    await sleep(MIN_REQUEST_INTERVAL_MS);
    release();
  });
}

const baseHeaders = {
  "User-Agent": USER_AGENT,
  "Accept-Encoding": "gzip, deflate",
};

function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  // Exponential backoff with jitter: ~1s, 2s, 4s, ...
  return 2 ** attempt * 1000 + Math.floor(Math.random() * 250);
}

/** Perform a rate-limited fetch with retry/backoff on 429 and 5xx. */
export async function secFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await rateLimit();
    try {
      const res = await fetch(url, {
        ...init,
        headers: { ...baseHeaders, ...(init.headers ?? {}) },
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const wait = retryAfterMs(res, attempt);
          process.stderr.write(
            `  ${res.status} on ${url} — retrying in ${Math.round(wait)}ms\n`,
          );
          await res.body?.cancel();
          await sleep(wait);
          continue;
        }
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const wait = 2 ** attempt * 1000;
        process.stderr.write(
          `  network error on ${url} — retrying in ${wait}ms\n`,
        );
        await sleep(wait);
        continue;
      }
    }
  }
  throw new Error(`Request failed after ${MAX_RETRIES} retries: ${url}`, {
    cause: lastErr,
  });
}

/** Returns content-length (bytes) if the URL exists, else null (404/etc.). */
export async function head(
  url: string,
): Promise<{ ok: boolean; contentLength: number | null }> {
  const res = await secFetch(url, { method: "HEAD" });
  await res.body?.cancel();
  if (!res.ok) return { ok: false, contentLength: null };
  const len = res.headers.get("content-length");
  return { ok: true, contentLength: len ? Number(len) : null };
}

/** Download a URL to a file, writing to a temp path then atomically renaming. */
export async function download(url: string, destPath: string): Promise<number> {
  const res = await secFetch(url);
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  await mkdir(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.partial`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  await rename(tmp, destPath);
  const len = res.headers.get("content-length");
  return len ? Number(len) : 0;
}

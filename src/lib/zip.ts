import yauzl from "yauzl";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/** Open a single named entry inside a zip as a readable stream (streaming, no full extraction). */
function openEntryStream(zipPath: string, entryName: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("failed to open zip"));
      let found = false;
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName === entryName) {
          found = true;
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return reject(e ?? new Error("no stream"));
            stream.on("end", () => zip.close());
            resolve(stream);
          });
        } else {
          zip.readEntry();
        }
      });
      zip.on("end", () => {
        if (!found) reject(new Error(`entry "${entryName}" not found in ${zipPath}`));
      });
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** Yield each line (\n-terminated) of a named entry inside a zip. */
export async function* streamEntryLines(
  zipPath: string,
  entryName: string,
): AsyncGenerator<string> {
  const stream = await openEntryStream(zipPath, entryName);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

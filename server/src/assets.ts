import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rename, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Database } from "./db.js";

const maxBytes = 20 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

type Asset = { id: string; filename: string; size_bytes: number; source: string; created_at_ms: number };

export class HTTPError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function displayName(value: string) {
  const name = (value.split(/[/\\]/).at(-1) ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return [...name].slice(0, 200).join("") || "attachment";
}

export class Assets {
  constructor(private readonly directory: string, private readonly db: Database) {}

  list() {
    return this.db.all<Asset>("SELECT id,filename,size_bytes,source,created_at_ms FROM assets ORDER BY created_at_ms DESC,id");
  }

  async cleanInterruptedWrites() {
    const ids = new Set((await this.db.all<{ id: string }>("SELECT id FROM assets")).map(({ id }) => id));
    for (const entry of await readdir(this.directory)) {
      if (entry.startsWith(".tmp-") || (uuid.test(entry) && !ids.has(entry))) {
        await rm(join(this.directory, entry), { recursive: true, force: true });
      }
    }
  }

  async upload(request: IncomingMessage) {
    if (!request.headers["content-type"]?.startsWith("application/octet-stream")) {
      throw new HTTPError(415, "Upload a file from the Files section.");
    }
    const rawName = request.headers["x-whatsapp-filename"];
    if (typeof rawName !== "string" || rawName.length > 4096) throw new HTTPError(400, "Missing or invalid filename.");
    let filename: string;
    try { filename = displayName(decodeURIComponent(rawName)); }
    catch { throw new HTTPError(400, "Invalid filename."); }
    if (Number(request.headers["content-length"]) > maxBytes) {
      request.resume();
      throw new HTTPError(413, "Files must be 20 MiB or smaller.");
    }
    const id = randomUUID();
    const temporary = join(this.directory, ".tmp-upload-" + id);
    const final = join(this.directory, id);
    const file = await open(temporary, "wx", 0o600);
    let size = 0;
    let published = false;
    let registered = false;
    try {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxBytes) {
          request.resume();
          throw new HTTPError(413, "Files must be 20 MiB or smaller.");
        }
        for (let offset = 0; offset < chunk.length;) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw new Error("Could not write upload");
          offset += bytesWritten;
        }
      }
      if (!request.complete) throw new HTTPError(400, "The upload was interrupted.");
      await file.sync();
      await rename(temporary, final);
      published = true;
      const created_at_ms = Date.now();
      await this.db.run(`INSERT INTO assets(id,filename,source,content_type,size_bytes,created_at_ms)
        VALUES(?,?,'upload','application/octet-stream',?,?)`, id, filename, size, created_at_ms);
      registered = true;
      return { id, filename, size_bytes: size, source: "upload", created_at_ms };
    } finally {
      await file.close().catch(() => {});
      if (!registered) await rm(published ? final : temporary, { force: true }).catch(() => {});
    }
  }

  async download(id: string, response: ServerResponse) {
    if (!uuid.test(id)) throw new HTTPError(404, "File not found.");
    const asset = await this.db.get<Asset>("SELECT filename,size_bytes FROM assets WHERE id=?", id);
    if (!asset) throw new HTTPError(404, "File not found.");
    const file = await open(join(this.directory, id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch(() => { throw new HTTPError(404, "File not found."); });
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== asset.size_bytes) throw new HTTPError(404, "File not found.");
      const filename = encodeURIComponent(asset.filename).replace(/['()*]/g, (char) => "%" + char.charCodeAt(0).toString(16));
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": asset.size_bytes,
        "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${filename}`,
      });
      await pipeline(file.createReadStream(), response);
    } finally {
      await file.close().catch(() => {});
    }
  }
}

import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { Database } from "./db.js";

export const dashboardURL = "http://localhost:7865";
type CommandKind = "send" | "send_file" | "send_audio" | "download";
type CommandRow = {
  id: string;
  kind: string;
  payload_json: string;
  status: string;
  result_json: string | null;
};

export class Operations {
  constructor(private readonly db: Database, private readonly currentState: () => string) {}

  async status(id: string) {
    const row = await this.db.get<CommandRow>("SELECT * FROM commands WHERE id=?", id);
    if (!row) return { status: "not_found", command_id: id };
    const result: Record<string, unknown> = row.result_json ? JSON.parse(row.result_json) : {};
    if (row.status === "unknown" && !result.message) {
      result.message = "Delivery may have occurred. Check the chat before retrying.";
    }
    if (row.status === "expired" && !result.message) {
      result.message = "The command expired before the bridge started it.";
    }
    if (typeof result.file_id === "string") {
      result.url = `${dashboardURL}/api/assets/${encodeURIComponent(result.file_id)}`;
    }
    return { ...result, status: row.status, command_id: row.id };
  }

  async submit(kind: CommandKind, args: Record<string, string>, key: string = randomUUID()) {
    const payload = JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))));
    let row = await this.findByKey(key);
    if (!row) {
      const state = this.currentState();
      if (state !== "connected") return { status: state, reconnect_url: dashboardURL };
      const id = randomUUID();
      const now = Date.now();
      row = await this.db.get<CommandRow>(`INSERT INTO commands
        (id,idempotency_key,kind,payload_json,status,created_at_ms,expires_at_ms)
        VALUES(?,?,?,?,'pending',?,?) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
        id, key, kind, payload, now, now + 120_000) ?? await this.findByKey(key);
    }
    if (!row || row.kind !== kind || row.payload_json !== payload) {
      return { status: "conflict", message: "That idempotency key already belongs to a different operation." };
    }

    const deadline = Date.now() + 15_000;
    do {
      const result = await this.status(row.id);
      if (result.status !== "pending" && result.status !== "running") return result;
      if (this.currentState() === "stopping") break;
      await setTimeout(300);
    } while (Date.now() < deadline);

    return {
      status: "pending",
      command_id: row.id,
      message: "Check get_operation_status for this command before considering another send.",
    };
  }

  private findByKey(key: string) {
    return this.db.get<CommandRow>("SELECT * FROM commands WHERE idempotency_key=?", key);
  }
}

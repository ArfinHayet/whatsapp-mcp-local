import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const db = new DatabaseSync(workerData.file, { allowExtension: false });
db.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
db.function("fold", { deterministic: true }, (value) => String(value ?? "").normalize("NFKC").toLowerCase());
db.function("jid_user", { deterministic: true }, (value) => String(value ?? "").split("@", 1)[0]);

const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
if (version > 1) throw new Error("Database version is newer than this app");
if (version === 0) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(readFileSync(workerData.migration, "utf8"));
    db.exec("PRAGMA user_version=1; COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const port = parentPort!;
port.on("message", ({ id, method, sql, args }: {
  id: number;
  method: "all" | "get" | "run" | "close";
  sql: string;
  args: SQLInputValue[];
}) => {
  try {
    if (method === "close") {
      db.close();
      port.postMessage({ id });
      port.close();
      return;
    }
    const statement = db.prepare(sql);
    port.postMessage({ id, result: statement[method](...args) });
  } catch (error) {
    port.postMessage({ id, error: (error as Error).message });
  }
});
port.postMessage({ ready: true });

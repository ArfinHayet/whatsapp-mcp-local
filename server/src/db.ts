import type { SQLInputValue } from "node:sqlite";
import { Worker } from "node:worker_threads";

type Request = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class Database {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Request>();
  private next = 0;
  private failure?: Error;
  readonly ready: Promise<void>;

  constructor(file: string, migration: string) {
    this.worker = new Worker(new URL("./db-worker.js", import.meta.url), { workerData: { file, migration } });
    this.ready = new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        this.failure = error;
        reject(error);
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
      };
      this.worker.on("error", fail);
      this.worker.on("exit", () => fail(new Error("Database worker exited")));
      this.worker.on("message", ({ ready, id, result, error }) => {
        if (ready) resolve();
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        if (error) request.reject(new Error(error));
        else request.resolve(result);
      });
    });
  }

  all<T>(sql: string, ...args: SQLInputValue[]): Promise<T[]> {
    return this.request("all", sql, args) as Promise<T[]>;
  }

  get<T>(sql: string, ...args: SQLInputValue[]): Promise<T | undefined> {
    return this.request("get", sql, args) as Promise<T | undefined>;
  }

  run(sql: string, ...args: SQLInputValue[]) {
    return this.request("run", sql, args);
  }

  async close() {
    try {
      await this.request("close", "", []);
    } finally {
      await this.worker.terminate();
    }
  }

  private request(method: string, sql: string, args: SQLInputValue[]) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.next;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, sql, args });
    });
  }
}

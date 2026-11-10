import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";

type QR = { code: string; expiresAtMs: number };

export class Bridge {
  private child?: ChildProcessByStdio<Writable, Readable, null>;
  private exited?: Promise<void>;
  state = "starting";
  pairingError?: string;
  qr?: QR;

  start(binary: string, data: string, ffmpeg: string, onFirstState: () => void, onUnexpectedExit: () => void) {
    const child = spawn(binary, ["--data-dir", data, "--ffmpeg", ffmpeg], { stdio: ["pipe", "pipe", "inherit"] });
    this.child = child;
    let receivedState = false;
    let stopping = false;
    this.exited = new Promise((resolve) => {
      child.once("close", () => {
        this.child = undefined;
        this.qr = undefined;
        this.state = "worker_unavailable";
        resolve();
        if (!stopping) onUnexpectedExit();
      });
    });
    this.stopRequested = () => { stopping = true; };
    child.on("error", () => console.error("Could not start the Go bridge."));
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.type === "state" && typeof message.state === "string") {
          this.state = message.state;
          this.pairingError = this.state === "pairing_required" && typeof message.reason === "string"
            ? message.reason || undefined : undefined;
          if (this.state !== "pairing") this.qr = undefined;
          if (!receivedState) {
            receivedState = true;
            onFirstState();
          }
        } else if (message.type === "qr" && this.state === "pairing" && typeof message.code === "string") {
          this.qr = { code: message.code, expiresAtMs: message.expiresAtMs };
        }
      } catch {
        console.error("Bridge emitted an invalid control message.");
      }
    });
  }

  pair() {
    this.send("pair");
  }

  private stopRequested = () => {};

  async stop() {
    const child = this.child;
    const exited = this.exited;
    if (!child || !exited) return;
    this.stopRequested();
    this.send("drain");
    if (await Promise.race([exited.then(() => true), setTimeout(7000, false, { ref: false })])) return;
    child.kill("SIGTERM");
    if (await Promise.race([exited.then(() => true), setTimeout(4000, false, { ref: false })])) return;
    child.kill("SIGKILL");
    await exited;
  }

  private send(type: string) {
    if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify({ type }) + "\n");
  }
}

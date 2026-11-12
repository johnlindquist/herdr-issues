// Store: Triage's own files, one folder per project under the state dir. Never the project's.
//   triage.json     the last refresh (summary, groups' hashes, timings) — what `show` prints
//   dismissed.json  ids the person dismissed
//   receipts.jsonl  one line per action taken
//   lock            held while a refresh runs (busy)

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

export const defaultStateDir = () => process.env.TRIAGE_STATE || path.join(os.homedir(), ".cache/herdr-triage/default");
export const projectKey = (root) => root.replace(/[^A-Za-z0-9_-]/g, "_").slice(-120);

export function storeFor(stateDir, root) {
  const dir = path.join(stateDir, "projects", projectKey(root));
  const f = (n) => path.join(dir, n);
  return {
    dir,
    async read(name, fallback) {
      try {
        return JSON.parse(await fs.readFile(f(name), "utf8"));
      } catch {
        return fallback;
      }
    },
    async write(name, value) {
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${f(name)}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value, null, 1));
      await fs.rename(tmp, f(name));
    },
    async receipt(r) {
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(f("receipts.jsonl"), JSON.stringify(r) + "\n");
    },
    busy() {
      try {
        const st = fsSync.statSync(f("lock"));
        return Date.now() - st.mtimeMs < 3 * 60_000; // a lock older than 3 minutes is from a dead run
      } catch {
        return false;
      }
    },
    async withLock(fn) {
      await fs.mkdir(dir, { recursive: true });
      if (this.busy()) return { busy: true };
      await fs.writeFile(f("lock"), String(process.pid));
      try {
        return await fn();
      } finally {
        await fs.rm(f("lock"), { force: true });
      }
    },
  };
}

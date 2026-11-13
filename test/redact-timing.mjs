// Run in its own process by review2.test.mjs (so a stall is killed from outside): time redact() on adversarial 4 MB strings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as G from "../src/gatherers.mjs";
const MB4 = 4_000_000;
const rep = (s) => s.repeat(Math.ceil(MB4 / s.length)).slice(0, MB4);
const CASES = {
  "one long word": rep("a"),
  "one long word, not hex": rep("g"),
  "dotted word": rep("a."),
  "dashed word": rep("z-"),
  "long word then a credential name": rep("q").slice(0, MB4 - 20) + " password: hunter2",
  "credential names back to back": rep("password"),
  "credential names with separators": rep("password:"),
  "token token token": rep("token "),
  "an unclosed quoted value": 'password="' + rep("x "),
  "an unclosed quoted value, one line": "secret: '" + rep("y"),
  "a yaml block of 4 MB": "password: |\n" + rep("  line of secret\n"),
  "jwt starts": rep("eyJaaaaaaaa-"),
  "token prefixes": rep("sk-"),
  "url starts": rep("://"),
  "url userinfo starts": rep("http://a:"),
  "at signs": rep("x@"),
  "almost e-mail": rep("a.b+c-"),
  "bearer starts": rep("bearer "),
  "key block starts": rep("-----BEGIN PRIVATE KEY-----"),
  "home paths": rep("/Users/"),
  "backslashes and quotes": rep('token:\\"'),
  "spaces": "password" + rep(" "),
  "newlines": "password:" + rep("\n"),
};
const out = {};
for (const [name, text] of Object.entries(CASES)) {
  const t0 = Date.now();
  const r = G.redact(text);
  out[name] = Date.now() - t0;
  if (typeof r !== "string") throw new Error("redact did not return a string");
}
// Through the real reader: one session whose single message is 3.9 MB.
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "timing-")));
const project = path.join(base, "p");
fs.mkdirSync(project);
const dir = G.sessionsDirFor(project, path.join(base, "agent"));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "2026-11-01T10-00-00-000Z_s1.jsonl"), [JSON.stringify({ type: "session", cwd: project }), JSON.stringify({ type: "message", message: { role: "user", content: "closed checkout " + rep("a").slice(0, 3_900_000) } })].join("\n") + "\n");
const t0 = Date.now();
const got = await G.fetchConversations({ root: project, agentDir: path.join(base, "agent"), terms: ["closed"], conversations: { mode: "on", of: null } });
out["a 3.9 MB message through fetchConversations"] = Date.now() - t0;
if (got.items.length !== 1) throw new Error("the big message was not read");
process.stdout.write(JSON.stringify(out));

// Redaction, and the one door past-conversation text goes through.
//
// Text read from a past conversation is wrapped in Raw the moment it is read. Raw cannot be
// printed, joined, concatenated or serialised (each throws), and it has no readable field, so it
// cannot reach a model call, a cache file, a receipt, the brief view or Main's prompt by accident.
// The only way to get a string out is redactRaw(), which redacts first. redact() is the single
// pure function that does the redacting; nothing else in the widget removes secrets.

const TEXT = new WeakMap();
const refuse = () => {
  throw new TypeError("raw conversation text cannot be used as a string: pass it through redactRaw() first");
};

/** Text straight from a past conversation. Opaque on purpose. */
export class Raw {
  constructor(text) {
    TEXT.set(this, String(text ?? ""));
    Object.freeze(this);
  }
  toString() {
    return refuse();
  }
  toJSON() {
    return refuse();
  }
  [Symbol.toPrimitive]() {
    return refuse();
  }
}
export const raw = (text) => new Raw(text);

/** The one door: raw conversation text in, redacted string out. */
export function redactRaw(x) {
  if (!(x instanceof Raw)) throw new TypeError("redactRaw takes only raw conversation text (Raw)");
  return redact(TEXT.get(x));
}

const R = "[redacted]";

// ---------- 1. named credentials: find the name, then redact to the end of its VALUE ----------
// One pass over the text, linear in its length: names are found among word tokens (each looked at
// once, long tokens skipped), and a value is read by a small tokenizer, never by one big regexp.

/** A word that says its value is a credential. Tested on one token of at most 120 characters. */
const CRED = /pass(?:word|wd|phrase|code)|^pass$|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth(?![a-z])|credential|cookie|session[_-]?id|signature/i;
/** Header names whose whole line is the credential. */
const HEADER = /^(?:(?:proxy-)?authorization|(?:set-)?cookie|x-[\w-]*(?:key|token|auth|secret)[\w-]*)$/i;
/** Names after which "is <value>" / "was <value>" is read as a value ("the password is …"). */
const SPOKEN = /^(?:pass(?:word|code|phrase)|pwd|secret|token|pin|api[_-]?key)$/i;
const SP = (c) => c === " " || c === "\t";
const eol = (s, i) => {
  const n = s.indexOf("\n", i);
  return n < 0 ? s.length : n;
};

/** Where the line holding `at` starts, looking back at most 60 characters (bounded, so one long line costs nothing). -1: further back than that. */
function lineStart(s, at) {
  for (let i = at - 1, n = 0; n <= 60; i--, n++) {
    if (i < 0) return 0;
    if (s[i] === "\n") return i + 1;
  }
  return -1;
}

/**
 * The value that follows a credential name ending at `i`: [from, to), or null when no value follows.
 * Shapes: quoted (with escapes, over several lines, triple-quoted, backticks, quotes escaped inside
 * a JSON string), a YAML block scalar (| or >), a header (the rest of the line), a value on a line
 * of its own (the rest of the line), otherwise up to the next whitespace.
 */
function valueSpan(s, keyStart, i, tok) {
  let p = i;
  for (let n = 0; n < 4 && p < s.length && "\\\"'`])".includes(s[p]); n++) p++; // the name's own closing quote or bracket
  while (p < s.length && SP(s[p])) p++;
  let sep = null;
  if (s.startsWith("=>", p) || s.startsWith(":=", p)) sep = s.slice(p, p + 2);
  else if (s[p] === ":" || s[p] === "=") sep = s[p];
  if (sep) p += sep.length;
  else {
    if (p === i || !SPOKEN.test(tok)) return null;
    const w = s.startsWith("is", p) ? 2 : s.startsWith("was", p) ? 3 : 0;
    if (!w || !SP(s[p + w] ?? "")) return null;
    p += w;
  }
  while (p < s.length && SP(s[p])) p++;
  if (p >= s.length || s[p] === "\n" || s[p] === "\r") return null;
  if (s.startsWith(R, p)) return { from: p, to: p + R.length }; // already redacted: leave what follows alone
  if (sep === ":" && HEADER.test(tok)) return { from: p, to: eol(s, p) };
  // a YAML block scalar: every following line indented deeper than the name's own line
  if (s[p] === "|" || s[p] === ">") {
    let q = p + 1;
    while (q < s.length && q < p + 4 && "+-0123456789".includes(s[q])) q++;
    while (q < s.length && SP(s[q])) q++;
    if (s[q] === "\n") {
      const ls = lineStart(s, keyStart);
      let indent = 0;
      if (ls >= 0) while (SP(s[ls + indent] ?? "")) indent++;
      let end = q; // the newline that ends the last line of the block
      let line = q + 1;
      while (line < s.length) {
        let lead = 0;
        while (SP(s[line + lead] ?? "")) lead++;
        const stop = eol(s, line);
        const blank = line + lead >= stop;
        if (!blank && lead <= indent) break;
        end = stop;
        line = stop + 1;
      }
      return { from: p, to: end };
    }
  }
  // quoted: backslashes then a quote open it; the same sequence closes it
  let b = p;
  while (b < s.length && b < p + 6 && s[b] === "\\") b++;
  const q = s[b];
  if (q === '"' || q === "'" || q === "`") {
    const triple = b === p && s.startsWith(q.repeat(3), b);
    const opener = triple ? q.repeat(3) : s.slice(p, b + 1);
    const start = p + opener.length;
    let close = -1;
    if (opener.length > 1) close = s.indexOf(opener, start);
    else for (let k = start, n = 0; k < s.length && n < 8192; k++, n++) {
      if (s[k] === "\\") k++, n++;
      else if (s[k] === q) {
        close = k;
        break;
      }
    }
    return close >= 0 ? { from: p, to: close + opener.length } : { from: p, to: eol(s, p) }; // never closed: the rest of the line
  }
  // on a line of its own (YAML, an env file): the rest of the line, so a value with spaces goes whole
  const ls = lineStart(s, keyStart);
  if (ls >= 0 && /^[ \t]*(?:export[ \t]+|set[ \t]+|-[ \t]+)?["']?$/.test(s.slice(ls, keyStart))) return { from: p, to: eol(s, p) };
  let e = p;
  while (e < s.length && !/\s/.test(s[e])) e++;
  return { from: p, to: e };
}

function redactNamed(s) {
  const out = [];
  let last = 0;
  const word = /[A-Za-z0-9_.-]+/g; // consumes each run once: linear
  let m;
  while ((m = word.exec(s))) {
    const tok = m[0];
    if (tok.length > 120 || !CRED.test(tok)) continue;
    const v = valueSpan(s, m.index, word.lastIndex, tok);
    if (!v || v.to <= v.from) continue;
    out.push(s.slice(last, v.from), R);
    last = v.to;
    word.lastIndex = Math.max(word.lastIndex, v.to);
  }
  if (!last) return s;
  out.push(s.slice(last));
  return out.join("");
}

// ---------- 2. credentials recognised by their shape ----------
// Every rule is a fixed start followed by one greedy run that is consumed whether or not it is
// replaced, so no rule can look at the same character from many starting points.

const mixed = (m) => /[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m);
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const SHAPES = [
  // URLs: any user or user:password before the host
  [/:\/\/[^\s/]*/g, (m) => (m.lastIndexOf("@") > 2 ? `://${R}@${m.slice(m.lastIndexOf("@") + 1)}` : m)],
  // bearer and basic credentials anywhere
  [/\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1$2${R}`],
  // well-known token shapes
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{12,}/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_\w{20,}/g, R],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\bxox[abprs]-[\w-]{10,}/g, R],
  [/\beyJ[\w.-]{16,}/g, (m) => (m.split(".").length >= 3 ? R : m)],
  // long hex, long base64, and long strings that mix cases and digits (random-looking, not a word or a path)
  [/\b[0-9a-f]{32,}\b/gi, R],
  [/[A-Za-z0-9+/]{40,}={0,2}/g, (m) => (mixed(m) ? R : m)],
  [/\b[A-Za-z0-9+_=-]{20,}/g, (m) => (mixed(m) ? R : m)],
  // e-mail addresses (inside one run of address characters; an absurdly long run goes whole)
  [/[\w.+@-]+/g, (m) => (!m.includes("@") ? m : m.length > 320 ? R : m.replace(EMAIL, "[email]"))],
  // home folders
  [/(?:\/Users|\/home)\/[^/\s"'`)]+/g, "~"],
  [/[A-Z]:\\Users\\[^\\\s"']+/g, "~"],
];

/**
 * Secrets, tokens, keys, credentials in URLs and headers, e-mail addresses and home paths out.
 * Pure; linear in the length of the text; redacting twice changes nothing. Redact first, cut to
 * length afterwards: cutting first can leave half a secret that no rule recognises.
 */
export function redact(text) {
  let s = String(text ?? "");
  // private key blocks, closed or cut off
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, R);
  s = redactNamed(s);
  for (const [re, to] of SHAPES) s = s.replace(/** @type {RegExp} */ (re), /** @type {any} */ (to));
  return s;
}

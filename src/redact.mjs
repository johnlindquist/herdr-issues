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
// A name that says its value is a credential: password, passwd, pwd, passphrase, secret, token, api key, access key, private key, auth, credential, cookie, session id, signature.
const KEY = "[\\w.-]*(?:pass(?:word|wd|phrase|code)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth(?![a-z])|credential|cookie|session[_-]?id|signature)[\\w.-]*";
const mixed = (m) => /[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m);

/** Each step: what it finds, and what it leaves. Order matters (blocks and headers before single values). */
const STEPS = [
  // private key blocks, closed or cut off
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, R],
  // HTTP headers that carry credentials: the rest of the line (or up to a closing quote)
  [/\b((?:proxy-)?authorization|(?:set-)?cookie|x-[\w-]*(?:key|token|auth|secret)[\w-]*)(\s*:\s*)[^\n'"]+/gi, `$1$2${R}`],
  // URLs with a user and password
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${R}@`],
  // name = value, name: value, "name": "value", name => 'value' (the name quoted or not, the value quoted or not)
  [new RegExp(`(["']?)(${KEY})\\1(\\s*(?:=>|[:=])\\s*)(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s,;}'"]+)`, "gi"), `$1$2$1$3${R}`],
  // "the password is hunter2"
  [/\b(pass(?:word|code|phrase)|pwd|secret|token|api key|pin)(\s+(?:is|was)\s+)\S+/gi, `$1$2${R}`],
  // bearer and basic credentials anywhere
  [/\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1$2${R}`],
  // well-known token shapes
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{12,}/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_\w{20,}/g, R],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\bxox[abprs]-[\w-]{10,}/g, R],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, R],
  // long hex, long base64, and long strings that mix cases and digits (random-looking, not a word or a path)
  [/\b[0-9a-f]{32,}\b/gi, R],
  [/[A-Za-z0-9+/]{40,}={0,2}/g, (m) => (mixed(m) ? R : m)],
  [/\b[A-Za-z0-9+_=-]{20,}/g, (m) => (mixed(m) ? R : m)],
  // e-mail addresses and home folders
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/(?:\/Users|\/home)\/[^/\s"'`)]+/g, "~"],
  [/[A-Z]:\\Users\\[^\\\s"']+/g, "~"],
];

/** Secrets, tokens, keys, credentials in URLs and headers, e-mail addresses and home paths out. Pure; redacting twice changes nothing. */
export function redact(text) {
  let s = String(text ?? "");
  for (const [re, to] of STEPS) s = s.replace(/** @type {RegExp} */ (re), /** @type {any} */ (to));
  return s;
}

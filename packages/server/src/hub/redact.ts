/**
 * Redaction of a verify run's log before it leaves this machine (RFC-002).
 *
 * The log is whatever the test suite printed, and a verification receipt
 * carries it to the hub, where every CI job holding a token for the repository
 * can download it. What must not go with it: secrets in the formats we know,
 * values assigned to secret-named keys, this machine's own secret environment
 * values (the verify command inherits them, and a test that echoes one prints
 * it in a format no pattern knows), and the username in the home directory.
 *
 * Everything else stays exactly as printed, so the log still reads as the run
 * it was. Each redaction is a visible `[REDACTED:<kind>]`, never a silent gap:
 * a reader must be able to tell a scrubbed log from a short one.
 *
 * Every pattern is BOUNDED, and the one block that can span lines (a private
 * key) is found by a scan, not a lazy regex: a log can be 32 MiB of anything,
 * and an unbounded pattern on malformed input rescans the rest of the log from
 * every starting point, blocking the server (Codex review).
 *
 * This is best effort against accidents, not a guarantee: a secret in a format
 * nobody named and not in the environment is still uploaded.
 */

export interface RedactOptions {
  /** The home directory to turn into `~`, or null to leave paths alone. */
  home: string | null;
  /** The environment the verify command ran with. */
  env: Record<string, string | undefined>;
}

export interface Redacted {
  text: string;
  /** How many values were replaced. */
  count: number;
}

/** An environment variable whose value is a secret, by its name. */
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|_KEY$|^KEY$|AUTH)/i;
/** Shorter values are too likely to be ordinary words to replace everywhere. */
const MIN_ENV_SECRET_LENGTH = 8;

/** A key name that announces a secret value. Bounded on both sides of the word. */
const SECRET_KEY_NAME = '[A-Za-z0-9_.-]{0,40}(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]{0,40}';
/**
 * A value: double-quoted with escapes, single-quoted, or bare. NOT bounded, and
 * the closing quote is optional: once a secret-named key is recognised, its
 * value is consumed to the closing quote or the end of the line, so a value of
 * any length - or one whose quote never closes - is redacted, never let
 * through (Codex review). A pattern that cannot fail after its key cannot
 * backtrack, and its matches do not overlap: one pass over the log.
 */
// A closing quote counts only when a delimiter follows it; otherwise the quote
// is the NEXT value's and pairing it would let the text between them through,
// so the value runs to the end of the line instead.
const AFTER_QUOTE = '(?=[\\s,;)}\\]]|$)';
const DQ = `"(?:[^"\\\\\\n]|\\\\.)*"${AFTER_QUOTE}|"[^\\n]*`;
const SQ = `'[^'\\n]*'${AFTER_QUOTE}|'[^\\n]*`;
const BARE = '[^\\s"\',;]+';

/**
 * Known secret formats, in the order they are tried. No `\b`: a token embedded
 * in a longer word (`id=agk_..._suffix`) is still that token (Codex review);
 * only the short `sk-` prefix keeps a guard, or every `task-...` would go.
 */
const PATTERNS: Array<{ kind: string; re: RegExp; replace?: (m: string, ...g: string[]) => string }> = [
  { kind: 'agenfk-key', re: /(?:agk|ci)_[0-9a-f]{64}/g },
  { kind: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255}/g },
  { kind: 'aws-key-id', re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  { kind: 'slack-token', re: /xox[abposr]-[A-Za-z0-9-]{10,255}/g },
  { kind: 'api-key', re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,255}/g },
  { kind: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g },
  { kind: 'bearer', re: /(Bearer\s{1,8})[A-Za-z0-9._~+/=-]{12,4096}/g, replace: (_m, p) => `${p}[REDACTED:bearer]` },
  {
    kind: 'url-password',
    re: /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,256}:)[^\s@/]+(@)/gi,
    replace: (_m, a, b) => `${a}[REDACTED:url-password]${b}`,
  },
  // "name": "value", with escaped quotes inside the value
  {
    kind: 'assigned',
    re: new RegExp(`("${SECRET_KEY_NAME}"\\s{0,8}:\\s{0,8}")((?:[^"\\\\\\n]|\\\\.)*"${AFTER_QUOTE}|[^\\n]*)`, 'gim'),
    replace: (_m, a) => `${a}[REDACTED:assigned]"`,
  },
  // name=value / name: value, the value quoted or bare
  {
    kind: 'assigned',
    re: new RegExp(`(^|[\\s,;{(])(${SECRET_KEY_NAME}[ \\t]{0,8}[=:][ \\t]{0,8})(${DQ}|${SQ}|(?!\\[REDACTED)${BARE})`, 'gim'),
    replace: (_m, lead, key, value) => {
      const q = value[0] === '"' || value[0] === "'" ? value[0] : '';
      return `${lead}${key}${q}[REDACTED:assigned]${q}`;
    },
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g;
const END = /-----END [A-Z ]{0,40}PRIVATE KEY-----/g;

/**
 * Private-key blocks, by scanning: from each BEGIN to the next END. When no END
 * follows a BEGIN, none follows any later BEGIN either, so the scan stops -
 * one pass over the log, whatever it holds.
 */
function redactKeyBlocks(text: string): { text: string; count: number } {
  let out = '';
  let at = 0;
  let count = 0;
  for (;;) {
    BEGIN.lastIndex = at;
    const b = BEGIN.exec(text);
    if (!b) break;
    END.lastIndex = b.index + b[0].length;
    const e = END.exec(text);
    if (!e) break;
    out += text.slice(at, b.index) + '[REDACTED:private-key]';
    at = e.index + e[0].length;
    count += 1;
  }
  return { text: out + text.slice(at), count };
}

/**
 * The home directory, as a whole path that starts there: not preceded by a path
 * character (`/Users/bob/backups/Users/ana` is someone else's path) and ending
 * at a separator or the end of the path. A Windows home matches either
 * separator and any case, as Windows does.
 */
function homePattern(home: string): RegExp | null {
  const trimmed = home.replace(/[\\/]+$/, '');
  if (trimmed.length < 2) return null;
  const windows = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes('\\');
  const body = trimmed.split(/[\\/]/).map(escapeRe).join(windows ? '[\\\\/]' : '/');
  return new RegExp(`(?<![A-Za-z0-9_.~-])${body}(?=[\\\\/]|$|[\\s:'")\\]])`, windows ? 'gim' : 'gm');
}

export function redactLog(input: string, opts: RedactOptions): Redacted {
  let text = input;
  let count = 0;

  // This machine's own secrets first, longest first, so a value that contains
  // another is replaced whole. Literal matches: linear.
  const envSecrets = Object.entries(opts.env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= MIN_ENV_SECRET_LENGTH)
    .sort((a, b) => (b[1] as string).length - (a[1] as string).length);
  for (const [name, value] of envSecrets) {
    const re = new RegExp(escapeRe(value as string), 'g');
    text = text.replace(re, () => { count += 1; return `[REDACTED:env:${name}]`; });
  }

  const blocks = redactKeyBlocks(text);
  text = blocks.text;
  count += blocks.count;

  for (const p of PATTERNS) {
    text = text.replace(p.re, (...args: any[]) => {
      count += 1;
      const groups = args.slice(1, -2) as string[];
      return p.replace ? p.replace(args[0] as string, ...groups) : `[REDACTED:${p.kind}]`;
    });
  }

  const home = opts.home ? homePattern(opts.home) : null;
  if (home) text = text.replace(home, '~');

  return { text, count };
}

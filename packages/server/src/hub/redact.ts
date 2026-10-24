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

/** A key name that announces a secret value in `name=value`, `"name": "value"` or `name: value`. */
const SECRET_KEY_NAME = '(?:[A-Za-z0-9_.-]*?(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]*)';

/** Known secret formats, in the order they are tried. */
const PATTERNS: Array<{ kind: string; re: RegExp; replace?: (m: string, ...g: string[]) => string }> = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'agenfk-key', re: /\b(?:agk|ci)_[0-9a-f]{64}\b/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { kind: 'aws-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'api-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer', re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, replace: (_m, p) => `${p}[REDACTED:bearer]` },
  { kind: 'url-password', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, replace: (_m, a, b) => `${a}[REDACTED:url-password]${b}` },
  // "name": "value"
  {
    kind: 'assigned',
    re: new RegExp(`("${SECRET_KEY_NAME}"\\s*:\\s*")([^"]+)(")`, 'gi'),
    replace: (_m, a, _v, b) => `${a}[REDACTED:assigned]${b}`,
  },
  // name=value and name: value (unquoted, to the end of the token)
  {
    kind: 'assigned',
    re: new RegExp(`(^|[\\s,;{(])(${SECRET_KEY_NAME}\\s*[=:]\\s*)(?!\\[REDACTED)([^\\s"',;]+)`, 'gim'),
    replace: (_m, lead, key) => `${lead}${key}[REDACTED:assigned]`,
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redactLog(input: string, opts: RedactOptions): Redacted {
  let text = input;
  let count = 0;

  // This machine's own secrets first, longest first, so a value that contains
  // another is replaced whole.
  const envSecrets = Object.entries(opts.env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= MIN_ENV_SECRET_LENGTH)
    .sort((a, b) => (b[1] as string).length - (a[1] as string).length);
  for (const [name, value] of envSecrets) {
    const re = new RegExp(escapeRe(value as string), 'g');
    text = text.replace(re, () => { count += 1; return `[REDACTED:env:${name}]`; });
  }

  for (const p of PATTERNS) {
    text = text.replace(p.re, (...args: any[]) => {
      count += 1;
      const groups = args.slice(1, -2) as string[];
      return p.replace ? p.replace(args[0] as string, ...groups) : `[REDACTED:${p.kind}]`;
    });
  }

  // The username: the home directory as a whole path segment, never a prefix
  // of another user's (`/Users/ana` is not `/Users/anabel`).
  if (opts.home && opts.home.length > 1) {
    const home = opts.home.replace(/[\\/]+$/, '');
    text = text.replace(new RegExp(`${escapeRe(home)}(?=[\\\\/]|$|[\\s:'"])`, 'gm'), '~');
  }

  return { text, count };
}

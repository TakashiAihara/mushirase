import type { Asset, FeedItem, Kind, Notice } from "./types";

// Different manifests spell the same product differently (.tool-versions says nodejs, Dockerfile says postgres).
const CANONICAL: Record<string, string> = { nodejs: "node", golang: "go", postgres: "postgresql", "react-dom": "react", drupal: "drupal/core" };

const canonical = (name: string) => CANONICAL[name.toLowerCase()] ?? name.toLowerCase();

// Names that are ambiguous as plain words are replaced by how they are written in notices.
const ALIASES: Record<string, string[]> = {
  php: ["PHP"],
  node: ["Node.js", "nodejs"],
  next: ["Next.js"],
  go: ["Golang"],
  python: ["Python", "CPython"],
  react: ["React"],
  django: ["Django"],
  "drupal/core": ["Drupal"],
  "laravel/framework": ["Laravel"],
  "symfony/symfony": ["Symfony"],
  rails: ["Rails"],
  openssl: ["OpenSSL"],
  nginx: ["nginx"],
  postgresql: ["PostgreSQL"],
  mysql: ["MySQL"],
};

// "Go" alone is an English verb, so it only names the product when a version follows ("Go 1.23.4").
const LINE_ONLY: Record<string, string[]> = { go: ["Go"] };

// Aliases that are also common words when lower-cased ("react to"). LINE_ONLY names are always case-sensitive.
const CASE_SENSITIVE = new Set(["React", "Rails"]);

// shortcut: plain names shorter than this are skipped in free text (too many accidental hits), add aliases when one matters.
const MIN_NAME_LEN = 4;

// A bare "security" also fires on policy posts ("security reporting update"), so it only counts in these pairs or as a subject tag.
const SECURITY = /security (?:release|update|fix|patch|issue|bulletin)|\[security\]|^security:|vulnerab|\bCVE-\d|advisor|exploit|malware|malicious|compromis|backdoor|supply[- ]chain|脆弱性/im;

// A malicious version is new by definition, and a manifest range like ^4.3 can resolve to it.
// shortcut: decided per item, not per mention, so a supply-chain post citing another version of the same library still hits.
const SUPPLY_CHAIN = /malicious|malware|compromis|backdoor/i;

// Runtimes are named in passing by notices about libraries written for them ("S3 Encryption Client for PHP"),
// so outside their own feed they need a version line, overlapping the asset when the asset has one.
const RUNTIMES = new Set(["php", "python", "node", "go", "ruby", "java", "postgresql", "mysql", "nginx", "openssl"]);

const PRE = /\bupcoming\b|\bscheduled for\b|\bwill be released\b|pre-?announce|advance notice|予告/i;
const RELEASE = /\breleased?\b/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Name = { text: string; caseSensitive: boolean };

// Aliases are spelled by us and are case-insensitive unless listed; a capitalised name the user wrote ("Express") keeps its case.
function namesFor(asset: Asset): Name[] {
  const key = canonical(asset.name);
  if (ALIASES[key]) return ALIASES[key].map((t) => ({ text: t, caseSensitive: CASE_SENSITIVE.has(t) }));
  return asset.name.length >= MIN_NAME_LEN ? [{ text: asset.name, caseSensitive: asset.name !== asset.name.toLowerCase() }] : [];
}

const BEFORE = String.raw`(?<![\w.-])`;

// Dotted versions only, so years, counts and dates after a name ("PHP 2026", "OpenSSL 3 months", "PHP 19 November") are not versions.
// shortcut: a suffixed version ("PHP 8.4-rc1", "8.3.30-1ubuntu1", "8.3.30~rc1") is not read at all, and neither is a bare major ("Node.js 22").
const VER = String.raw`v?(\d+(?:\.(?:\d+|x))+)(?![\w~+-]|\.\w)`;

// Version lines written right after the product name ("PHP 8.3.28 and 8.4.15"), so CVSS scores do not count.
export function mentionedLines(text: string, name: string, caseSensitive = false): string[] {
  const sep = String.raw`\s*(?:,\s*(?:and|or)?|and|or|/|&)\s*`;
  const re = new RegExp(String.raw`${BEFORE}${esc(name)}\s+(?:versions?\s+)?${VER}((?:${sep}${VER})*)`, caseSensitive ? "g" : "gi");
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    out.push(m[1]);
    for (const v of (m[2] ?? "").matchAll(new RegExp(VER, "g"))) out.push(v[1]);
  }
  return out;
}

const nums = (s: string) => s.split(".").map(Number);

// Compares over the shorter of the two, so "8" against "8.3" is equal (one covers the other).
function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export const SPEC = /^(\^|>=|>|<=|<)?(\d+(?:\.\d+)*)$/;

// spec is a line ("8.3"), a caret range ("^15.0": same major, this minor or later; "^0.4" stays on 0.4 as npm's caret does)
// or a bound (">=22", ">22", "<2", "<=1.4").
export function lineHits(spec: string, mentioned: string[]): boolean {
  const m = spec.match(SPEC);
  if (!m) throw new Error(`unsupported version spec: ${spec}`);
  const base = nums(m[2]);
  return mentioned.some((raw) => {
    const v = nums(raw.replace(/\.x$/, ""));
    const c = cmp(v, base);
    switch (m[1]) {
      case "^":
        return base[0] === 0 ? c === 0 : v[0] === base[0] && c >= 0;
      case ">=":
        return c >= 0;
      case ">":
        return c > 0;
      case "<=":
        return c <= 0;
      case "<":
        return c < 0;
      default:
        return c === 0;
    }
  });
}

function mentions(text: string, n: Name): boolean {
  return new RegExp(String.raw`${BEFORE}${esc(n.text)}(?![\w-])`, n.caseSensitive ? "" : "i").test(text);
}

function kindOf(item: FeedItem): Kind {
  const t = `${item.title} ${item.summary.slice(0, 600)}`;
  if (PRE.test(t)) return "pre-announcement";
  if (RELEASE.test(item.title)) return "release";
  return "report";
}

// product: the feed belongs to one product, so its items need no mention of the name; version lines still apply.
export function match(item: FeedItem, assets: Asset[], product?: string): Notice | null {
  const text = `${item.title}\n${item.summary}`;
  if (!SECURITY.test(text)) return null;
  const supplyChain = SUPPLY_CHAIN.test(text);

  const hits: Asset[] = [];
  for (const a of assets) {
    const key = canonical(a.name);
    const names = namesFor(a);
    const bound = product != null && key === canonical(product);
    const lineNames = [...names, ...(LINE_ONLY[key] ?? []).map((t) => ({ text: t, caseSensitive: true }))];
    const lines = lineNames.flatMap((n) => mentionedLines(text, n.text, n.caseSensitive));
    if (!bound && !names.some((n) => mentions(text, n)) && lines.length === 0) continue;

    const runtime = RUNTIMES.has(key);
    if (!bound && runtime && (lines.length === 0 || (a.version && !lineHits(a.version, lines)))) continue;
    if (a.version && !(supplyChain && !runtime) && lines.length > 0 && !lineHits(a.version, lines)) continue;
    hits.push(a);
  }
  if (hits.length === 0) return null;
  return { item, kind: kindOf(item), hits };
}

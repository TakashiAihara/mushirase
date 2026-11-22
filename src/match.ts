import type { Asset, FeedItem, Kind, Notice } from "./types";

// Names that are ambiguous as plain words are replaced by how they are written in notices.
const ALIASES: Record<string, string[]> = {
  php: ["PHP"],
  node: ["Node.js", "nodejs"],
  nodejs: ["Node.js", "nodejs"],
  next: ["Next.js"],
  go: ["Golang", "Go toolchain", "Go standard library", "golang.org/x"],
  golang: ["Golang", "Go toolchain", "Go standard library", "golang.org/x"],
  python: ["Python", "CPython"],
  react: ["React"],
  "react-dom": ["React"],
  django: ["Django"],
  drupal: ["Drupal"],
  "drupal/core": ["Drupal"],
  "laravel/framework": ["Laravel"],
  "symfony/symfony": ["Symfony"],
  rails: ["Rails"],
  openssl: ["OpenSSL"],
  nginx: ["nginx"],
  postgres: ["PostgreSQL"],
  postgresql: ["PostgreSQL"],
  mysql: ["MySQL"],
};

// shortcut: plain names shorter than this are skipped in free text (too many accidental hits), add aliases when one matters.
const MIN_NAME_LEN = 4;

// A bare "security" also fires on policy posts ("security reporting update"), so it only counts in these pairs.
const SECURITY = /security (?:release|update|fix|patch|advisor|issue|bulletin)|vulnerab|\bCVE-\d|advisor|exploit|malware|malicious|compromis|backdoor|supply[- ]chain|脆弱性/i;

// Runtimes are named in passing by notices about libraries written for them ("S3 Encryption Client for PHP"),
// so outside their own feed they need a version line that overlaps the asset.
// A malicious version is new by definition, and a manifest range like ^4.3 can resolve to it.
const SUPPLY_CHAIN = /malicious|malware|compromis|backdoor/i;

const RUNTIMES = new Set(["php", "python", "node", "nodejs", "go", "golang", "ruby", "java", "postgresql", "postgres", "mysql", "nginx", "openssl"]);
const PRE = /\bupcoming\b|\bscheduled for\b|\bwill be released\b|pre-?announce|advance notice|予告/i;
const RELEASE = /\breleased?\b|\bavailable\b/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function namesFor(asset: Asset): string[] {
  const key = asset.name.toLowerCase();
  if (ALIASES[key]) return ALIASES[key];
  return asset.name.length >= MIN_NAME_LEN ? [asset.name] : [];
}

const VER = String.raw`v?(\d+(?:\.(?:\d+|x))*)`;

// Version lines written right after the product name ("PHP 8.3.28 and 8.4.15"), so CVSS scores and dates do not count.
export function mentionedLines(text: string, name: string): string[] {
  const re = new RegExp(String.raw`(?<![\w.])${esc(name)}\s+${VER}((?:\s*(?:,|and|or|/|&)\s*${VER})*)`, "gi");
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    out.push(m[1]);
    for (const v of (m[2] ?? "").matchAll(new RegExp(VER, "g"))) out.push(v[1]);
  }
  return out;
}

function lineHits(line: string, mentioned: string[]): boolean {
  return mentioned.some((v) => v === line || v.startsWith(line + ".") || line.startsWith(v + ".") || v === `${line}.x`);
}

function mentions(text: string, name: string): boolean {
  const re = new RegExp(String.raw`(?<![\w.])${esc(name)}(?![\w])`, name === name.toLowerCase() ? "i" : "");
  return re.test(text);
}

function kindOf(item: FeedItem): Kind {
  const t = `${item.title} ${item.summary.slice(0, 600)}`;
  if (PRE.test(t)) return "pre-announcement";
  if (RELEASE.test(item.title)) return "release";
  return "report";
}

// product: the feed belongs to one product, so every item is about it and only security relevance is checked.
export function match(item: FeedItem, assets: Asset[], product?: string): Notice | null {
  const text = `${item.title}\n${item.summary}`;
  if (!SECURITY.test(text)) return null;

  const hits: Asset[] = [];
  for (const a of assets) {
    const names = namesFor(a);
    const bound = product != null && a.name.toLowerCase() === product.toLowerCase();
    if (!bound && !names.some((n) => mentions(text, n))) continue;

    const lines = names.flatMap((n) => mentionedLines(text, n));
    if (!bound && RUNTIMES.has(a.name.toLowerCase()) && !(a.version && lineHits(a.version, lines))) continue;
    const range = SUPPLY_CHAIN.test(text) && !RUNTIMES.has(a.name.toLowerCase());
    if (a.version && !range && lines.length > 0 && !lineHits(a.version, lines)) continue;
    hits.push(a);
  }
  if (hits.length === 0) return null;
  return { item, kind: kindOf(item), hits };
}

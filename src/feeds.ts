import { XMLParser } from "fast-xml-parser";
import type { FeedItem } from "./types";

// Atom bodies are taken raw: the parser reorders mixed xhtml content ("a <b>b</b> c" becomes "b a c").
// RSS bodies are text (escaped or CDATA), so the parser's own decoding is kept and body() undoes the HTML layer.
// parseTagValue off: ids and titles are text, and "0001" must not become the number 1.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false, stopNodes: ["feed.entry.content", "feed.entry.summary"] });

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
}

const arr = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

// Titles and ids can still arrive as nested elements; their text nodes are joined.
function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(text).join(" ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !k.startsWith("@"))
      .map(([, c]) => text(c))
      .join(" ");
  }
  return "";
}

// Only real tags, comments, doctypes and processing instructions are removed, so "< 8.3.30" stays.
function stripHtml(s: string): string {
  return s.replace(/<\/?[a-zA-Z][^<>]*>|<[!?][^<>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

// A raw body has two layers: XML (xhtml markup, then its entities) and the HTML that escaped markup becomes (type="html", RSS).
function body(raw: unknown): string {
  const s = text(raw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return decode(stripHtml(decode(stripHtml(s)))).replace(/\s+/g, " ").trim().slice(0, 4000);
}

function atomLink(v: unknown): string {
  const links = arr(v as Record<string, string> | Record<string, string>[]);
  const alt = links.find((l) => typeof l === "object" && (l["@rel"] ?? "alternate") === "alternate") ?? links[0];
  return typeof alt === "string" ? alt : (alt?.["@href"] ?? "");
}

export function parseFeed(xml: string, feed: string): FeedItem[] {
  const doc = parser.parse(xml);
  if (doc.feed) {
    return arr(doc.feed.entry).map((e: Record<string, unknown>) => {
      const link = atomLink(e.link);
      return {
        id: text(e.id) || link,
        feed,
        title: stripHtml(text(e.title)),
        link,
        summary: body(e.content) || body(e.summary),
        published: text(e.published) || text(e.updated) || undefined,
      };
    });
  }
  const channel = doc.rss?.channel ?? doc["rdf:RDF"];
  if (!channel) throw new Error(`${feed}: not an RSS/Atom feed`);
  return arr(channel.item ?? doc["rdf:RDF"]?.item).map((e: Record<string, unknown>) => {
    const link = text(e.link);
    return {
      id: text(e.guid) || link,
      feed,
      title: stripHtml(text(e.title)),
      link,
      summary: body(e["content:encoded"]) || body(e.description),
      published: text(e.pubDate) || text(e["dc:date"]) || undefined,
    };
  });
}

export async function fetchFeed(name: string, url: string): Promise<FeedItem[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "mushirase/0.1" } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return parseFeed(await res.text(), name);
}

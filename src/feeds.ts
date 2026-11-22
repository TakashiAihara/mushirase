import { XMLParser } from "fast-xml-parser";
import type { FeedItem } from "./types";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });

const arr = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as object)) return String((v as Record<string, unknown>)["#text"]);
  return "";
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
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
        summary: stripHtml(text(e.content) || text(e.summary)).slice(0, 4000),
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
      summary: stripHtml(text(e["content:encoded"]) || text(e.description)).slice(0, 4000),
      published: text(e.pubDate) || text(e["dc:date"]) || undefined,
    };
  });
}

export async function fetchFeed(name: string, url: string): Promise<FeedItem[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "mushirase/0.1" } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return parseFeed(await res.text(), name);
}

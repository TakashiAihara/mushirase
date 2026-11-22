import { expect, test } from "bun:test";
import { parseFeed } from "../src/feeds";

test("Atom xhtml content is read as text", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>1</id><title>PHP 8.3.30 Released</title><link href="https://x/1"/><updated>2026-11-19T00:00:00Z</updated><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>This is a <b>security</b> release.</p></div></content></entry></feed>`;
  const [e] = parseFeed(xml, "php");
  expect(e.summary).toBe("This is a security release.");
  expect(e.link).toBe("https://x/1");
});

test("a comparison in RSS text is not removed as a tag", () => {
  const xml = `<rss><channel><item><guid>g</guid><title>Fix for versions &lt; 8.3.30 and &gt; 8.2</title><link>https://x/2</link><description>&lt;p&gt;affects &amp;lt; 8.3.30&lt;/p&gt;</description></item></channel></rss>`;
  const [e] = parseFeed(xml, "f");
  expect(e.title).toBe("Fix for versions < 8.3.30 and > 8.2");
  expect(e.summary).toContain("8.3.30");
  expect(e.summary).not.toContain("<p>");
});

test("a document that is not a feed is an error", () => {
  expect(() => parseFeed("<html><body/></html>", "f")).toThrow("not an RSS/Atom feed");
});

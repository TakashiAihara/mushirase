import { expect, test } from "bun:test";
import { parseFeed } from "../src/feeds";

test("Atom xhtml content is read as text in order", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>1</id><title>PHP 8.3.30 Released</title><link href="https://x/1"/><updated>2026-11-19T00:00:00Z</updated><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>This is a <b>security</b> release for &lt; 8.3.30 and &gt; 8.2.</p><!-- hidden --></div></content></entry></feed>`;
  const [e] = parseFeed(xml, "php");
  expect(e.summary).toBe("This is a security release for < 8.3.30 and > 8.2.");
  expect(e.link).toBe("https://x/1");
});

test("Atom html content is decoded and its tags removed", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>2</id><title>t</title><content type="html">&lt;p&gt;affects &amp;lt; 8.3.30&lt;/p&gt;</content></entry></feed>`;
  expect(parseFeed(xml, "f")[0].summary).toBe("affects < 8.3.30");
});

test("Atom content in CDATA is unwrapped", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>3</id><title>t</title><content type="html"><![CDATA[<p>PHP <b>8.3.30</b> fixes it</p>]]></content></entry></feed>`;
  expect(parseFeed(xml, "f")[0].summary).toBe("PHP 8.3.30 fixes it");
});

test("an RSS description in CDATA keeps its order and loses its tags", () => {
  const xml = `<rss><channel><item><guid>g</guid><title>Fix for versions &lt; 8.3.30</title><link>https://x/2</link><description><![CDATA[<p>PHP <b>8.3.30</b> fixes it</p>]]></description></item></channel></rss>`;
  const [e] = parseFeed(xml, "f");
  expect(e.title).toBe("Fix for versions < 8.3.30");
  expect(e.summary).toBe("PHP 8.3.30 fixes it");
});

test("an escaped RSS description is decoded and its tags removed", () => {
  const xml = `<rss><channel><item><guid>g</guid><title>t</title><description>&lt;p&gt;affects &amp;lt; 8.3.30&lt;/p&gt;</description></item></channel></rss>`;
  expect(parseFeed(xml, "f")[0].summary).toBe("affects < 8.3.30");
});

test("RSS content:encoded is preferred over the description", () => {
  const xml = `<rss><channel><item><guid>g</guid><title>t</title><description>short</description><content:encoded><![CDATA[<p>full body</p>]]></content:encoded></item></channel></rss>`;
  expect(parseFeed(xml, "f")[0].summary).toBe("full body");
});

test("Atom summary is used when there is no content", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>4</id><title>t</title><summary type="text">only a summary</summary></entry></feed>`;
  expect(parseFeed(xml, "f")[0].summary).toBe("only a summary");
});

test("numeric-looking ids stay text and numeric character references are decoded", () => {
  const xml = `<rss><channel><item><guid>0001</guid><title>2026</title><description>PHP&amp;#32;8.3.30 fixes &#x41;</description></item><item><guid>1</guid><title>t</title></item></channel></rss>`;
  const [a, b] = parseFeed(xml, "f");
  expect([a.id, b.id, a.title]).toEqual(["0001", "1", "2026"]);
  expect(a.summary).toBe("PHP 8.3.30 fixes A");
});

test("a document that is not a feed is an error", () => {
  expect(() => parseFeed("<html><body/></html>", "f")).toThrow("not an RSS/Atom feed");
});

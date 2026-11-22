import { expect, test } from "bun:test";
import { atom, hitsLine, render, uploadAtom } from "../src/notify";
import type { Notice } from "../src/types";

const notice = (feed: string, id: string): Notice => ({
  item: { id, feed, title: "Upcoming PHP Security Release", link: "https://example.com/a?b=1&c=2", summary: "body" },
  kind: "pre-announcement",
  hits: [
    { name: "php", version: "8.3", source: "repo-a/composer.json" },
    { name: "php", version: "8.3", source: "repo-b/Dockerfile" },
  ],
});

test("hits are grouped by name and version with the repositories they come from", () => {
  expect(hitsLine(notice("php", "1"))).toBe("php 8.3 (repo-a, repo-b)");
  expect(render(notice("php", "1")).title).toBe("[予告] Upcoming PHP Security Release");
});

test("Atom entry ids keep feed and item apart and escape the link", () => {
  const xml = atom("my feed", [
    { notice: notice("a:b", "c"), at: "2026-11-22T00:00:00.000Z" },
    { notice: notice("a", "b:c"), at: "2026-11-22T00:00:00.000Z" },
  ]);
  expect(xml).toContain("<id>urn:mushirase:a%3Ab:c</id>");
  expect(xml).toContain("<id>urn:mushirase:a:b%3Ac</id>");
  expect(xml).toContain("<id>urn:mushirase:my%20feed</id>");
  expect(xml).toContain('<link href="https://example.com/a?b=1&amp;c=2"/>');
});

test("control characters that XML 1.0 forbids are dropped from the Atom feed", () => {
  const n = notice("php", "1");
  n.item.title = "bad\u0001title\u000b end";
  expect(atom("t", [{ notice: n, at: "2026-11-22T00:00:00.000Z" }])).toContain("<title>[予告] badtitle end</title>");
});

test("credentials are refused for a plain-http upload URL that is not this machine", async () => {
  process.env.MUSHIRASE_TEST_U = "u";
  process.env.MUSHIRASE_TEST_P = "p";
  try {
    const cfg = { url: "http://dav.example.com/feed.atom", userEnv: "MUSHIRASE_TEST_U", passwordEnv: "MUSHIRASE_TEST_P" };
    await expect(uploadAtom(cfg, "x")).rejects.toThrow("credentials are only sent over https or to localhost, got http://dav.example.com");
  } finally {
    delete process.env.MUSHIRASE_TEST_U;
    delete process.env.MUSHIRASE_TEST_P;
  }
});

test("credentials embedded in a plain-http upload URL are refused too", async () => {
  await expect(uploadAtom({ url: "http://writer:pw@dav.example.com/feed.atom" }, "x")).rejects.toThrow("credentials are only sent over https or to localhost");
});

import { expect, test } from "bun:test";
import { atom, hitsLine, render } from "../src/notify";
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

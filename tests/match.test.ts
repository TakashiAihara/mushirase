import { describe, expect, test } from "bun:test";
import { mentionedLines, match } from "../src/match";
import type { Asset, FeedItem } from "../src/types";

const item = (title: string, summary = ""): FeedItem => ({ id: title, feed: "t", title, link: "https://example.com", summary });
const a = (name: string, version?: string): Asset => ({ name, version, source: "stack.yaml" });

describe("project feeds", () => {
  test("a PHP pre-announcement without version lines reaches a PHP 8.3 user as a pre-announcement", () => {
    const n = match(item("Upcoming Critical PHP Security Release", "scheduled for Thursday, 19 November 2026, highest severity is CRITICAL"), [a("php", "8.3")], "php");
    expect(n?.kind).toBe("pre-announcement");
    expect(n?.hits.map((h) => h.name)).toEqual(["php"]);
  });

  test("a non-security post in a project feed is dropped", () => {
    expect(match(item("PHP 8.3.31 RC 1 available for testing"), [a("php", "8.3")], "php")).toBeNull();
  });

  test("a security release for other version lines is dropped", () => {
    expect(match(item("PHP 8.5.1 and 8.4.16 Released", "This is a security release."), [a("php", "8.3")], "php")).toBeNull();
  });

  test("a security release naming the user's line among others is kept", () => {
    const n = match(item("PHP 8.4.16 and 8.3.30 Released", "This is a security release."), [a("php", "8.3")], "php");
    expect(n?.kind).toBe("release");
  });

  test("a CVSS score is not read as a version line", () => {
    const n = match(item("Upcoming Critical PHP Security Release", "two critical vulnerabilities, both rated CVSS v4.0 9.2"), [a("php", "8.3")], "php");
    expect(n).not.toBeNull();
  });

  test("the product binding only covers the bound asset", () => {
    const n = match(item("Upcoming Critical PHP Security Release"), [a("php", "8.3"), a("django", "5.1")], "php");
    expect(n?.hits.map((h) => h.name)).toEqual(["php"]);
  });
});

describe("general feeds", () => {
  test("an asset named by its alias in a security item is a hit", () => {
    const n = match(item("Next.js middleware bypass (CVE-2026-1234)"), [a("next", "15")]);
    expect(n?.hits.map((h) => h.name)).toEqual(["next"]);
  });

  test("an ambiguous package name is not matched as a plain word", () => {
    expect(match(item("Security fix lands next week"), [a("next", "15")])).toBeNull();
    expect(match(item("Security fix: go ahead and upgrade"), [a("go", "1.23")])).toBeNull();
  });

  test("short names without an alias are not matched in free text", () => {
    expect(match(item("security fix: ms latency"), [a("ms", "2")])).toBeNull();
  });

  test("an item naming an asset but not about security is dropped", () => {
    expect(match(item("Next.js 15.6 is out with faster builds"), [a("next", "15")])).toBeNull();
  });

  test("lower-case names match case-insensitively, capitalised aliases do not", () => {
    expect(match(item("Security advisory for Express"), [a("express", "4")])).not.toBeNull();
    expect(match(item("Security fix: how to react to the incident"), [a("react", "19")])).toBeNull();
  });
});

describe("runtimes in general feeds", () => {
  test("a library advisory naming the runtime in passing is dropped", () => {
    expect(match(item("CVE-2026-1 - tag length downgrade in Amazon S3 Encryption Client for PHP"), [a("php", "8.3")])).toBeNull();
  });

  test("a runtime named with an overlapping version line is a hit", () => {
    const n = match(item("PHP 8.3.30 fixes CVE-2026-2"), [a("php", "8.3")]);
    expect(n?.hits.map((h) => h.name)).toEqual(["php"]);
  });

  test("a library keeps matching by name alone", () => {
    const n = match(item("Security advisory: debug on npm"), [a("debug", "4.3")]);
    expect(n?.hits.map((h) => h.name)).toEqual(["debug"]);
  });

  test("a malicious version outside the manifest's line still reaches the package user", () => {
    const n = match(item("Malicious release of debug 4.4.2 on npm"), [a("debug", "4.3")]);
    expect(n?.hits.map((h) => h.name)).toEqual(["debug"]);
  });

  test("in its own feed, a runtime release for other lines is dropped even when it mentions an exploit", () => {
    expect(match(item("PHP 8.5.1 fixes a malicious upload exploit"), [a("php", "8.3")], "php")).toBeNull();
  });

  test("a library security release for other lines is dropped", () => {
    expect(match(item("Security release: debug 5.0.1"), [a("debug", "4.3")])).toBeNull();
  });
});

describe("security wording", () => {
  test("a policy post that only says security is dropped", () => {
    expect(match(item("Security support for Drupal core minor versions reduced to 8 months"), [a("drupal/core", "10")], "drupal/core")).toBeNull();
  });
});

describe("mentionedLines", () => {
  test("collects every version listed after the name", () => {
    expect(mentionedLines("PHP 8.4.16, 8.3.30 and 8.2.29 released", "PHP")).toEqual(["8.4.16", "8.3.30", "8.2.29"]);
  });

  test("ignores numbers not attached to the name", () => {
    expect(mentionedLines("rated CVSS v4.0 9.2 on 19 November 2026", "PHP")).toEqual([]);
  });
});

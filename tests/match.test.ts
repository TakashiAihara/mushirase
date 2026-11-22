import { describe, expect, test } from "bun:test";
import { lineHits, mentionedLines, match } from "../src/match";
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
    expect(mentionedLines("PHP release rated CVSS v4.0 9.2 on 19 November 2026", "PHP")).toEqual([]);
  });

  test("reads the last version after an Oxford comma", () => {
    expect(mentionedLines("PHP 8.4.16, 8.3.30, and 8.2.29 released", "PHP")).toEqual(["8.4.16", "8.3.30", "8.2.29"]);
  });

  test("does not read years, bitness, counts, dates or suffixed builds as versions", () => {
    expect(mentionedLines("PHP 2026 roadmap, PHP 64-bit builds, PHP 19 November, PHP 8.4-rc1, PHP 8.3.30-1ubuntu1", "PHP")).toEqual([]);
  });

  test("reads a version at the end of a sentence", () => {
    expect(mentionedLines("Upgrade to PHP 8.3.30.", "PHP")).toEqual(["8.3.30"]);
  });
});

describe("lineHits", () => {
  test("a caret range covers later minors of the same major only", () => {
    expect(lineHits("^8.3", ["8.4.1"])).toBe(true);
    expect(lineHits("^8.3", ["8.3.30"])).toBe(true);
    expect(lineHits("^8.3", ["8.2.29"])).toBe(false);
    expect(lineHits("^8.3", ["9.0.0"])).toBe(false);
    expect(lineHits("^0.4", ["0.5.0"])).toBe(false);
  });

  test("a lower bound covers every later version", () => {
    expect(lineHits(">=22.0", ["23.1.0"])).toBe(true);
    expect(lineHits(">=22.0", ["20.18.1"])).toBe(false);
  });

  test("an exact line, a patch under the line, a major covering the line, and a wildcard all overlap", () => {
    expect(lineHits("8.3", ["8.3"])).toBe(true);
    expect(lineHits("8.3", ["8.3.30"])).toBe(true);
    expect(lineHits("8.3", ["8"])).toBe(true);
    expect(lineHits("8.3", ["8.x"])).toBe(true);
  });

  test("a sibling line does not overlap", () => {
    expect(lineHits("8.3", ["8.30.1", "8.4", "9.x"])).toBe(false);
  });
});

describe("names", () => {
  test("Go is recognised when a version follows it, and only capitalised", () => {
    const n = match(item("Go 1.23.5 fixes CVE-2026-3"), [a("go", "1.23")]);
    expect(n?.hits.map((h) => h.name)).toEqual(["go"]);
    expect(match(item("CVE-2026-3: attackers can go 1.23 steps further"), [a("go", "1.23")])).toBeNull();
  });

  test("a name prefixed by a hyphen is not the product even with a version", () => {
    expect(match(item("non-PHP 8.3.30 parser fixes CVE-2026-7"), [a("php", "8.3")])).toBeNull();
  });

  test("a capitalised name written by the user keeps its case", () => {
    expect(match(item("Security fix: express delivery"), [a("Express")])).toBeNull();
    expect(match(item("Security advisory for Express"), [a("Express")])).not.toBeNull();
  });

  test("React matches when capitalised", () => {
    expect(match(item("React 19.1.2 fixes CVE-2026-8"), [a("react", "19")])?.hits.map((h) => h.name)).toEqual(["react"]);
  });

  test("a composer caret range on PHP reaches a later minor's release and not an earlier one", () => {
    expect(match(item("PHP 8.4.16 Released", "This is a security release."), [a("php", "^8.3")], "php")).not.toBeNull();
    expect(match(item("PHP 8.2.30 Released", "This is a security release."), [a("php", "^8.3")], "php")).toBeNull();
  });

  test("a project feed binds assets spelled differently by another manifest", () => {
    const n = match(item("Upcoming Node.js security release"), [a("nodejs", "22")], "node");
    expect(n?.hits.map((h) => h.name)).toEqual(["nodejs"]);
  });

  test("a hyphenated longer name is a different product", () => {
    expect(match(item("Security advisory for React-Native"), [a("react", "19")])).toBeNull();
  });

  test("an unambiguous alias matches when written in lower case", () => {
    expect(match(item("Security advisory for django users"), [a("django", "5.1")])).not.toBeNull();
  });

  test("a runtime without a version matches when the notice names a version", () => {
    expect(match(item("PHP 8.3.30 fixes CVE-2026-5"), [a("php")])).not.toBeNull();
    expect(match(item("Amazon S3 Encryption Client for PHP: CVE-2026-6"), [a("php")])).toBeNull();
  });
});

describe("wording", () => {
  test("a [SECURITY] subject tag counts as security wording", () => {
    expect(match(item("[SECURITY] Django 5.1.9 released"), [a("django", "5.1")], "django")).not.toBeNull();
  });

  test("an item that is neither a pre-announcement nor a release is a report", () => {
    expect(match(item("Exploit seen for Drupal core"), [a("drupal/core", "10")], "drupal/core")?.kind).toBe("report");
  });
});

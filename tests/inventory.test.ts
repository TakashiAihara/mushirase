import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInventory, scan } from "../src/inventory";

const root = mkdtempSync(join(tmpdir(), "mushirase-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function repo(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  return dir;
}

const spec = (dir: string) => Object.fromEntries(scan(dir).map((a) => [a.name, a.version ?? null]));

test("ranges keep their operator, npm tilde and exact pins keep the line, upper bounds are dropped", () => {
  const dir = repo("npm", { "package.json": JSON.stringify({ dependencies: { next: "^15.0.0", zod: "~3.22.1", tiny: "^0.4.1", old: "<2" }, devDependencies: { left: "2.1.3" }, engines: { node: ">=22.0.0" } }) });
  expect(spec(dir)).toEqual({ next: "^15.0", zod: "3.22", tiny: "^0.4", old: null, left: "2.1", node: ">=22.0" });
});

test("go.mod keeps direct requires and the go line, not indirect, replace or exclude", () => {
  const gomod = ["module example.com/m", "", "go 1.23.4", "", "require (", "\tgithub.com/a/direct v1.4.0", "\tgithub.com/b/indirect v2.0.1 // indirect", ")", "", "replace github.com/c/r v1.0.0 => ../r", "replace (", "\tgithub.com/e/y v1.1.0 => github.com/f/z v1.2.0", ")", "exclude (", "\tgithub.com/d/x v0.9.0", ")", ""].join("\n");
  expect(spec(repo("go", { "go.mod": gomod }))).toEqual({ go: "1.23", "github.com/a/direct": "1.4" });
});

test("requirements with extras keep their version", () => {
  expect(spec(repo("py", { "requirements.txt": "django[argon2]>=5.1\n# note\nrequests==2.32.3\nurllib3~=2.2\n-e ./local\n" }))).toEqual({ django: ">=5.1", requests: "2.32", urllib3: "^2.2" });
});

test("a Dockerfile image behind a registry port is named by its path", () => {
  const d = "FROM localhost:5000/team/php:8.3-fpm AS base\n  FROM node:22-alpine\nFROM scratch\nFROM golang@sha256:abc\nFROM localhost:5000/team/app\nFROM base AS final\n";
  expect(spec(repo("docker", { Dockerfile: d }))).toEqual({ php: "8.3", node: "22", golang: null, app: null });
});

test("mise tools written as tables or lists keep their version", () => {
  expect(spec(repo("mise", { ".mise.toml": '[tools]\nbun = "1.4.5"\nnode = { version = "22.11" }\npython = ["3.12", "3.11"]\n' }))).toEqual({ bun: "1.4", node: "22.11", python: "3.12" });
});

test("sources are labelled by the repository name even when scanned as .", () => {
  const dir = repo("labelled", { "package.json": JSON.stringify({ dependencies: { hono: "4.6.0" } }) });
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    expect(scan(".")[0].source).toBe(join("labelled", "package.json"));
  } finally {
    process.chdir(cwd);
  }
});

test("an unquoted numeric version in a hand-written inventory is rejected", () => {
  const f = join(root, "stack.yaml");
  writeFileSync(f, "assets:\n  - { name: php, version: 8.10 }\n");
  expect(() => loadInventory([f])).toThrow('quote the version of php');
  writeFileSync(f, 'assets:\n  - { name: php, version: "8.10" }\n');
  expect(loadInventory([f])).toEqual([{ name: "php", version: "8.10", source: "stack.yaml" }]);
});

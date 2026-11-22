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

test("npm specs are kept as semver ranges, invalid ones dropped", () => {
  const dir = repo("npm", { "package.json": JSON.stringify({ dependencies: { next: "^15.0.0", zod: "~3.22.1", old: "<2", lib: ">5.1.0", ws: "workspace:*" }, devDependencies: { left: "2.1.3" }, engines: { node: ">=22.0.0" } }) });
  expect(spec(dir)).toEqual({ next: "^15.0.0", zod: "~3.22.1", old: "<2", lib: ">5.1.0", ws: null, left: "2.1.3", node: ">=22.0.0" });
});

test("Composer tildes become npm ranges: two parts cover the major, three the minor", () => {
  const dir = repo("composer", { "composer.json": JSON.stringify({ require: { php: "~8.3", "laravel/framework": "~11.2.0", "drupal/core": "^10.3", zero: "~0.4", either: "^7.4 || ^8.0", window: ">=7.4 <8.4", spaced: ">= 7.4 < 8.4", gt: ">1.4", le: "<=1.4", four: "1.2.3.4 || ^2.0", dev: "^1.0 || dev-main" } }) });
  expect(spec(dir)).toEqual({ php: ">=8.3 <9", "laravel/framework": ">=11.2.0 <11.3", "drupal/core": "^10.3", zero: ">=0.4 <1", either: "^7.4 || ^8.0", window: ">=7.4.0 <8.4.0", spaced: ">=7.4.0 <8.4.0", gt: ">1.4.0", le: "<=1.4.0", four: "^2.0", dev: "^1.0" });
});

test("go.mod keeps direct requires and the go line, not indirect, replace or exclude", () => {
  const gomod = ["module example.com/m", "", "go 1.23.4", "", "require (", "\tgithub.com/a/direct v1.4.0", "\tgithub.com/b/indirect v2.0.1 // indirect", ")", "", "replace github.com/c/r v1.0.0 => ../r", "replace (", "\tgithub.com/e/y v1.1.0 => github.com/f/z v1.2.0", ")", "exclude (", "\tgithub.com/d/x v0.9.0", ")", ""].join("\n");
  expect(spec(repo("go", { "go.mod": gomod }))).toEqual({ go: "1.23", "github.com/a/direct": "1.4" });
});

test("Python specifiers become npm ranges, including extras, ~=, ==x.*, closed ranges and exclusions", () => {
  const req = "django[argon2]>=5.1\n# note\nrequests==2.32.3\nurllib3~=2.2\nidna~=3.7.1\ncapped>=3.11,<3.13\nstar==2.32.*\nnope!=1.0\nmixed>=1.0,!=1.5\nspaced >= 5.1\nhashed==2.0.1 \\\n    --hash=sha256:abc\npinned==1.4 --hash=sha256:def\n-e ./local\n";
  expect(spec(repo("py", { "requirements.txt": req }))).toEqual({ django: ">=5.1.0", requests: "2.32.3", urllib3: ">=2.2 <3", idna: ">=3.7.1 <3.8", capped: ">=3.11.0 <3.13.0", star: "2.32.x", nope: null, mixed: ">=1.0.0", spaced: ">=5.1.0", hashed: "2.0.1", pinned: "1.4" });
});

test("requires-python is read as a Python specifier", () => {
  expect(spec(repo("pyproj", { "pyproject.toml": '[project]\nname = "x"\nrequires-python = "~=3.11"\ndependencies = ["httpx>=0.27"]\n' }))).toEqual({ httpx: ">=0.27.0", python: ">=3.11 <4" });
});

test("a Dockerfile image behind a registry port is named by its path", () => {
  const d = "FROM localhost:5000/team/php:8.3-fpm AS base\n  FROM node:22-alpine\nFROM scratch\nFROM golang@sha256:abc\nFROM localhost:5000/team/app\nFROM base AS final\nFROM ubuntu:2024.01\n";
  expect(spec(repo("docker", { Dockerfile: d }))).toEqual({ php: "8.3", node: "22", golang: null, app: null, ubuntu: null });
});

test("mise tools written as tables or lists keep every version", () => {
  const assets = scan(repo("mise", { ".mise.toml": '[tools]\nbun = "1.4.5"\nnode = { version = "22.11" }\npython = ["3.12", "3.11"]\n' }));
  expect(assets.map((a) => `${a.name} ${a.version}`)).toEqual(["bun 1.4", "node 22.11", "python 3.12", "python 3.11"]);
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
  writeFileSync(f, 'assets:\n  - { name: php, version: "8.3 stable" }\n');
  expect(() => loadInventory([f])).toThrow("version of php must be an npm semver range");
  writeFileSync(f, 'assets:\n  - { name: php, version: "8.10" }\n');
  expect(loadInventory([f])).toEqual([{ name: "php", version: "8.10", source: "stack.yaml" }]);
});

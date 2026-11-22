import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Asset } from "./types";

const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", "build", ".venv"]);

function lineOf(spec: string): string | undefined {
  return spec.match(/\d+(?:\.\d+)?/)?.[0];
}

function fromPackageJson(text: string, src: string): Asset[] {
  const j = JSON.parse(text);
  const out: Asset[] = [];
  for (const key of ["dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries<string>(j[key] ?? {})) {
      out.push({ name, version: lineOf(String(spec)), source: src });
    }
  }
  if (j.engines?.node) out.push({ name: "node", version: lineOf(j.engines.node), source: src });
  return out;
}

function fromComposerJson(text: string, src: string): Asset[] {
  const j = JSON.parse(text);
  return Object.entries<string>(j.require ?? {}).map(([name, spec]) => ({
    name: name === "php" ? "php" : name,
    version: lineOf(String(spec)),
    source: src,
  }));
}

function fromGoMod(text: string, src: string): Asset[] {
  const out: Asset[] = [];
  const go = text.match(/^go\s+(\d+\.\d+)/m);
  if (go) out.push({ name: "go", version: go[1], source: src });
  for (const m of text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+v(\d+\.\d+)/gm)) {
    out.push({ name: m[1], version: m[2], source: src });
  }
  return out;
}

function fromRequirements(text: string, src: string): Asset[] {
  return text
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => l && !l.startsWith("-"))
    .map((l) => {
      const m = l.match(/^([A-Za-z0-9_.-]+)\s*(?:[=<>~!]=?\s*([\d.]+))?/);
      return { name: (m?.[1] ?? l).toLowerCase(), version: m?.[2] ? lineOf(m[2]) : undefined, source: src };
    });
}

function fromPyproject(text: string, src: string): Asset[] {
  const t = Bun.TOML.parse(text) as { project?: { dependencies?: string[]; "requires-python"?: string } };
  const out = fromRequirements((t.project?.dependencies ?? []).join("\n"), src);
  const py = t.project?.["requires-python"];
  if (py) out.push({ name: "python", version: lineOf(py), source: src });
  return out;
}

function fromDockerfile(text: string, src: string): Asset[] {
  const out: Asset[] = [];
  for (const m of text.matchAll(/^FROM\s+(?:--\S+\s+)?([^\s:@]+)(?::([^\s@]+))?/gim)) {
    const name = m[1].split("/").pop()!;
    if (name === "scratch" || m[1].startsWith("$")) continue;
    out.push({ name, version: m[2] ? lineOf(m[2]) : undefined, source: src });
  }
  return out;
}

function fromMise(text: string, src: string): Asset[] {
  const t = Bun.TOML.parse(text) as { tools?: Record<string, unknown> };
  return Object.entries(t.tools ?? {}).map(([name, v]) => ({ name, version: lineOf(String(v)), source: src }));
}

function fromToolVersions(text: string, src: string): Asset[] {
  return text
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[0] && !p[0].startsWith("#"))
    .map(([name, v]) => ({ name, version: v ? lineOf(v) : undefined, source: src }));
}

const PARSERS: Record<string, (text: string, src: string) => Asset[]> = {
  "package.json": fromPackageJson,
  "composer.json": fromComposerJson,
  "go.mod": fromGoMod,
  "requirements.txt": fromRequirements,
  "pyproject.toml": fromPyproject,
  Dockerfile: fromDockerfile,
  ".mise.toml": fromMise,
  ".tool-versions": fromToolVersions,
};

function walk(dir: string, files: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, files);
    } else if (PARSERS[e.name] || e.name.startsWith("Dockerfile")) files.push(p);
  }
  return files;
}

export function scan(root: string): Asset[] {
  const out: Asset[] = [];
  const label = basename(root);
  for (const f of walk(root)) {
    const name = basename(f);
    const parse = PARSERS[name] ?? fromDockerfile;
    try {
      out.push(...parse(readFileSync(f, "utf8"), join(label, relative(root, f))));
    } catch (e) {
      console.error(`skip ${f}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function loadInventory(paths: string[]): Asset[] {
  const out: Asset[] = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      out.push(...scan(p));
      continue;
    }
    const doc = Bun.YAML.parse(readFileSync(p, "utf8")) as { assets?: Asset[] };
    for (const a of doc.assets ?? []) out.push({ ...a, version: a.version == null ? undefined : String(a.version), source: a.source ?? basename(p) });
  }
  return out;
}

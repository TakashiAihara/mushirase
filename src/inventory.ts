import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import semver from "semver";
import type { Asset } from "./types";

const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", "build", ".venv"]);

// A tag or tool version as a line ("8.3" = 8.3.x); calendar or zero-padded numbers ("2024.01", "08.3") are not semver and are dropped.
function lineOf(spec: string): string | undefined {
  const line = spec.match(/\d+(?:\.\d+)?/)?.[0];
  return line && semver.validRange(line) ? line : undefined;
}

type Eco = "npm" | "composer" | "python";

const valid = (r: string) => (semver.validRange(r) ? r : undefined);

// Composer and Python ranges are rewritten into npm semver ranges, which matching hands to semver.
// Composer's ~1.2 and Python's ~=1.2 are >=1.2 <2 (with three parts, >=1.2.3 <1.3); == pins; != cannot be expressed and is dropped.
function toRange(spec: string, eco: Eco): string | undefined {
  const s = spec.trim();
  if (eco === "npm") return valid(s);
  const tilde = (v: string) => {
    const p = v.split(".").map(Number);
    return p.length >= 3 ? `>=${v} <${p[0]}.${p[1] + 1}` : `>=${v} <${p[0] + 1}`;
  };
  // Composer and PEP 440 pad a partial bound with zeros (>1.4 is >1.4.0), where npm reads it as the whole 1.4.x line.
  const pad = (v: string) => [...v.split("."), "0", "0"].slice(0, Math.max(3, v.split(".").length)).join(".");
  const one = (part: string): string | undefined => {
    const m = part.trim().match(/^(~=|~|==|!=|\^|>=|<=|>|<|=)?\s*v?([\d.*x]+)$/);
    if (!m) return undefined;
    const v = m[2].replace(/\.\*$/, ".x");
    if (m[1] === "!=") return "";
    const r = m[1]?.startsWith("~") ? tilde(v) : /^[<>]/.test(m[1] ?? "") ? `${m[1]}${pad(v)}` : `${m[1] === "^" ? "^" : ""}${v}`;
    return semver.validRange(r) ? r : undefined;
  };
  const glued = eco === "composer" ? s.replace(/(>=|<=|>|<|~|\^)\s+/g, "$1") : s;
  const alternatives = glued.split("||").map((alt) => alt.trim().split(eco === "python" ? /\s*,\s*/ : /\s*,\s*|\s+/).map(one));
  // Parts semver cannot express ("dev-main", "1.2.3.4", !=) are dropped: inside an AND that widens the range,
  // and a branch alternative such as "|| dev-main" has no version for a notice to name anyway.
  const range = alternatives.map((parts) => parts.filter(Boolean).join(" ")).filter(Boolean).join(" || ");
  return range ? valid(range) : undefined;
}

function fromPackageJson(text: string, src: string): Asset[] {
  const j = JSON.parse(text);
  const out: Asset[] = [];
  for (const key of ["dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries<string>(j[key] ?? {})) {
      out.push({ name, version: toRange(String(spec), "npm"), source: src });
    }
  }
  if (j.engines?.node) out.push({ name: "node", version: toRange(j.engines.node, "npm"), source: src });
  return out;
}

function fromComposerJson(text: string, src: string): Asset[] {
  const j = JSON.parse(text);
  return Object.entries<string>(j.require ?? {}).map(([name, spec]) => ({
    name,
    version: toRange(String(spec), "composer"),
    source: src,
  }));
}

function fromGoMod(text: string, src: string): Asset[] {
  const out: Asset[] = [];
  const go = text.match(/^go\s+(\d+\.\d+)/m);
  if (go) out.push({ name: "go", version: go[1], source: src });
  // Single-line replace/exclude never match the require pattern below; their blocks do.
  const requires = text.replace(/^\s*(?:replace|exclude|retract)\s*\([\s\S]*?^\s*\)/gm, "");
  for (const m of requires.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+v(\d+\.\d+)[^\n]*$/gm)) {
    if (m[0].includes("// indirect")) continue;
    out.push({ name: m[1], version: m[2], source: src });
  }
  return out;
}

function fromRequirements(text: string, src: string): Asset[] {
  return text
    .split("\n")
    .map((l) => l.replace(/#.*/, "").replace(/\s--\S.*$/, "").replace(/\\$/, "").trim())
    .filter((l) => l && !l.startsWith("-"))
    .map((l) => {
      const m = l.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*([=<>~!][^;#]*)?/);
      return { name: (m?.[1] ?? l).toLowerCase(), version: m?.[2] ? toRange(m[2], "python") : undefined, source: src };
    });
}

function fromPyproject(text: string, src: string): Asset[] {
  const t = Bun.TOML.parse(text) as { project?: { dependencies?: string[]; "requires-python"?: string } };
  const out = fromRequirements((t.project?.dependencies ?? []).join("\n"), src);
  const py = t.project?.["requires-python"];
  if (py) out.push({ name: "python", version: toRange(py, "python"), source: src });
  return out;
}

function fromDockerfile(text: string, src: string): Asset[] {
  const out: Asset[] = [];
  const stages = new Set<string>();
  for (const m of text.matchAll(/^\s*FROM\s+(?:--\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gim)) {
    const ref = m[1].split("@")[0];
    const fromStage = stages.has(ref.toLowerCase());
    if (m[2]) stages.add(m[2].toLowerCase());
    if (fromStage) continue;
    const slash = ref.lastIndexOf("/");
    const colon = ref.lastIndexOf(":");
    const [path, tag] = colon > slash ? [ref.slice(0, colon), ref.slice(colon + 1)] : [ref, undefined];
    const name = path.slice(slash + 1);
    if (name === "scratch" || ref.startsWith("$")) continue;
    out.push({ name, version: tag ? lineOf(tag) : undefined, source: src });
  }
  return out;
}

function fromMise(text: string, src: string): Asset[] {
  const t = Bun.TOML.parse(text) as { tools?: Record<string, unknown> };
  return Object.entries(t.tools ?? {}).flatMap(([name, v]) => {
    const specs = Array.isArray(v) ? v : [typeof v === "object" && v !== null ? (v as { version?: unknown }).version : v];
    return specs.map((spec) => ({ name, version: spec == null ? undefined : lineOf(String(spec)), source: src }));
  });
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
    } else if (Object.hasOwn(PARSERS, e.name) || e.name.startsWith("Dockerfile")) files.push(p);
  }
  return files;
}

export function scan(root: string): Asset[] {
  const out: Asset[] = [];
  const label = basename(resolve(root));
  for (const f of walk(root)) {
    const name = basename(f);
    const parse = Object.hasOwn(PARSERS, name) ? PARSERS[name] : fromDockerfile;
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
    for (const a of doc.assets ?? []) {
      // An unquoted 8.10 is the number 8.1 by the time it is read, so only strings are accepted.
      if (a.version != null && typeof a.version !== "string") throw new Error(`${p}: quote the version of ${a.name} ("${a.version}")`);
      if (a.version != null && !semver.validRange(a.version)) throw new Error(`${p}: version of ${a.name} must be an npm semver range ("8.3", "^15.0.0", ">=22 <24"), got "${a.version}"`);
      out.push({ ...a, source: a.source ?? basename(p) });
    }
  }
  return out;
}

#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { fetchFeed } from "./feeds";
import { loadInventory, scan } from "./inventory";
import { judge, type LlmConfig } from "./llm";
import { match } from "./match";
import { hitsLine, render, sendNtfy, writeAtom, type NtfyConfig, type Sent } from "./notify";
import type { FeedItem, Notice } from "./types";

type Config = {
  inventory: string[];
  feeds: { name: string; url: string; product?: string }[];
  maxAgeDays?: number;
  llm?: LlmConfig;
  ntfy?: NtfyConfig;
  rss?: { path: string; title?: string };
  state?: string;
};

type State = { seen: Record<string, string>; sent: Sent[] };

const RSS_KEEP = 100;

// Feeds are independent sources, so the same guid in two feeds must not suppress each other.
const seenKey = (item: FeedItem) => `${item.feed}\n${item.id}`;

function loadConfig(path: string): { cfg: Config; base: string } {
  const cfg = Bun.YAML.parse(readFileSync(path, "utf8")) as Config;
  if (!Array.isArray(cfg.inventory) || !Array.isArray(cfg.feeds)) throw new Error(`${path}: inventory and feeds are required`);
  return { cfg, base: dirname(resolve(path)) };
}

function loadState(path: string): State {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as State) : { seen: {}, sent: [] };
}

function saveState(path: string, s: State): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, path);
}

const program = new Command().name("mushirase").description("Push only the security notices that hit your stack");

program
  .command("scan")
  .description("print the assets found in the given repository checkouts as inventory YAML")
  .argument("<dir...>")
  .action((dirs: string[]) => {
    const assets = dirs.flatMap((d) => scan(d));
    console.log(Bun.YAML.stringify({ assets }, null, 2));
  });

program
  .command("run")
  .description("fetch feeds, match against the inventory, and notify the hits")
  .requiredOption("-c, --config <file>", "config YAML")
  .option("--dry-run", "print what would be sent; send nothing and keep the state untouched")
  .option("--max-age <days>", "ignore items older than this (overrides maxAgeDays)")
  .option("--all", "also print the items that did not match (dry-run inspection)")
  .action(async (opts: { config: string; dryRun?: boolean; maxAge?: string; all?: boolean }) => {
    const { cfg, base } = loadConfig(opts.config);
    const at = (p: string) => resolve(base, p);
    const assets = loadInventory(cfg.inventory.map(at));
    const statePath = at(cfg.state ?? ".mushirase/state.json");
    const state = loadState(statePath);
    const maxAge = Number(opts.maxAge ?? cfg.maxAgeDays ?? 7);
    if (!Number.isFinite(maxAge) || maxAge <= 0) throw new Error(`max age must be a positive number of days, got ${opts.maxAge ?? cfg.maxAgeDays}`);
    const cutoff = Date.now() - maxAge * 86_400_000;
    // shortcut: entries are kept for 90 days or maxAge, whichever is longer; a date-less item older than that would be pushed again.
    const keepSince = Date.now() - Math.max(maxAge, 90) * 86_400_000;
    if (!opts.dryRun) for (const [k, when] of Object.entries(state.seen)) if (Date.parse(when) < keepSince) delete state.seen[k];
    let failures = 0;
    let checked = 0;
    const notices: Notice[] = [];

    for (const f of cfg.feeds) {
      let items;
      try {
        items = await fetchFeed(f.name, f.url);
      } catch (e) {
        failures++;
        console.error(`feed failed: ${(e as Error).message}`);
        continue;
      }
      for (const item of items) {
        const key = seenKey(item);
        if (Object.hasOwn(state.seen, key)) continue;
        const t = item.published ? Date.parse(item.published) : NaN;
        // shortcut: items without a parsable date are treated as new; add a per-feed date override if a feed lacks dates.
        if (!Number.isNaN(t) && t < cutoff) continue;
        checked++;
        const n = match(item, assets, f.product);
        if (!n) {
          if (opts.all) console.log(`  -  ${f.name}: ${item.title}`);
          if (!opts.dryRun) state.seen[key] = new Date().toISOString();
          continue;
        }
        if (cfg.llm) {
          try {
            const v = await judge(cfg.llm, n);
            n.note = v.reason;
            if (!v.relevant) {
              // Not marked as seen: a wrong verdict is judged again on the next run, or surfaces once the LLM is turned off.
              console.log(`  x  ${f.name}: ${item.title} (LLM: ${v.reason})`);
              continue;
            }
          } catch (e) {
            // Keep the rule hit: dropping on an LLM outage would silently miss a must-read notice.
            n.note = `LLM 判定失敗 (${(e as Error).message})、キーワード照合のみ`;
          }
        }
        notices.push(n);
      }
    }

    for (const n of notices) {
      const r = render(n);
      console.log(`  ✔  ${r.title}\n     当たり: ${hitsLine(n)}${n.note ? `\n     判定: ${n.note}` : ""}\n     ${n.item.link}`);
      if (opts.dryRun) continue;
      if (cfg.ntfy) {
        try {
          await sendNtfy(cfg.ntfy, n);
        } catch (e) {
          // Not marked as seen, so the next run retries it.
          failures++;
          console.error(`ntfy failed for ${n.item.link}: ${(e as Error).message}`);
          continue;
        }
      }
      const now = new Date().toISOString();
      state.seen[seenKey(n.item)] = now;
      state.sent.unshift({ notice: n, at: now });
    }

    console.log(`checked ${checked} new items against ${assets.length} assets: ${notices.length} hit, ${failures} failure(s)${opts.dryRun ? " (dry-run)" : ""}`);
    if (!opts.dryRun) {
      state.sent = state.sent.slice(0, RSS_KEEP);
      saveState(statePath, state);
      if (cfg.rss) writeAtom(at(cfg.rss.path), cfg.rss.title ?? "mushirase", state.sent);
    }
    if (failures > 0) process.exit(1);
  });

await program.parseAsync();

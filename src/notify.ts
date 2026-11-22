import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { authHeader } from "./llm";
import type { Notice } from "./types";

const KIND_JA = { "pre-announcement": "予告", release: "修正版", report: "報告" } as const;

export function hitsLine(n: Notice): string {
  const bySpec = new Map<string, Set<string>>();
  for (const a of n.hits) {
    const key = `${a.name}${a.version ? ` ${a.version}` : ""}`;
    if (!bySpec.has(key)) bySpec.set(key, new Set());
    bySpec.get(key)!.add(a.source.split("/")[0]);
  }
  return [...bySpec].map(([k, srcs]) => `${k} (${[...srcs].join(", ")})`).join(" / ");
}

export function render(n: Notice): { title: string; message: string } {
  return {
    title: `[${KIND_JA[n.kind]}] ${n.item.title}`,
    message: [`当たり: ${hitsLine(n)}`, n.note ? `判定: ${n.note}` : "", n.item.summary.slice(0, 300)].filter(Boolean).join("\n"),
  };
}

export type NtfyConfig = { url: string; topic: string; tokenEnv?: string };

export async function sendNtfy(cfg: NtfyConfig, n: Notice): Promise<void> {
  const { title, message } = render(n);
  // JSON publish: header publishing cannot carry non-Latin-1 titles.
  const res = await fetch(cfg.url.replace(/\/$/, ""), {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", ...authHeader(cfg.tokenEnv) },
    body: JSON.stringify({ topic: cfg.topic, title, message, click: n.item.link, priority: n.kind === "pre-announcement" ? 4 : 3, tags: ["rotating_light"] }),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}

// Control characters other than tab and newlines are not allowed in XML 1.0, so they are dropped.
const x = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type Sent = { notice: Notice; at: string };

export function atom(title: string, sent: Sent[]): string {
  const entries = sent.map(({ notice, at }) => {
    const r = render(notice);
    return `  <entry>\n    <id>urn:mushirase:${x(`${encodeURIComponent(notice.item.feed)}:${encodeURIComponent(notice.item.id)}`)}</id>\n    <title>${x(r.title)}</title>\n    <link href="${x(notice.item.link)}"/>\n    <updated>${at}</updated>\n    <content type="text">${x(r.message)}</content>\n  </entry>`;
  });
  const updated = sent[0]?.at ?? new Date(0).toISOString();
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <id>urn:mushirase:${x(encodeURIComponent(title))}</id>\n  <title>${x(title)}</title>\n  <updated>${updated}</updated>\n  <author><name>mushirase</name></author>\n${entries.join("\n")}\n</feed>\n`;
}

export type UploadConfig = { url: string; userEnv?: string; passwordEnv?: string };

// PUT the feed where a reader can fetch it (a WebDAV folder the run can write but not read is enough).
export async function uploadAtom(cfg: UploadConfig, body: string): Promise<void> {
  const user = cfg.userEnv ? process.env[cfg.userEnv] : undefined;
  const pass = cfg.passwordEnv ? process.env[cfg.passwordEnv] : undefined;
  if ((cfg.userEnv || cfg.passwordEnv) && !(user && pass)) {
    const missing = [
      ["userEnv", cfg.userEnv, user],
      ["passwordEnv", cfg.passwordEnv, pass],
    ]
      .filter(([, , value]) => !value)
      .map(([key, name]) => name ?? key);
    throw new Error(`upload: ${missing.join(" and ")} not set (basic auth needs both)`);
  }
  // Basic auth is plain text on the wire, so credentials only go over https or to this machine.
  const target = new URL(cfg.url);
  if (user && pass && target.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
    throw new Error(`upload: credentials are only sent over https or to localhost, got ${target.protocol}//${target.hostname}`);
  }
  const auth: Record<string, string> = user && pass ? { authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") } : {};
  const res = await fetch(cfg.url, {
    method: "PUT",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/atom+xml; charset=utf-8", ...auth },
    body,
  });
  if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
}

// Written to a temporary file and renamed, so a reader never sees a half-written feed.
export function writeAtom(path: string, title: string, sent: Sent[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, atom(title, sent));
  renameSync(`${path}.tmp`, path);
}

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mushirase-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const now = new Date().toUTCString();
const rss = `<rss><channel>${[1, 2]
  .map((i) => `<item><guid>g${i}</guid><title>Upcoming PHP Security Release ${i}</title><link>https://x/${i}</link><pubDate>${now}</pubDate></item>`)
  .join("")}</channel></rss>`;

test("a run stopped after the first push keeps it recorded, and the next run pushes only the rest", async () => {
  let pushes = 0;
  let hang = true;
  const titles: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/feed") return new Response(rss);
      pushes++;
      return req.json().then((b: { title: string }) => {
        titles.push(b.title);
        // The second push of the first run never answers, as if the run were cut off mid-send.
        return hang && pushes === 2 ? new Promise<Response>(() => {}) : new Response("{}");
      });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  writeFileSync(join(dir, "stack.yaml"), 'assets:\n  - { name: php, version: "8.3" }\n');
  writeFileSync(join(dir, "cfg.yaml"), `inventory: [stack.yaml]\nfeeds:\n  - { name: php, url: "${base}/feed", product: php }\nntfy: { url: "${base}", topic: t }\nrss: { path: feed.atom }\nstate: state.json\n`);
  const cli = [process.execPath, join(import.meta.dir, "../src/cli.ts"), "run", "-c", join(dir, "cfg.yaml")];

  const first = Bun.spawn(cli, { stdout: "ignore", stderr: "inherit" });
  const deadline = Date.now() + 10_000;
  while (pushes < 2 && Date.now() < deadline) await Bun.sleep(20);
  first.kill();
  await first.exited;

  expect(titles.length).toBe(2);
  const seen = Object.keys(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).seen);
  expect(seen).toEqual(["php\ng1"]);
  expect(readFileSync(join(dir, "feed.atom"), "utf8")).toContain("Release 1</title>");

  hang = false;
  const second = Bun.spawn(cli, { stdout: "ignore", stderr: "inherit" });
  expect(await second.exited).toBe(0);
  server.stop(true);

  expect(titles.slice(2)).toEqual(["[予告] Upcoming PHP Security Release 2"]);
  expect(existsSync(join(dir, "state.json"))).toBe(true);
});

test("the feed is PUT to the upload URL with basic auth, and a rejected upload exits 1", async () => {
  const puts: { path: string; auth: string | null; type: string | null; body: string }[] = [];
  let status = 201;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/feed") return new Response(rss.replace(/Release (\d)/g, "Release up$1"));
      if (req.method === "PUT") {
        puts.push({ path, auth: req.headers.get("authorization"), type: req.headers.get("content-type"), body: await req.text() });
        return status === 302 ? new Response(null, { status, headers: { location: "/elsewhere" } }) : new Response(null, { status });
      }
      return new Response("{}");
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const up = join(dir, "upload");
  mkdirSync(up);
  writeFileSync(join(up, "stack.yaml"), 'assets:\n  - { name: php, version: "8.3" }\n');
  const cfg = (auth: string, path = "path: feed.atom, ") =>
    writeFileSync(join(up, "cfg.yaml"), `inventory: [stack.yaml]\nfeeds:\n  - { name: php, url: "${base}/feed", product: php }\nntfy: { url: "${base}", topic: t }\nrss: { ${path}upload: { url: "${base}/dav/feed.atom"${auth} } }\nstate: state.json\n`);
  const run = async (env: Record<string, string>) => {
    const clean = { ...process.env };
    delete clean.U;
    delete clean.P;
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "run", "-c", join(up, "cfg.yaml")], { env: { ...clean, ...env }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };

  cfg(", userEnv: U, passwordEnv: P");
  expect((await run({ U: "writer", P: "secret" })).code).toBe(0);
  expect(puts.length).toBe(1);
  expect(puts[0].path).toBe("/dav/feed.atom");
  expect(puts[0].auth).toBe("Basic " + Buffer.from("writer:secret").toString("base64"));
  expect(puts[0].type).toBe("application/atom+xml; charset=utf-8");
  expect(puts[0].body).toStartWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">');
  expect(puts[0].body).toContain("<title>[予告] Upcoming PHP Security Release up1</title>");
  expect(puts[0].body).toContain("<title>[予告] Upcoming PHP Security Release up2</title>");

  status = 403;
  const rejected = await run({ U: "writer", P: "secret" });
  expect(rejected.code).toBe(1);
  expect(rejected.err).toContain(`rss upload failed (127.0.0.1:${server.port}/dav/feed.atom): upload HTTP 403`);
  expect(rejected.out).toContain("0 hit, 1 failure(s)");

  status = 302;
  const redirected = await run({ U: "writer", P: "secret" });
  expect(redirected.code).toBe(1);
  expect(puts.map((p) => p.path)).toEqual(["/dav/feed.atom", "/dav/feed.atom", "/dav/feed.atom"]);

  status = 201;
  const missing = await run({ U: "writer" });
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("upload: P not set (basic auth needs both)");
  expect(puts.length).toBe(3);

  cfg("", "");
  expect((await run({})).code).toBe(0);
  expect(puts.length).toBe(4);
  expect(puts[3].auth).toBeNull();

  server.stop(true);
});

test("rss split by kind writes pre-announcements and fixes to separate feeds", async () => {
  const mixed = `<rss><channel>
<item><guid>p</guid><title>Upcoming PHP Security Release</title><link>https://x/p</link><pubDate>${now}</pubDate></item>
<item><guid>f</guid><title>PHP 8.3.30 Released</title><description>This is a security release.</description><link>https://x/f</link><pubDate>${now}</pubDate></item>
</channel></rss>`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => (new URL(req.url).pathname === "/feed" ? new Response(mixed) : new Response("{}")),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const sp = join(dir, "split");
  mkdirSync(sp);
  writeFileSync(join(sp, "stack.yaml"), 'assets:\n  - { name: php, version: "8.3" }\n');
  writeFileSync(join(sp, "cfg.yaml"), `inventory: [stack.yaml]\nfeeds:\n  - { name: php, url: "${base}/feed", product: php }\nntfy: { url: "${base}", topic: t }\nrss:\n  - { path: pre.atom, kind: pre-announcement }\n  - { path: fix.atom, kind: fix }\n  - { path: all.atom }\nstate: state.json\n`);
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "run", "-c", join(sp, "cfg.yaml")], { stdout: "ignore", stderr: "ignore" });
  expect(await p.exited).toBe(0);
  server.stop(true);

  const pre = readFileSync(join(sp, "pre.atom"), "utf8");
  const fix = readFileSync(join(sp, "fix.atom"), "utf8");
  const all = readFileSync(join(sp, "all.atom"), "utf8");
  expect(pre).toContain("<title>[予告] Upcoming PHP Security Release</title>");
  expect(pre).not.toContain("8.3.30");
  expect(fix).toContain("<title>[修正] PHP 8.3.30 Released</title>");
  expect(fix).not.toContain("Upcoming");
  expect(all).toContain("Upcoming");
  expect(all).toContain("8.3.30");
  const idOf = (xml: string) => xml.match(/<feed[^>]*>\s*<id>([^<]+)<\/id>/)?.[1];
  expect(idOf(pre)).toBe("urn:mushirase:mushirase%20pre-announcement");
  expect(idOf(fix)).toBe("urn:mushirase:mushirase%20fix");
  expect(idOf(all)).toBe("urn:mushirase:mushirase");
});

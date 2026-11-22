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
  const puts: { auth: string | null; type: string | null; body: string }[] = [];
  let status = 201;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/feed") return new Response(rss.replace(/Release (\d)/g, "Release up$1"));
      if (req.method === "PUT") {
        puts.push({ auth: req.headers.get("authorization"), type: req.headers.get("content-type"), body: await req.text() });
        return new Response(null, { status });
      }
      return new Response("{}");
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const up = join(dir, "upload");
  mkdirSync(up);
  writeFileSync(join(up, "stack.yaml"), 'assets:\n  - { name: php, version: "8.3" }\n');
  writeFileSync(join(up, "cfg.yaml"), `inventory: [stack.yaml]\nfeeds:\n  - { name: php, url: "${base}/feed", product: php }\nntfy: { url: "${base}", topic: t }\nrss: { path: feed.atom, upload: { url: "${base}/dav/feed.atom", userEnv: U, passwordEnv: P } }\nstate: state.json\n`);
  const run = (env: Record<string, string>) =>
    Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "run", "-c", join(up, "cfg.yaml")], { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" }).exited;

  expect(await run({ U: "writer", P: "secret" })).toBe(0);
  expect(puts.length).toBe(1);
  expect(puts[0].auth).toBe("Basic " + Buffer.from("writer:secret").toString("base64"));
  expect(puts[0].type).toBe("application/atom+xml; charset=utf-8");
  expect(puts[0].body).toContain("Release up2</title>");

  status = 403;
  expect(await run({ U: "writer", P: "secret" })).toBe(1);
  expect(puts.length).toBe(2);

  status = 201;
  expect(await run({ U: "writer" })).toBe(1);
  expect(puts.length).toBe(2);

  server.stop(true);
});

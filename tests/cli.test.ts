import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mushirase-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const now = new Date().toUTCString();
const rss = `<rss><channel>${[1, 2]
  .map((i) => `<item><guid>g${i}</guid><title>Upcoming PHP Security Release ${i}</title><link>https://x/${i}</link><pubDate>${now}</pubDate></item>`)
  .join("")}</channel></rss>`;

test("a run stopped after the first push keeps that push recorded", async () => {
  let pushes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/feed") return new Response(rss);
      pushes++;
      // The second push never answers, as if the run were cut off mid-send.
      return pushes === 1 ? new Response("{}") : new Promise<Response>(() => {});
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  writeFileSync(join(dir, "stack.yaml"), 'assets:\n  - { name: php, version: "8.3" }\n');
  writeFileSync(join(dir, "cfg.yaml"), `inventory: [stack.yaml]\nfeeds:\n  - { name: php, url: "${base}/feed", product: php }\nntfy: { url: "${base}", topic: t }\nstate: state.json\n`);

  const child = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "run", "-c", join(dir, "cfg.yaml")], { stdout: "ignore", stderr: "ignore" });
  const deadline = Date.now() + 10_000;
  while (pushes < 2 && Date.now() < deadline) await Bun.sleep(20);
  child.kill();
  await child.exited;
  server.stop(true);

  expect(pushes).toBe(2);
  expect(existsSync(join(dir, "state.json"))).toBe(true);
  const seen = Object.keys(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).seen);
  expect(seen).toEqual(["php\ng1"]);
});

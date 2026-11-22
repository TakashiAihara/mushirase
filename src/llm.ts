import type { Notice } from "./types";

// reasoningEffort: "none" turns thinking off on Ollama, which cuts a call from ~75 s to ~1 s with qwen3.5:9b.
export type LlmConfig = { url: string; model: string; apiKeyEnv?: string; reasoningEffort?: string };

export type Verdict = { relevant: boolean; reason: string };

function authHeader(env?: string): Record<string, string> {
  const v = env ? process.env[env] : undefined;
  return v ? { authorization: "Bearer " + v } : {};
}

// Second opinion on a rule hit, through any OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter...).
export async function judge(cfg: LlmConfig, n: Notice): Promise<Verdict> {
  const assets = [...new Set(n.hits.map((a) => `${a.name}${a.version ? ` ${a.version}` : ""}`))].join(", ");
  const prompt = [
    "You filter security notices for an engineering team. A notice is relevant only if it is about a security fix, vulnerability, compromise, or an announced upcoming security release that affects one of the team's assets (respecting version lines when stated).",
    `Team assets that matched by keyword: ${assets}`,
    `Notice title: ${n.item.title}`,
    `Notice body: ${n.item.summary.slice(0, 3000)}`,
    'Answer only JSON: {"relevant": true|false, "reason": "<one short sentence in Japanese>"}',
  ].join("\n\n");
  const res = await fetch(`${cfg.url.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: { "content-type": "application/json", ...authHeader(cfg.apiKeyEnv) },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: prompt }], temperature: 0, response_format: { type: "json_object" }, ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}) }),
  });
  if (!res.ok) throw new Error(`llm HTTP ${res.status}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  const raw = body.choices[0]?.message.content ?? "";
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("llm: no JSON in answer");
  const v = JSON.parse(json) as Verdict;
  if (typeof v.relevant !== "boolean") throw new Error("llm: relevant is not boolean");
  return v;
}

export { authHeader };

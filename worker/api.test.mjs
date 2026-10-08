import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

const TOKEN = "test-token-not-a-real-credential";
const assetCalls = [];
const env = {
  ASSETS: { fetch: async (r) => { assetCalls.push(new URL(r.url).pathname); return new Response("asset"); } },
  NEWSROOM_API_TOKEN: TOKEN,
  GROQ_API_KEY: "placeholder-value",
};
const call = (path, init) => worker.fetch(new Request("https://example.com" + path, init), env);
const auth = { authorization: "Bearer " + TOKEN };

test("static paths go to ASSETS", async () => {
  const r = await call("/css/styles.css");
  assert.equal(await r.text(), "asset");
  assert.deepEqual(assetCalls, ["/css/styles.css"]);
});
test("health is public", async () => {
  const r = await call("/api/health");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});
test("unknown api path is 404 json", async () => {
  assert.equal((await call("/api/nope")).status, 404);
});
test("protected routes reject missing/wrong token", async () => {
  assert.equal((await call("/api/newsroom/status")).status, 401);
  assert.equal((await call("/api/newsroom/status", { headers: { authorization: "Bearer wrong" } })).status, 401);
});
test("protected routes are closed when token secret is unset", async () => {
  const r = await worker.fetch(new Request("https://example.com/api/newsroom/status", { headers: auth }), { ASSETS: env.ASSETS });
  assert.equal(r.status, 503);
});
test("status reports booleans only, never values", async () => {
  const r = await call("/api/newsroom/status", { headers: auth });
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(text).providers.groq, { configured: true });
  assert.deepEqual(JSON.parse(text).providers.gemini, { configured: false });
  assert.ok(!text.includes("placeholder-value") && !text.includes(TOKEN));
});
test("ai route: method, provider and config checks", async () => {
  assert.equal((await call("/api/newsroom/ai/groq", { headers: auth })).status, 405);
  assert.equal((await call("/api/newsroom/ai/bogus", { method: "POST", headers: auth })).status, 404);
  assert.equal((await call("/api/newsroom/ai/gemini", { method: "POST", headers: auth })).status, 503);
  assert.equal((await call("/api/newsroom/ai/groq", { method: "POST", headers: auth })).status, 501);
});

// Key routing dashboard (spec 2026-09-29): AC tests for GET /api/providers/[id]/key-routing
// AC1 keys masked, raw key never returned
// AC2 pins reported for this provider only
// AC3 usage aggregated per key × account, scoped to provider, last 24h only
// AC4 usage from other providers' accounts excluded from byAccount
// AC5 window fixed at 24h: older rows ignored, period param ignored
// AC6 keys with no usage still listed (load 0)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, route, k1, k2, k3, accA, accB, accX;

const call = async (provider, query = "") => {
  const res = await route.GET(
    new Request(`http://localhost/api/providers/${provider}/key-routing${query}`),
    { params: Promise.resolve({ id: provider }) }
  );
  return { status: res.status, body: await res.json() };
};

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const insert = async (apiKey, connectionId, provider, ts, p, c) => {
  const a = await (await import("@/lib/db/driver.js")).getAdapter();
  a.run(`INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, promptTokens, completionTokens, cost, status)
         VALUES(?, ?, 'm', ?, ?, ?, ?, 0.01, 'ok')`, [ts, provider, connectionId, apiKey, p, c]);
};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-keyroute-"));
  process.env.DATA_DIR = tempDir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
  route = await import("@/app/api/providers/[id]/key-routing/route.js");

  accA = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "acc-A", apiKey: "sk-A" });
  accB = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "acc-B", apiKey: "sk-B" });
  accX = await db.createProviderConnection({ provider: "anthropic", authType: "apikey", name: "acc-X", apiKey: "sk-X" });
  k1 = await db.createApiKey("K1", "m1");
  k2 = await db.createApiKey("K2", "m1");
  k3 = await db.createApiKey("K3", "m1");
  await db.setKeyAccounts(k1.id, { openai: accA.id, anthropic: accX.id });
  await db.setKeyAccounts(k2.id, { anthropic: accX.id });

  const H = 3600000;
  await insert(k1.key, accA.id, "openai", ago(1 * H), 100, 50);       // in 24h
  await insert(k1.key, accB.id, "openai", ago(23 * H), 200, 0);       // in 24h
  await insert(k1.key, accX.id, "anthropic", ago(1 * H), 999, 999);   // other provider
  await insert(k2.key, accA.id, "openai", ago(25 * H), 500, 0);       // just outside 24h
  await insert("sk-unknown-raw", accA.id, "openai", ago(1 * H), 7, 7); // deleted key
});

afterAll(() => {
  process.env.DATA_DIR = originalDataDir;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("GET /api/providers/[id]/key-routing", () => {
  it("AC1 masks keys and never leaks raw key", async () => {
    const { status, body } = await call("openai");
    expect(status).toBe(200);
    const raw = JSON.stringify(body);
    for (const k of [k1, k2, k3]) expect(raw).not.toContain(k.key);
    expect(raw).not.toContain("sk-unknown-raw");
    expect(body.keys.every((k) => k.masked.includes("***") && !("key" in k))).toBe(true);
  });

  it("AC2 reports pins for this provider only", async () => {
    const { body } = await call("openai");
    const pin = Object.fromEntries(body.keys.map((k) => [k.id, k.pinned]));
    expect(pin[k1.id]).toBe(accA.id);
    expect(pin[k2.id]).toBeNull();
    expect(body.accounts.map((a) => a.id).sort()).toEqual([accA.id, accB.id].sort());
  });

  it("AC3 aggregates per key × account within 24h", async () => {
    const { body } = await call("openai");
    const u = body.usage[k1.id];
    expect(u.req).toBe(2);
    expect(u.tokens).toBe(350);
    expect(u.byAccount[accA.id].tokens).toBe(150);
    expect(u.byAccount[accB.id].tokens).toBe(200);
    expect(body.usage[k2.id]).toBeUndefined(); // 25h old
  });

  it("AC4 excludes other provider traffic", async () => {
    const { body } = await call("openai");
    expect(body.usage[k1.id].byAccount[accX.id]).toBeUndefined();
    const { body: anth } = await call("anthropic");
    expect(anth.usage[k1.id].tokens).toBe(1998);
  });

  it("AC5 window is fixed at 24h; period param is ignored", async () => {
    const { body } = await call("openai", "?period=7d");
    expect(body.usage[k1.id].tokens).toBe(350);
    expect(body.usage[k2.id]).toBeUndefined();
    expect("period" in body).toBe(false);
  });

  it("AC6 lists keys without usage", async () => {
    const { body } = await call("openai");
    expect(body.keys.find((k) => k.id === k3.id)).toBeTruthy();
    expect(body.usage[k3.id]).toBeUndefined();
  });

  it('AC7 PATCH fallback toggles per provider and validates input', async () => {
    const patch = (id, body) => route.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    expect((await patch('openai', { fallback: 'yes' })).status).toBe(400);
    expect((await patch('__proto__', { fallback: true })).status).toBe(400);
    expect((await patch('openai', { fallback: true })).status).toBe(200);
    expect((await call('openai')).body.fallback).toBe(true);
    expect((await call('anthropic')).body.fallback).toBe(false);
    await patch('openai', { fallback: false });
    expect((await call('openai')).body.fallback).toBe(false);
  });
});

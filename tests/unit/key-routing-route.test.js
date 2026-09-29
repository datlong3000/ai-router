// Key routing dashboard (spec 2026-09-29): AC tests for GET /api/providers/[id]/key-routing
// AC1 keys masked, raw key never returned
// AC2 pins reported for this provider only
// AC3 usage aggregated per key × account, scoped to provider + period
// AC4 usage from other providers' accounts excluded from byAccount
// AC5 period param: 24h vs 7d, invalid → 7d
// AC6 keys with no usage still listed (load 0)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, route, k1, k2, k3, accA, accB, accX;

const call = async (provider, period) => {
  const res = await route.GET(
    new Request(`http://localhost/api/providers/${provider}/key-routing${period ? `?period=${period}` : ""}`),
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
  await insert(k1.key, accB.id, "openai", ago(2 * 24 * H), 200, 0);   // 7d only
  await insert(k1.key, accX.id, "anthropic", ago(1 * H), 999, 999);   // other provider
  await insert(k2.key, accA.id, "openai", ago(10 * 24 * H), 500, 0);  // outside 7d
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

  it("AC3+AC5 aggregates per key × account within 7d by default", async () => {
    const { body } = await call("openai");
    expect(body.period).toBe("7d");
    const u = body.usage[k1.id];
    expect(u.req).toBe(2);
    expect(u.tokens).toBe(350);
    expect(u.byAccount[accA.id].tokens).toBe(150);
    expect(u.byAccount[accB.id].tokens).toBe(200);
    expect(body.usage[k2.id]).toBeUndefined(); // 10d old
  });

  it("AC4 excludes other provider traffic", async () => {
    const { body } = await call("openai");
    expect(body.usage[k1.id].byAccount[accX.id]).toBeUndefined();
    const { body: anth } = await call("anthropic");
    expect(anth.usage[k1.id].tokens).toBe(1998);
  });

  it("AC5 24h narrows window; invalid period falls back to 7d", async () => {
    const { body } = await call("openai", "24h");
    expect(body.usage[k1.id].tokens).toBe(150);
    expect((await call("openai", "'; DROP TABLE x;--")).body.period).toBe("7d");
  });

  it("AC6 lists keys without usage", async () => {
    const { body } = await call("openai");
    expect(body.keys.find((k) => k.id === k3.id)).toBeTruthy();
    expect(body.usage[k3.id]).toBeUndefined();
  });
});

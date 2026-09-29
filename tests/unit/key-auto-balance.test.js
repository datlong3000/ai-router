// Key auto-balance (spec 2026-09-29): scheduled Suggest + auto-apply with guardrails and undo.
// AB1 limitMoves: skips when gain < 10%
// AB2 limitMoves: caps at 3 moves, picks biggest gains
// AB3 limitMoves: skips keys used in the last 60s
// AB4 limitMoves: moving load off an exhausted account always applies
// AB5 runAutoBalance applies moves, never auto-pins unpinned keys, logs the run
// AB6 undoLastRun reverts, leaves keys re-pinned by someone else, is one-shot
// AB7 scheduler only runs providers whose interval has elapsed
// AB8 PATCH autoEveryH validation; POST /auto action validation
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { limitMoves } from "../../src/lib/keyRoutingPlan.js";

// Quota upstream: every account reports full weekly capacity
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  GET: async () => new Response(JSON.stringify({ quotas: { weekly: { remaining: 100, total: 100 } } })),
}));

const H = 3600000;
const caps3 = { a: 100, b: 100, c: 100 };

describe("limitMoves guardrails", () => {
  it("AB1 skips small gains", () => {
    const loads = { k1: 100, k2: 100, k3: 105 };
    const pins = { k1: "a", k2: "b", k3: "c" };
    const r = limitMoves({ changes: [{ keyId: "k3", from: "c", to: "a" }], loads, caps: caps3, pins });
    expect(r.moves).toEqual([]);
  });

  it("AB2 caps at 3 moves, biggest gains first", () => {
    const loads = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 100]));
    const pins = Object.fromEntries(Object.keys(loads).map((k) => [k, "a"]));
    const changes = Object.keys(loads).slice(0, 6).map((k, i) => ({ keyId: k, from: "a", to: i % 2 ? "b" : "c" }));
    const r = limitMoves({ changes, loads, caps: caps3, pins });
    expect(r.moves).toHaveLength(3);
    expect(r.after).toBeLessThan(r.before);
  });

  it("AB3 leaves busy keys alone", () => {
    const loads = { k1: 100, k2: 100 };
    const pins = { k1: "a", k2: "a" };
    const now = 10 * H;
    const r = limitMoves({ changes: [{ keyId: "k2", from: "a", to: "b" }], loads, caps: { a: 100, b: 100 }, pins, lastUsed: { k2: now - 5000 }, now });
    expect(r.moves).toEqual([]);
  });

  it("AB4 always rescues load stuck on an exhausted account", () => {
    const loads = { k1: 100, k2: 1 };
    const pins = { k1: "b", k2: "a" };
    const r = limitMoves({ changes: [{ keyId: "k1", from: "b", to: "a" }], loads, caps: { a: 100, b: 0 }, pins });
    expect(r.moves).toHaveLength(1);
  });
});

describe("runAutoBalance / undo / scheduler", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir, db, ab, a, b, c, keys;

  const insertUsage = async (apiKey, connectionId, tokens, ts) => {
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run(`INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, promptTokens, completionTokens, cost, status)
                 VALUES(?, 'openai', 'm', ?, ?, ?, 0, 0, 'ok')`, [ts, connectionId, apiKey, tokens]);
  };

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-autobal-"));
    process.env.DATA_DIR = tempDir;
    db = await import("@/lib/db/index.js");
    await db.initDb();
    ab = await import("@/lib/keyAutoBalance.js");
    a = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "A", apiKey: "sk-a" });
    b = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "B", apiKey: "sk-b" });
    c = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "C", apiKey: "sk-c" });
    keys = [];
    for (let i = 0; i < 6; i++) keys.push(await db.createApiKey(`K${i}`, "m1"));
    keys.push(await db.createApiKey("unpinned", "m1"));
    const old = new Date(Date.now() - 2 * H).toISOString();
    for (const k of keys) await insertUsage(k.key, a.id, 1000, old);
  }, 60000);

  beforeEach(async () => {
    // All 6 pinned to A (overloaded), plus one unpinned key
    for (const k of keys.slice(0, 6)) await db.setKeyAccounts(k.id, { openai: a.id });
    await db.setKeyAccounts(keys[6].id, {});
    await db.updateSettings({ keyAutoBalance: {} });
  });

  afterAll(() => {
    process.env.DATA_DIR = originalDataDir;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  const pinOf = async (k) => (await db.getKeyAccounts(k.id)).openai || null;

  it("AB5 applies ≤3 moves, never pins unpinned keys, logs run", async () => {
    const last = await ab.runAutoBalance("openai");
    expect(last.moves.length).toBeGreaterThan(0);
    expect(last.moves.length).toBeLessThanOrEqual(3);
    expect(await pinOf(keys[6])).toBeNull();
    const moved = await Promise.all(keys.slice(0, 6).map(pinOf));
    expect(moved.filter((p) => p !== a.id)).toHaveLength(last.moves.length);
    const state = (await db.getSettings()).keyAutoBalance.openai;
    expect(state.last.moves).toEqual(last.moves);
    expect(state.lastRunAt).toBe(last.at);
  });

  it("AB6 undo reverts, skips keys re-pinned since, one-shot", async () => {
    const last = await ab.runAutoBalance("openai");
    const [m0, m1] = last.moves;
    await db.setKeyAccounts(m1.keyId, { openai: c.id === m1.to ? b.id : c.id }); // someone changed it
    const r = await ab.undoLastRun("openai");
    expect(r.reverted).toBe(last.moves.length - 1);
    expect((await db.getKeyAccounts(m0.keyId)).openai).toBe(a.id);
    expect((await db.getKeyAccounts(m1.keyId)).openai).not.toBe(a.id);
    expect((await ab.undoLastRun("openai")).reverted).toBe(0);
  });

  it("AB7 scheduler respects interval", async () => {
    const now = Date.now();
    await db.updateSettings({ keyAutoBalance: { openai: { everyH: 3, lastRunAt: new Date(now - 1 * H).toISOString() } } });
    await ab.tickAutoBalance(now);
    expect((await db.getSettings()).keyAutoBalance.openai.last).toBeUndefined();
    await ab.tickAutoBalance(now + 2.5 * H);
    expect((await db.getSettings()).keyAutoBalance.openai.last).toBeTruthy();
  });

  it("AB8 route validation", async () => {
    const kr = await import("@/app/api/providers/[id]/key-routing/route.js");
    const auto = await import("@/app/api/providers/[id]/key-routing/auto/route.js");
    const p = (id) => ({ params: Promise.resolve({ id }) });
    const patch = (body) => kr.PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), p("openai"));
    expect((await patch({ autoEveryH: 2 })).status).toBe(400);
    expect((await patch({ autoEveryH: "3" })).status).toBe(400);
    expect((await patch({ autoEveryH: 6 })).status).toBe(200);
    expect((await db.getSettings()).keyAutoBalance.openai.everyH).toBe(6);
    expect((await patch({ autoEveryH: null })).status).toBe(200);
    const post = (id, body) => auto.POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), p(id));
    expect((await post("openai", { action: "nuke" })).status).toBe(400);
    expect((await post("__proto__", { action: "undo" })).status).toBe(400);
    expect((await post("openai", { action: "undo" })).status).toBe(200);
  });
});

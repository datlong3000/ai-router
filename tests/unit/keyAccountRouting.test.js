// API key → provider account pinning (spec 2026-09-28, Tests 1-8)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Upstream call is mocked: first call fails with 429 so we can prove no fallback.
const coreCalls = [];
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(async ({ connectionId }) => {
    coreCalls.push(connectionId);
    return { success: false, status: 429, error: "rate limited", response: new Response("{}", { status: 429 }) };
  }),
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, auth, routing, chat;
let keyA1, keyA2, keyNoMap, accA, accB, accOther;

const req = (key, model = "openai/gpt-4o") => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
}, 60000);

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-keyacc-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  auth = await import("@/sse/services/auth.js");
  routing = await import("@/sse/services/keyAccountRouting.js");
  chat = await import("@/sse/handlers/chat.js");

  accA = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "acc-A", apiKey: "sk-A", priority: 1 });
  accB = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "acc-B", apiKey: "sk-B", priority: 2 });
  accOther = await db.createProviderConnection({ provider: "anthropic", authType: "apikey", name: "acc-C", apiKey: "sk-C" });
  keyA1 = await db.createApiKey("A1", "m1");
  keyA2 = await db.createApiKey("A2", "m1");
  keyNoMap = await db.createApiKey("none", "m1");
  await db.setKeyAccounts(keyA1.id, { openai: accA.id });
  await db.setKeyAccounts(keyA2.id, { openai: accA.id });
}, 60000);

afterAll(() => {
  try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} // Windows: DB file still open
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
}, 60000);

beforeEach(async () => {
  coreCalls.length = 0;
  await db.updateSettings({ requireApiKey: false, strictKeyAccountRouting: false });
  await db.updateProviderConnection(accA.id, { isActive: true });
}, 60000);

const scope = (key, provider = "openai", strict = false) =>
  routing.getKeyAccountScope(key, provider, { strictKeyAccountRouting: strict });

describe("keyAccountRouting", () => {
  it("1. pinned key gets credentials from its account", async () => {
    const s = await scope(keyA1.key);
    expect([...s.allowedConnectionIds]).toEqual([accA.id]);
    const creds = await auth.getProviderCredentials("openai", null, "gpt-4o", { allowedConnectionIds: s.allowedConnectionIds });
    expect(creds.connectionId).toBe(accA.id);
  });

  it("2. two keys can share one account", async () => {
    for (const k of [keyA1, keyA2]) {
      const s = await scope(k.key);
      const creds = await auth.getProviderCredentials("openai", null, "gpt-4o", { allowedConnectionIds: s.allowedConnectionIds });
      expect(creds.connectionId).toBe(accA.id);
    }
  });

  it("3. never falls back to account-B (excluded → null; upstream fail → 403, one attempt)", async () => {
    const s = await scope(keyA1.key);
    const creds = await auth.getProviderCredentials("openai", new Set([accA.id]), "gpt-4o", { allowedConnectionIds: s.allowedConnectionIds });
    expect(creds).toBeNull();

    const res = await chat.handleChat(req(keyA1.key));
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe("Assigned provider account unavailable");
    expect(coreCalls).toEqual([accA.id]);
  });

  it("4. unknown/invalid key rejected when strict", async () => {
    expect((await scope("sk-bogus", "openai", true)).reject.status).toBe(401);
    expect((await scope(null, "openai", true)).reject.status).toBe(401);
    await db.updateSettings({ strictKeyAccountRouting: true });
    expect((await chat.handleChat(req("sk-bogus"))).status).toBe(401);
    expect((await chat.handleChat(req(null))).status).toBe(401);
    expect(coreCalls).toEqual([]);
  });

  it("5. disabled assigned account → 403, no switch to account-B", async () => {
    await db.updateProviderConnection(accA.id, { isActive: false });
    const res = await chat.handleChat(req(keyA1.key));
    expect(res.status).toBe(403);
    expect(coreCalls).toEqual([]);
  });

  it("6. mapping exists but other provider requested → 403", async () => {
    const s = await scope(keyA1.key, "anthropic");
    expect(s.reject.status).toBe(403);
    const res = await chat.handleChat(req(keyA1.key, "anthropic/claude-sonnet-4"));
    expect(res.status).toBe(403);
    expect(coreCalls).toEqual([]);
  });

  it("7. strict off + no mapping → pool; strict on + no mapping → 403", async () => {
    expect((await scope(keyNoMap.key)).allowedConnectionIds).toBeNull();
    expect((await scope(null)).allowedConnectionIds).toBeNull();
    // pool path still does account fallback (A then B)
    const res = await chat.handleChat(req(keyNoMap.key, "openai/gpt-4.1-mini"));
    expect(res.status).not.toBe(403);
    expect(new Set(coreCalls)).toEqual(new Set([accA.id, accB.id]));
    expect((await scope(keyNoMap.key, "openai", true)).reject.status).toBe(403);
  });

  it("8. repo round-trip, null dropped, cascade on key/connection delete", async () => {
    const k = await db.createApiKey("tmp", "m1");
    expect(await db.setKeyAccounts(k.id, { openai: accB.id, anthropic: accOther.id, gemini: null }))
      .toEqual({ openai: accB.id, anthropic: accOther.id });
    expect((await db.getApiKeyByKey(k.key)).id).toBe(k.id);
    const exported = await db.exportDb();
    expect(exported.apiKeyAccounts.filter((m) => m.apiKeyId === k.id)).toHaveLength(2);
    await db.deleteApiKey(k.id);
    expect(await db.getKeyAccounts(k.id)).toEqual({});

    const k2 = await db.createApiKey("tmp2", "m1");
    const conn = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "acc-tmp", apiKey: "sk-T" });
    await db.setKeyAccounts(k2.id, { openai: conn.id });
    await db.deleteProviderConnection(conn.id);
    expect(await db.getKeyAccounts(k2.id)).toEqual({});
  });
}, 60000);

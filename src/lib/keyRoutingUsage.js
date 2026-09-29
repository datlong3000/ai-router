import { getAdapter } from "@/lib/db/driver.js";

const DAY_MS = 86400000;

// { [keyId]: { req, tokens, cost, byAccount } } for one provider over the last 24h. Raw keys stay server-side.
export async function getKeyUsage(providerId, keys, connIds, now = Date.now()) {
  const since = new Date(now - DAY_MS).toISOString();
  const db = await getAdapter();
  const idByKey = new Map(keys.map((k) => [k.key, k.id]));
  const rows = db.all(
    `SELECT apiKey, connectionId, COUNT(*) AS req, SUM(promptTokens + completionTokens) AS tokens, SUM(cost) AS cost
     FROM usageHistory WHERE provider = ? AND timestamp >= ? AND apiKey IS NOT NULL
     GROUP BY apiKey, connectionId`,
    [providerId, since]
  );
  const usage = {};
  for (const r of rows) {
    const keyId = idByKey.get(r.apiKey);
    if (!keyId) continue;
    const u = (usage[keyId] ||= { req: 0, tokens: 0, cost: 0, byAccount: {} });
    u.req += r.req; u.tokens += r.tokens || 0; u.cost += r.cost || 0;
    if (connIds.has(r.connectionId)) u.byAccount[r.connectionId] = { req: r.req, tokens: r.tokens || 0 };
  }
  return usage;
}

// { [keyId]: ms } of each key's latest request to this provider (last 24h)
export async function getKeyLastUsed(providerId, keys, now = Date.now()) {
  const db = await getAdapter();
  const idByKey = new Map(keys.map((k) => [k.key, k.id]));
  const rows = db.all(
    `SELECT apiKey, MAX(timestamp) AS ts FROM usageHistory WHERE provider = ? AND timestamp >= ? AND apiKey IS NOT NULL GROUP BY apiKey`,
    [providerId, new Date(now - DAY_MS).toISOString()]
  );
  const out = {};
  for (const r of rows) { const id = idByKey.get(r.apiKey); if (id) out[id] = new Date(r.ts).getTime(); }
  return out;
}

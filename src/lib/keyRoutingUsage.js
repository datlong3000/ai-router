import { getAdapter } from "@/lib/db/driver.js";

export const PERIOD_MS = { "24h": 86400000, "7d": 604800000 };

// { [keyId]: { req, tokens, cost, byAccount } } for one provider since `since`. Raw keys stay server-side.
export async function getKeyUsage(providerId, since, keys, connIds) {
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

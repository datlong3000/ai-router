import { NextResponse } from "next/server";
import { getApiKeys, getKeyAccounts, getProviderConnections, getSettings, updateSettings } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

const PERIOD_MS = { "24h": 86400000, "7d": 604800000 };

function mask(key) {
  return key && key.length > 12 ? key.slice(0, 8) + "***" + key.slice(-4) : "***";
}

// GET /api/providers/[id]/key-routing?period=7d
// Keys (masked), pins for this provider, and per-key × account usage. Raw keys never leave the server.
export async function GET(request, { params }) {
  try {
    const { id: providerId } = await params;
    const period = new URL(request.url).searchParams.get("period") === "24h" ? "24h" : "7d";
    const since = new Date(Date.now() - PERIOD_MS[period]).toISOString();

    const [keys, connections, db, settings] = await Promise.all([
      getApiKeys(), getProviderConnections({ provider: providerId }), getAdapter(), getSettings(),
    ]);
    const connIds = new Set(connections.map((c) => c.id));
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

    const out = await Promise.all(keys.map(async (k) => ({
      id: k.id, name: k.name, masked: mask(k.key), isActive: k.isActive,
      pinned: (await getKeyAccounts(k.id))[providerId] || null,
    })));

    return NextResponse.json({
      period,
      fallback: !!settings.keyAccountFallback?.[providerId],
      keys: out,
      accounts: connections.map((c) => ({
        id: c.id, name: c.name || c.email || c.id.slice(0, 8), isActive: c.isActive !== false,
      })),
      usage,
    });
  } catch (error) {
    console.log("Error fetching key routing:", error);
    return NextResponse.json({ error: "Failed to fetch key routing" }, { status: 500 });
  }
}

// PATCH /api/providers/[id]/key-routing - body { fallback: boolean }
// Pinned keys of this provider fall back to other accounts (Connections priority) when the pin is unavailable.
export async function PATCH(request, { params }) {
  try {
    const { id: providerId } = await params;
    // providerId becomes an object key in settings: block prototype keys / junk
    if (!/^[a-z0-9][\w.-]{0,63}$/i.test(providerId) || ["__proto__", "constructor", "prototype"].includes(providerId)) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    const body = await request.json().catch(() => null);
    if (typeof body?.fallback !== "boolean") {
      return NextResponse.json({ error: "fallback must be a boolean" }, { status: 400 });
    }
    const current = (await getSettings()).keyAccountFallback || {};
    const next = { ...current, [providerId]: body.fallback };
    if (!body.fallback) delete next[providerId];
    await updateSettings({ keyAccountFallback: next });
    return NextResponse.json({ fallback: body.fallback });
  } catch (error) {
    console.log("Error updating key routing fallback:", error);
    return NextResponse.json({ error: "Failed to update fallback" }, { status: 500 });
  }
}

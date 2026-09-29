import { NextResponse } from "next/server";
import { getApiKeys, getKeyAccounts, getProviderConnections, getSettings, updateSettings } from "@/lib/localDb";
import { getKeyUsage } from "@/lib/keyRoutingUsage.js";

export const dynamic = "force-dynamic";

function mask(key) {
  return key && key.length > 12 ? key.slice(0, 8) + "***" + key.slice(-4) : "***";
}

// GET /api/providers/[id]/key-routing (usage = last 24h)
// Keys (masked), pins for this provider, and per-key × account usage. Raw keys never leave the server.
export async function GET(_request, { params }) {
  try {
    const { id: providerId } = await params;

    const [keys, connections, settings] = await Promise.all([
      getApiKeys(), getProviderConnections({ provider: providerId }), getSettings(),
    ]);
    const usage = await getKeyUsage(providerId, keys, new Set(connections.map((c) => c.id)));

    const out = await Promise.all(keys.map(async (k) => ({
      id: k.id, name: k.name, masked: mask(k.key), isActive: k.isActive,
      pinned: (await getKeyAccounts(k.id))[providerId] || null,
    })));

    return NextResponse.json({
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

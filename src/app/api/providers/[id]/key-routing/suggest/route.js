import { NextResponse } from "next/server";
import { getApiKeys, getKeyAccounts, getProviderConnections } from "@/lib/localDb";
import { planKeyAssignment, capacityOf } from "@/lib/keyRoutingPlan.js";
import { getKeyUsage, PERIOD_MS } from "@/lib/keyRoutingUsage.js";
import { GET as getConnectionUsage } from "@/app/api/usage/[connectionId]/route.js";

export const dynamic = "force-dynamic";

const WEEKLY = /weekly|\(7d\)/i;

// Weekly quota window for one connection (lowest across models), or null. Never throws.
async function weeklyQuota(connectionId) {
  try {
    const res = await getConnectionUsage(new Request(`http://local/api/usage/${connectionId}`), { params: Promise.resolve({ connectionId }) });
    const { quotas } = await res.json();
    let best = null;
    for (const [k, q] of Object.entries(quotas || {})) {
      if (!WEEKLY.test(k) || q?.unlimited) continue;
      const remaining = Number.isFinite(q.remainingPercentage) ? q.remainingPercentage
        : q.total ? (q.remaining / q.total) * 100 : q.remaining;
      if (Number.isFinite(remaining) && (!best || remaining < best.remaining)) best = { remaining, resetAt: q.resetAt || null };
    }
    return best;
  } catch {
    return null;
  }
}

// GET /api/providers/[id]/key-routing/suggest
// Rebalance plan: key load = last-24h tokens, account capacity = weekly quota left;
// load share per account ∝ capacity, minimal pin moves. Read-only.
export async function GET(request, { params }) {
  try {
    const { id: providerId } = await params;
    const period = "24h";
    const [allKeys, connections] = await Promise.all([getApiKeys(), getProviderConnections({ provider: providerId })]);
    const active = connections.filter((c) => c.isActive !== false);
    const keys = allKeys.filter((k) => k.isActive);
    const usage = await getKeyUsage(providerId, new Date(Date.now() - PERIOD_MS[period]).toISOString(), keys, new Set(connections.map((c) => c.id)));

    const [quotas, pinList] = await Promise.all([
      Promise.all(active.map((c) => weeklyQuota(c.id))),
      Promise.all(keys.map((k) => getKeyAccounts(k.id))),
    ]);
    const pins = Object.fromEntries(keys.map((k, i) => [k.id, pinList[i][providerId]]));

    const plan = planKeyAssignment({
      keys: keys.map((k) => ({ id: k.id, load: usage[k.id]?.tokens || 0 })),
      accounts: active.map((c, i) => ({ id: c.id, cap: capacityOf(quotas[i]) })),
      pins,
    });
    const changes = Object.entries(plan.assignment)
      .filter(([kid, cid]) => pins[kid] !== cid)
      .map(([keyId, to]) => ({ keyId, from: pins[keyId] || null, to }));

    return NextResponse.json({ period, changes, accounts: plan.accounts });
  } catch (error) {
    console.log("Error building key routing suggestion:", error);
    return NextResponse.json({ error: "Failed to build suggestion" }, { status: 500 });
  }
}

// Greedy balance: heaviest key first → account with most (quota headroom − assigned load).
// accounts: [{ id, remaining }] where remaining is 0-100 or null (unknown quota → treated as 100).
// keys: [{ id, load }] (inactive keys should be filtered by caller).
// ponytail: greedy, not optimal; fine for tens of keys. Swap for LPT/ILP if accounts grow large.
export function suggestKeyAssignment(keys, accounts) {
  if (!accounts.length) return {};
  const totalLoad = keys.reduce((s, k) => s + k.load, 0) || 1;
  // Load share consumed so far, scaled to the same 0-100 unit as remaining quota
  const used = Object.fromEntries(accounts.map((a) => [a.id, 0]));
  const headroom = (a) => (a.remaining ?? 100) - used[a.id];
  const out = {};
  const sorted = [...keys].sort((a, b) => b.load - a.load);
  sorted.forEach((k, i) => {
    let best = accounts[0];
    for (const a of accounts) if (headroom(a) > headroom(best)) best = a;
    // Zero-load keys still spread round-robin-ish via a small nominal weight
    used[best.id] += k.load > 0 ? (k.load / totalLoad) * 100 : 1 + i * 1e-6;
    out[k.id] = best.id;
  });
  return out;
}

// Lowest remaining % across a /api/usage/[connectionId] quotas object, or null if none.
export function minRemaining(quotas) {
  const vals = Object.values(quotas || {})
    .filter((q) => q && !q.unlimited && Number.isFinite(q.remaining ?? q.remainingPercentage))
    .map((q) => (q.total && q.total !== 100 ? (q.remaining / q.total) * 100 : (q.remaining ?? q.remainingPercentage)));
  return vals.length ? Math.min(...vals) : null;
}

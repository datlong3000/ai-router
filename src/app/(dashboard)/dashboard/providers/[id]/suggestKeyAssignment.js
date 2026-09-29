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

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Remaining % for one quota window, or null
export function windowRemaining(q) {
  if (!q || q.unlimited) return null;
  if (Number.isFinite(q.remainingPercentage)) return q.remainingPercentage;
  if (!Number.isFinite(q.remaining)) return null;
  return q.total && q.total !== 100 ? (q.remaining / q.total) * 100 : q.remaining;
}

// One ring per model: "MiniMax-M2 (5h)" + "MiniMax-M2 (7d)" → { name:"MiniMax-M2", remaining:min, windows:[...] }.
// Keys without a "(window)" suffix (session/weekly…) stay one group each.
export function groupQuotaByModel(quotas) {
  const groups = new Map();
  for (const [key, q] of Object.entries(quotas || {})) {
    const remaining = windowRemaining(q);
    if (remaining == null) continue;
    const m = key.match(/^(.*?)\s*\(([^)]+)\)$/);
    const name = m ? m[1] : key;
    const g = groups.get(name) || { name, remaining: 100, resetAt: null, windows: [] };
    g.windows.push({ label: m ? m[2] : key, remaining, resetAt: q.resetAt || null });
    if (remaining <= g.remaining) { g.remaining = remaining; g.resetAt = q.resetAt || null; }
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => a.remaining - b.remaining);
}

// Lowest remaining % across a /api/usage/[connectionId] quotas object, or null if none.
export function minRemaining(quotas) {
  const vals = Object.values(quotas || {}).map(windowRemaining).filter((v) => v != null);
  return vals.length ? Math.min(...vals) : null;
}

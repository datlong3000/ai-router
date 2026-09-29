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

const WINDOWS = [
  { name: "session", match: /session|\(5h\)/i, ms: 5 * 3600000 },
  { name: "weekly", match: /weekly|\(7d\)/i, ms: 7 * 86400000 },
];

// Collapse any provider's quotas into just session (5h) + weekly (7d), lowest remaining wins per bucket.
// MiniMax "<model> (5h|7d)" folds in too. Other windows (review, opus-only, …) are dropped.
export function sessionWeekly(quotas) {
  const out = [];
  for (const w of WINDOWS) {
    let best = null;
    for (const [key, q] of Object.entries(quotas || {})) {
      if (!w.match.test(key)) continue;
      const remaining = windowRemaining(q);
      if (remaining != null && (!best || remaining < best.remaining)) best = { name: w.name, remaining, resetAt: q.resetAt || null, windowMs: w.ms };
    }
    if (best) out.push(best);
  }
  return out;
}

// ms until the window hits 0% at its average burn pace so far, only if that lands before resetAt; else null.
// Pace = % used / time elapsed in the window (window start = resetAt − windowMs).
export function timeToEmpty(w, now = Date.now()) {
  const resetMs = new Date(w?.resetAt).getTime();
  if (!Number.isFinite(resetMs) || !w.windowMs) return null;
  const elapsed = w.windowMs - (resetMs - now);
  const used = 100 - w.remaining;
  if (elapsed <= 0 || used <= 0) return null;
  const empty = w.remaining / (used / elapsed);
  return empty < resetMs - now ? empty : null;
}

// "2h 13m" / "3d 4h" until resetAt, or null
export function timeLeft(resetAt, now = Date.now()) {
  const ms = new Date(resetAt).getTime() - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}

// Lowest remaining % across a /api/usage/[connectionId] quotas object, or null if none.
export function minRemaining(quotas) {
  const vals = Object.values(quotas || {}).map(windowRemaining).filter((v) => v != null);
  return vals.length ? Math.min(...vals) : null;
}

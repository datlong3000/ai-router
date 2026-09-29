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

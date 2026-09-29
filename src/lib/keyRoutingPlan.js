// Key → account rebalance planner (server-side).
//
// Goal: each account's share of key load ∝ its capacity, with as few pin moves as possible.
// Objective: Σ load_a² / cap_a  (minimized exactly when load_a / cap_a is equal everywhere)
//            + STICKY × ideal × moves  (a move must buy a real balance gain, avoids churn).
// Search: LPT seed (heaviest key → account with lowest (load+k)/cap) and current pins as a
// second seed, then best-improvement local search over single moves and pairwise swaps.
// ponytail: local search, not exact; exact for tiny inputs is 3^12 brute force — add only if needed.

const STICKY = 0.01;
const DAY_MS = 86400000;

// Imbalance of an assignment: Σ load² / cap, normalized so a perfectly proportional split = 1.
export function imbalance(assignment, loads, caps) {
  const byAcc = {};
  let total = 0, capSum = 0;
  for (const [k, a] of Object.entries(assignment)) {
    if (!a) continue; // unpinned keys use the whole pool, not one account
    byAcc[a] = (byAcc[a] || 0) + (loads[k] || 0);
    total += loads[k] || 0;
  }
  for (const c of Object.values(caps)) capSum += c;
  if (!total || !capSum) return 1;
  let s = 0;
  for (const [a, l] of Object.entries(byAcc)) s += caps[a] > 0 ? (l * l) / caps[a] : (l > 0 ? Infinity : 0);
  return s / ((total * total) / capSum);
}

/**
 * Guardrails for unattended auto-balance. Returns the moves to apply (possibly none).
 * - only when imbalance drops by ≥ minGain (relative)
 * - skip keys used in the last `busyMs` (don't swap accounts mid-conversation)
 * - at most `maxMoves`, biggest gain first
 * @param changes [{ keyId, from, to }] from the planner
 * @param loads   { keyId: load }  caps { accountId: cap }  pins { keyId: accountId }
 * @param lastUsed { keyId: ms timestamp }
 */
export function limitMoves({ changes, loads, caps, pins, lastUsed = {}, now = Date.now(),
  maxMoves = 3, minGain = 0.1, busyMs = 60000 }) {
  const eligible = changes.filter((c) => !(lastUsed[c.keyId] && now - lastUsed[c.keyId] < busyMs));
  const before = imbalance(pins, loads, caps);
  const picked = [];
  const cur = { ...pins };
  // Greedy by marginal gain over the planner's own moves
  let pool = [...eligible];
  while (picked.length < maxMoves && pool.length) {
    let best = null, bestScore = imbalance(cur, loads, caps);
    for (const c of pool) {
      const s = imbalance({ ...cur, [c.keyId]: c.to }, loads, caps);
      if (s < bestScore - 1e-9) { best = c; bestScore = s; }
    }
    if (!best) break;
    picked.push(best);
    cur[best.keyId] = best.to;
    pool = pool.filter((c) => c !== best);
  }
  const after = imbalance(cur, loads, caps);
  // Load stuck on an exhausted account (before = ∞) always justifies the move
  const worth = picked.length && (!Number.isFinite(before) ? Number.isFinite(after) || after < before : (before - after) / before >= minGain);
  return worth ? { moves: picked, before, after } : { moves: [], before, after: before };
}

// Keys without history get the median observed load, so new keys still spread evenly
export function effectiveLoads(loads) {
  const observed = loads.filter((l) => l > 0);
  const fill = observed.length ? median(observed) : 1;
  return loads.map((l) => (l > 0 ? l : fill));
}

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Capacity weight from weekly quota. Pins are long-lived, so a window resetting within 24h
// counts as full; unknown quota counts as full.
export function capacityOf(q, now = Date.now()) {
  if (!q || !Number.isFinite(q.remaining)) return 100;
  const resetMs = new Date(q.resetAt).getTime();
  if (Number.isFinite(resetMs) && resetMs - now < DAY_MS) return 100;
  return Math.max(0, Math.min(100, q.remaining));
}

/**
 * @param keys     [{ id, load }]              active keys only; load = tokens in window
 * @param accounts [{ id, cap }]               active accounts only; cap = capacityOf(...)
 * @param pins     { [keyId]: accountId }      current pins (for stickiness)
 */
export function planKeyAssignment({ keys, accounts, pins = {} }) {
  if (!keys.length || !accounts.length) return { assignment: {}, moves: 0, accounts: [] };
  let caps = accounts.map((a) => Math.max(0, a.cap));
  if (caps.every((c) => c === 0)) caps = caps.map(() => 1);
  const n = accounts.length;

  const L = effectiveLoads(keys.map((k) => k.load));
  const pinIdx = keys.map((k) => accounts.findIndex((a) => a.id === pins[k.id]));

  const total = L.reduce((s, x) => s + x, 0);
  const capSum = caps.reduce((s, c) => s + c, 0);
  const ideal = (total * total) / capSum;

  const cost = (asg) => {
    const load = new Array(n).fill(0);
    asg.forEach((a, i) => { load[a] += L[i]; });
    let c = 0;
    for (let a = 0; a < n; a++) {
      if (caps[a] > 0) c += (load[a] * load[a]) / caps[a];
      else if (load[a] > 0) return Infinity;
    }
    let moves = 0;
    asg.forEach((a, i) => { if (a !== pinIdx[i]) moves++; });
    return c + STICKY * ideal * moves;
  };

  const improve = (asg) => {
    let best = cost(asg);
    for (let iter = 0; iter < 1000; iter++) {
      let bestMove = null;
      for (let i = 0; i < asg.length; i++) {
        const from = asg[i];
        for (let b = 0; b < n; b++) {
          if (b === from || caps[b] === 0) continue;
          asg[i] = b;
          const c = cost(asg);
          if (c < best - 1e-9) { best = c; bestMove = [[i, b]]; }
          asg[i] = from;
        }
        for (let j = i + 1; j < asg.length; j++) {
          if (asg[j] === from) continue;
          const to = asg[j];
          asg[i] = to; asg[j] = from;
          const c = cost(asg);
          if (c < best - 1e-9) { best = c; bestMove = [[i, to], [j, from]]; }
          asg[i] = from; asg[j] = to;
        }
      }
      if (!bestMove) break;
      for (const [i, b] of bestMove) asg[i] = b;
    }
    return { asg, c: best };
  };

  // Seed 1: LPT on uniform machines
  const lpt = new Array(keys.length);
  const load = new Array(n).fill(0);
  for (const i of keys.map((_, i) => i).sort((a, b) => L[b] - L[a])) {
    let best = -1, bestV = Infinity;
    for (let a = 0; a < n; a++) {
      if (caps[a] === 0) continue;
      const v = (load[a] + L[i]) / caps[a];
      if (v < bestV - 1e-9 || (Math.abs(v - bestV) <= 1e-9 && a === pinIdx[i])) { best = a; bestV = v; }
    }
    lpt[i] = best;
    load[best] += L[i];
  }
  // Seed 2: current pins (unpinned / pinned-to-gone keys start on the LPT choice)
  const current = pinIdx.map((p, i) => (p >= 0 && caps[p] > 0 ? p : lpt[i]));

  const a = improve(lpt), b = improve(current);
  const win = a.c <= b.c ? a.asg : b.asg;

  const finalLoad = new Array(n).fill(0);
  win.forEach((acc, i) => { finalLoad[acc] += L[i]; });
  const assignment = Object.fromEntries(keys.map((k, i) => [k.id, accounts[win[i]].id]));
  return {
    assignment,
    moves: win.filter((acc, i) => acc !== pinIdx[i]).length,
    accounts: accounts.map((acc, i) => ({
      id: acc.id,
      targetShare: caps[i] / capSum,     // share of load it should carry
      loadShare: total ? finalLoad[i] / total : 0, // share it carries after the plan
      keys: win.filter((x) => x === i).length,
    })),
  };
}

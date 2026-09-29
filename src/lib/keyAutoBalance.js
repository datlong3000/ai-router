// Key → account rebalance: plan (shared by Suggest), unattended auto-apply, undo, and scheduler.
// Settings: keyAutoBalance[provider] = { everyH, lastRunAt, last: { at, moves: [{keyId, from, to}], undone } }
import { getApiKeys, getKeyAccounts, setKeyAccounts, getProviderConnections, getSettings, updateSettings } from "@/lib/localDb";
import { planKeyAssignment, capacityOf, limitMoves, effectiveLoads } from "@/lib/keyRoutingPlan.js";
import { getKeyUsage, getKeyLastUsed } from "@/lib/keyRoutingUsage.js";
import { GET as getConnectionUsage } from "@/app/api/usage/[connectionId]/route.js";

export const AUTO_EVERY_H = [1, 3, 6, 24];
const TICK_MS = 5 * 60000;
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

// Plan for one provider: load = 24h tokens, capacity = weekly quota left.
export async function buildPlan(providerId) {
  const [allKeys, connections] = await Promise.all([getApiKeys(), getProviderConnections({ provider: providerId })]);
  const active = connections.filter((c) => c.isActive !== false);
  const keys = allKeys.filter((k) => k.isActive);
  const usage = await getKeyUsage(providerId, keys, new Set(connections.map((c) => c.id)));
  const [quotas, pinList] = await Promise.all([
    Promise.all(active.map((c) => weeklyQuota(c.id))),
    Promise.all(keys.map((k) => getKeyAccounts(k.id))),
  ]);
  const pins = Object.fromEntries(keys.map((k, i) => [k.id, pinList[i][providerId] || null]));
  // Same median-filled loads the planner uses, so the auto-apply guardrail scores what the planner optimized
  const eff = effectiveLoads(keys.map((k) => usage[k.id]?.tokens || 0));
  const loads = Object.fromEntries(keys.map((k, i) => [k.id, eff[i]]));
  const caps = Object.fromEntries(active.map((c, i) => [c.id, capacityOf(quotas[i])]));

  const plan = planKeyAssignment({
    keys: keys.map((k) => ({ id: k.id, load: loads[k.id] })),
    accounts: active.map((c) => ({ id: c.id, cap: caps[c.id] })),
    pins,
  });
  const changes = Object.entries(plan.assignment)
    .filter(([kid, cid]) => pins[kid] !== cid)
    .map(([keyId, to]) => ({ keyId, from: pins[keyId], to }));
  return { changes, accounts: plan.accounts, keys, pins, loads, caps };
}

// Set one key's pin for this provider, keeping its pins for other providers
async function setPin(keyId, providerId, connectionId) {
  const current = await getKeyAccounts(keyId);
  await setKeyAccounts(keyId, { ...current, [providerId]: connectionId || null });
}

async function saveState(providerId, patch) {
  const all = (await getSettings()).keyAutoBalance || {};
  const next = { ...all, [providerId]: { ...(all[providerId] || {}), ...patch } };
  await updateSettings({ keyAutoBalance: next });
  return next[providerId];
}

// Unattended run: plan → guardrails → apply → log. Returns the recorded run.
export async function runAutoBalance(providerId, now = Date.now()) {
  const plan = await buildPlan(providerId);
  const lastUsed = await getKeyLastUsed(providerId, plan.keys, now);
  // Unpinned keys are never auto-pinned: that would restrict a key that currently uses the whole pool
  const changes = plan.changes.filter((c) => c.from);
  const { moves, before, after } = limitMoves({ changes, loads: plan.loads, caps: plan.caps, pins: plan.pins, lastUsed, now });
  for (const m of moves) await setPin(m.keyId, providerId, m.to);
  const last = { at: new Date(now).toISOString(), moves, before, after, undone: false };
  await saveState(providerId, { lastRunAt: last.at, last });
  if (moves.length) console.log(`[AutoBalance] ${providerId}: moved ${moves.length} key(s)`);
  return last;
}

// Revert the last run's moves; a key someone re-pinned since then is left alone.
export async function undoLastRun(providerId) {
  const state = (await getSettings()).keyAutoBalance?.[providerId];
  const last = state?.last;
  if (!last?.moves?.length || last.undone) return { reverted: 0 };
  let reverted = 0;
  for (const m of last.moves) {
    if ((await getKeyAccounts(m.keyId))[providerId] !== m.to) continue;
    await setPin(m.keyId, providerId, m.from);
    reverted++;
  }
  await saveState(providerId, { last: { ...last, undone: true } });
  return { reverted };
}

// ── Scheduler (one per server process, survives hot reload) ──
const g = (global.__keyAutoBalance ??= { interval: null, running: false });

export async function tickAutoBalance(now = Date.now()) {
  if (g.running) return;
  g.running = true;
  try {
    const all = (await getSettings()).keyAutoBalance || {};
    for (const [providerId, s] of Object.entries(all)) {
      if (!AUTO_EVERY_H.includes(s?.everyH)) continue;
      const lastMs = s.lastRunAt ? new Date(s.lastRunAt).getTime() : 0;
      if (now - lastMs < s.everyH * 3600000) continue;
      await runAutoBalance(providerId, now).catch((e) => console.warn(`[AutoBalance] ${providerId} failed:`, e.message));
    }
  } finally {
    g.running = false;
  }
}

export function configureKeyAutoBalance(settings) {
  const enabled = Object.values(settings?.keyAutoBalance || {}).some((s) => AUTO_EVERY_H.includes(s?.everyH));
  if (enabled && !g.interval) {
    g.interval = setInterval(() => { tickAutoBalance().catch(() => {}); }, TICK_MS);
    if (g.interval.unref) g.interval.unref();
    console.log("[AutoBalance] scheduler started");
  } else if (!enabled && g.interval) {
    clearInterval(g.interval);
    g.interval = null;
    console.log("[AutoBalance] scheduler stopped");
  }
}

export async function setAutoBalanceEvery(providerId, everyH) {
  const state = await saveState(providerId, { everyH: everyH || null });
  configureKeyAutoBalance(await getSettings());
  return state;
}

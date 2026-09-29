"use client";

import { useState, useEffect, useCallback } from "react";
import { Modal, Button } from "@/shared/components";
import { sessionWeekly, timeLeft, timeToEmpty } from "./quotaWindows";
import { median } from "@/lib/keyRoutingPlan.js";

const UNASSIGNED = "";
const LOW_QUOTA = 20;
const HEAVY_X = 2; // key is "heavy" above HEAVY_X × team median

const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)));
const quotaColor = (r) => (r < LOW_QUOTA ? "#ef4444" : r < 50 ? "#f59e0b" : "#22c55e");

// Half-circle gauge. Arc = weekly % left; ● on the arc = how far the week has elapsed
// (arc end left of ● → burning faster than the week allows). Big number = session % left.
// One line below: session reset countdown; swaps to red "⚠ wk …" when weekly runs out before its reset.
function QuotaGauge({ windows, now }) {
  const session = windows.find((w) => w.name === "session");
  const weekly = windows.find((w) => w.name === "weekly");
  const W = 88, r = 38, stroke = 7, cy = 44;
  const arc = `M ${W / 2 - r} ${cy} A ${r} ${r} 0 0 1 ${W / 2 + r} ${cy}`;
  // Fraction of the weekly window still ahead → dot sits at (1 − elapsed) along the "remaining" scale
  const weekLeft = weekly?.resetAt ? Math.min(1, Math.max(0, (new Date(weekly.resetAt) - now) / weekly.windowMs)) : null;
  const dot = weekLeft != null ? (() => {
    const t = Math.PI * (1 - weekLeft); // 0 = left end, π = right end
    return { x: W / 2 - r * Math.cos(t), y: cy - r * Math.sin(t) };
  })() : null;
  const weeklyEmpty = weekly ? timeToEmpty(weekly, now) : null;
  const tip = windows.map((w) => `${w.name}: ${Math.round(w.remaining)}% left${w.resetAt ? `, resets in ${timeLeft(w.resetAt, now)} (${new Date(w.resetAt).toLocaleString()})` : ""}`).join("\n")
    + (weeklyEmpty != null ? `\nweekly runs out in ~${timeLeft(now + weeklyEmpty, now)} at current pace` : "");
  return (
    <div className="flex flex-col items-center w-fit" title={tip}>
      <svg width={W} height={cy + stroke / 2 + 1} viewBox={`0 0 ${W} ${cy + stroke / 2 + 1}`} role="img" aria-label={tip}>
        <path d={arc} fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth={stroke} strokeLinecap="round" />
        {weekly && (
          <path d={arc} fill="none" stroke={quotaColor(weekly.remaining)} strokeWidth={stroke} strokeLinecap="round"
            pathLength="100" strokeDasharray={`${Math.max(0, weekly.remaining)} 100`} />
        )}
        {dot && <circle cx={dot.x} cy={dot.y} r={stroke / 2 + 1} className="fill-text-main" stroke="var(--color-surface, #fff)" strokeWidth="1.5" />}
        {session && (
          <text x={W / 2} y={cy - 4} textAnchor="middle" fontSize="16" fontWeight="700" fill={quotaColor(session.remaining)}>
            {Math.round(session.remaining)}%
          </text>
        )}
      </svg>
      <div className="text-[11px] tabular-nums leading-tight">
        {weeklyEmpty != null
          ? <span className="text-red-500">⚠ wk {timeLeft(weekly.resetAt, now)}</span>
          : session?.resetAt ? <span className="text-text-muted">⟳ {timeLeft(session.resetAt, now)}</span> : null}
      </div>
    </div>
  );
}

// Drag API keys into account zones: pins each key to one account of this provider.
export default function KeyAccessModal({ isOpen, onClose, providerId }) {
  const [data, setData] = useState({ keys: [], accounts: [], usage: {}, fallback: false });
  const [quota, setQuota] = useState({}); // connId -> { windows: [{name:"session"|"weekly", remaining, resetAt, windowMs}], remaining }
  const [suggestion, setSuggestion] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Tick reset countdowns once a minute while open
  useEffect(() => {
    if (!isOpen) return;
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, [isOpen]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/providers/${providerId}/key-routing`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Load failed");
      setData(json);
      setError("");
    } catch (e) {
      setError(e.message || "Failed to load API keys");
    }
  }, [providerId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (isOpen) load(); }, [isOpen, load]);

  // Quota per account, independent so one slow upstream doesn't block the modal
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    for (const a of data.accounts) {
      fetch(`/api/usage/${a.id}`).then((r) => r.json()).then((u) => {
        if (cancelled) return;
        const windows = sessionWeekly(u?.quotas);
        setQuota((q) => ({ ...q, [a.id]: { windows, remaining: windows.length ? Math.min(...windows.map((w) => w.remaining)) : null } }));
      }).catch(() => !cancelled && setQuota((q) => ({ ...q, [a.id]: { windows: [], remaining: null } })));
    }
    return () => { cancelled = true; };
  }, [isOpen, data.accounts]);

  const tokensOf = (keyId) => data.usage[keyId]?.tokens || 0;
  const activeKeys = data.keys.filter((k) => k.isActive);
  const teamMedian = median(activeKeys.map((k) => tokensOf(k.id)));
  const isHeavy = (keyId) => teamMedian > 0 && tokensOf(keyId) > HEAVY_X * teamMedian;
  const maxTokens = Math.max(1, ...data.keys.map((k) => tokensOf(k.id)), teamMedian);

  const putPin = async (keyId, connectionId) => {
    // PUT replaces the key's whole map → merge with existing pins for other providers
    const { accounts = {} } = await (await fetch(`/api/keys/${keyId}/accounts`)).json();
    const res = await fetch(`/api/keys/${keyId}/accounts`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accounts: { ...accounts, [providerId]: connectionId || null } }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Save failed");
  };

  const run = async (fn) => {
    setSaving(true); setError("");
    try { await fn(); } catch (e) { setError(e.message); }
    finally { await load(); setSaving(false); }
  };

  const assign = (keyId, connectionId) => {
    const key = data.keys.find((k) => k.id === keyId);
    if (!key || (key.pinned || UNASSIGNED) === connectionId) return;
    run(() => putPin(keyId, connectionId));
  };

  const toggleFallback = () => run(async () => {
    const res = await fetch(`/api/providers/${providerId}/key-routing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fallback: !data.fallback }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Save failed");
  });

  // Plan computed server-side: 24h key load × weekly quota left per account
  const suggest = async () => {
    setSaving(true); setError("");
    try {
      const res = await fetch(`/api/providers/${providerId}/key-routing/suggest`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Suggest failed");
      setSuggestion(json);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const changes = suggestion?.changes || [];
  const applySuggestion = () => run(async () => {
    for (const c of changes) await putPin(c.keyId, c.to);
    setSuggestion(null);
  });

  const nameOf = (id) => data.accounts.find((a) => a.id === id)?.name || "Unassigned";
  const keysIn = (zoneId) => data.keys.filter((k) => (k.pinned || UNASSIGNED) === zoneId)
    .sort((a, b) => tokensOf(b.id) - tokensOf(a.id));
  const unassigned = keysIn(UNASSIGNED);
  // Accounts already arrive in Connections priority order; Unassigned last, hidden when empty
  const zones = [...data.accounts, ...(unassigned.length ? [{ id: UNASSIGNED, name: "Unassigned", isActive: true }] : [])];
  const strandedAccounts = data.accounts.filter((a) => !a.isActive && keysIn(a.id).length);
  const heavyCount = activeKeys.filter((k) => isHeavy(k.id)).length;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="API key access" size="full">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="flex-1 min-w-60 text-sm">
          <div className="text-text-muted">Drag an API key onto an account to pin it for this provider.</div>
          <div className="text-xs mt-0.5">
            Team median <b className="tabular-nums">{fmt(teamMedian)}</b> tok/24h
            {heavyCount > 0 && <> · <span className="text-orange-500">{heavyCount} heavy key(s)</span> (&gt;{HEAVY_X}× median)</>}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer" title="Pinned account first; if it is disabled, rate-limited or failing, try the other accounts in Connections priority order.">
          <input type="checkbox" role="switch" className="sr-only peer" checked={!!data.fallback} disabled={saving} onChange={toggleFallback} />
          <span className="relative w-9 h-5 rounded-full bg-border peer-checked:bg-primary transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-primary" />
          Fallback by priority
        </label>
        <Button size="sm" variant="secondary" onClick={suggest} disabled={saving || !data.accounts.length}>Suggest</Button>
      </div>

      {data.fallback && (
        <p className="text-xs text-orange-500 mb-2">
          Fallback on: pinned keys may use any account of this provider when their pin is unavailable. Pinning no longer isolates cost per account.
        </p>
      )}
      {!data.fallback && strandedAccounts.map((a) => (
        <p key={a.id} className="text-sm text-red-500 mb-2" role="alert">
          {keysIn(a.id).length} key(s) pinned to disabled account <b>{a.name}</b> will fail. Move them or turn on fallback.
        </p>
      ))}
      {error && <p className="text-sm text-red-500 mb-3" role="alert">{error}</p>}

      {suggestion && (
        <div className="mb-3 rounded-lg border border-border p-3 text-sm">
          <p className="text-xs text-text-muted mb-2">Based on last-24h key usage and each account&apos;s weekly quota left.</p>
          <ul className="mb-2 text-xs space-y-0.5">
            {suggestion.accounts.map((a) => (
              <li key={a.id} className="tabular-nums">
                {nameOf(a.id)}: {a.keys} key(s), carries {Math.round(a.loadShare * 100)}% of load (target {Math.round(a.targetShare * 100)}%)
              </li>
            ))}
          </ul>
          {changes.length === 0 ? <p>Current assignment is already balanced.</p> : (
            <ul className="mb-2 space-y-1">
              {changes.map((c) => {
                const k = data.keys.find((x) => x.id === c.keyId);
                return <li key={c.keyId}><b>{k?.name || c.keyId.slice(0, 8)}</b>: {nameOf(c.from)} → {nameOf(c.to)}</li>;
              })}
            </ul>
          )}
          <div className="flex gap-2">
            {changes.length > 0 && <Button size="sm" onClick={applySuggestion} disabled={saving}>Apply {changes.length} change(s)</Button>}
            <Button size="sm" variant="secondary" onClick={() => setSuggestion(null)}>Dismiss</Button>
          </div>
        </div>
      )}

      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 max-h-[60vh] overflow-y-auto">
        {zones.map((zone, idx) => {
          const inZone = keysIn(zone.id);
          const zoneTokens = inZone.reduce((s, k) => s + tokensOf(k.id), 0);
          const q = zone.id ? quota[zone.id] : null;
          const low = q?.remaining != null && q.remaining < LOW_QUOTA && zoneTokens > 0;
          const stranded = !zone.isActive && inZone.length > 0 && !data.fallback;
          return (
            <div
              key={zone.id || "unassigned"}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); assign(e.dataTransfer.getData("text/plain"), zone.id); }}
              className={`rounded-lg border border-dashed p-3 min-h-24 ${low || stranded ? "border-red-500" : "border-border"}`}
            >
              <div className="flex items-baseline gap-1 text-sm font-medium">
                {zone.id && <span className="text-xs text-text-muted tabular-nums">#{idx + 1}</span>}
                <span className={`truncate ${zone.isActive ? "" : "opacity-60"}`}>{zone.name}</span>
                {!zone.isActive && <span className="text-xs text-red-500">disabled</span>}
              </div>
              <div className="text-xs text-text-muted mb-2">{inZone.length} key(s) · {fmt(zoneTokens)} tok</div>
              {zone.id && (
                <div className="mb-3">
                  {q === undefined ? <div className="text-xs text-text-muted">Loading quota…</div>
                    : q.windows.length === 0 ? <div className="text-xs text-text-muted">Quota n/a</div>
                    : <QuotaGauge windows={q.windows} now={now} />}
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                {inZone.map((k) => {
                  const t = tokensOf(k.id);
                  const heavy = isHeavy(k.id);
                  const u = data.usage[k.id];
                  return (
                    <div
                      key={k.id}
                      draggable
                      tabIndex={0}
                      onDragStart={(e) => e.dataTransfer.setData("text/plain", k.id)}
                      title={`${k.masked} · ${u?.req || 0} req · $${(u?.cost || 0).toFixed(2)}`}
                      className={`group rounded-md bg-surface-2 border px-2 py-1 text-sm cursor-grab ${heavy ? "border-orange-500/60" : "border-border"} ${k.isActive ? "" : "opacity-50"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate flex-1 min-w-0">{k.name || k.masked}</span>
                        {heavy && <span className="text-[10px] px-1 rounded bg-orange-500/15 text-orange-500">heavy</span>}
                        <span className="text-xs text-text-muted tabular-nums">{fmt(t)}</span>
                        <select
                          aria-label={`Move ${k.name} to account`}
                          value={zone.id}
                          disabled={saving}
                          onChange={(e) => assign(k.id, e.target.value)}
                          className="text-xs bg-transparent border border-border rounded w-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
                        >
                          {[...data.accounts, { id: UNASSIGNED, name: "Unassigned" }].map((z) => <option key={z.id || "u"} value={z.id}>{z.name}</option>)}
                        </select>
                      </div>
                      <div className="relative h-1.5 mt-1 rounded bg-border">
                        <div className={`h-full rounded ${heavy ? "bg-orange-500" : "bg-primary"}`} style={{ width: `${(t / maxTokens) * 100}%` }} />
                        {teamMedian > 0 && (
                          <div className="absolute -top-0.5 h-2.5 w-0.5 bg-text-main" style={{ left: `${(teamMedian / maxTokens) * 100}%` }} aria-hidden="true" />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-text-muted mt-2">▏ marker = team median · order = Connections priority · hover a key for req/cost</p>
    </Modal>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { Modal, Button } from "@/shared/components";
import { suggestKeyAssignment, minRemaining } from "./suggestKeyAssignment";

const UNASSIGNED = "";
const LOW_QUOTA = 20;

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));

// Drag API keys into account zones: pins each key to one account of this provider.
// Shows per-account quota + per-key usage, and a greedy "Suggest" rebalance.
export default function KeyAccessModal({ isOpen, onClose, providerId }) {
  const [period, setPeriod] = useState("7d");
  const [data, setData] = useState({ keys: [], accounts: [], usage: {} });
  const [quota, setQuota] = useState({}); // connId -> { remaining, resetAt } | null
  const [suggestion, setSuggestion] = useState(null); // keyId -> connId
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/providers/${providerId}/key-routing?period=${period}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Load failed");
      setData(json);
      setError("");
    } catch (e) {
      setError(e.message || "Failed to load API keys");
    }
  }, [providerId, period]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (isOpen) load(); }, [isOpen, load]);

  // Quota per account, independent so one slow upstream doesn't block the modal
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    for (const a of data.accounts) {
      fetch(`/api/usage/${a.id}`).then((r) => r.json()).then((u) => {
        if (cancelled) return;
        const windows = Object.values(u?.quotas || {});
        const resetAt = windows.map((w) => w?.resetAt).filter(Boolean).sort()[0] || null;
        setQuota((q) => ({ ...q, [a.id]: { remaining: minRemaining(u?.quotas), resetAt } }));
      }).catch(() => !cancelled && setQuota((q) => ({ ...q, [a.id]: { remaining: null } })));
    }
    return () => { cancelled = true; };
  }, [isOpen, data.accounts]);

  const tokensOf = (keyId) => data.usage[keyId]?.tokens || 0;

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

  const assign = async (keyId, connectionId) => {
    const key = data.keys.find((k) => k.id === keyId);
    if (!key || (key.pinned || UNASSIGNED) === connectionId) return;
    setSaving(true); setError("");
    try { await putPin(keyId, connectionId); await load(); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const suggest = () => {
    const activeAccounts = data.accounts.filter((a) => a.isActive)
      .map((a) => ({ id: a.id, remaining: quota[a.id]?.remaining ?? null }));
    const keys = data.keys.filter((k) => k.isActive).map((k) => ({ id: k.id, load: tokensOf(k.id) }));
    setSuggestion(suggestKeyAssignment(keys, activeAccounts));
  };

  const changes = suggestion
    ? Object.entries(suggestion).filter(([kid, cid]) => data.keys.find((k) => k.id === kid)?.pinned !== cid)
    : [];

  const applySuggestion = async () => {
    setSaving(true); setError("");
    try {
      for (const [kid, cid] of changes) await putPin(kid, cid);
      setSuggestion(null);
      await load();
    } catch (e) { setError(e.message); await load(); }
    finally { setSaving(false); }
  };

  const nameOf = (id) => data.accounts.find((a) => a.id === id)?.name || "Unassigned";
  const zones = [{ id: UNASSIGNED, name: "Unassigned", isActive: true }, ...data.accounts];
  const keysIn = (zoneId) => data.keys.filter((k) => (k.pinned || UNASSIGNED) === zoneId)
    .sort((a, b) => tokensOf(b.id) - tokensOf(a.id));
  const maxTokens = Math.max(1, ...data.keys.map((k) => tokensOf(k.id)));

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="API key access" size="full">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <p className="text-sm text-text-muted flex-1 min-w-60">
          Drag an API key into an account. A pinned key only uses that account for this provider, with no fallback.
        </p>
        <div className="flex rounded-md border border-border overflow-hidden text-xs" role="group" aria-label="Usage period">
          {["24h", "7d"].map((p) => (
            <button key={p} type="button" onClick={() => setPeriod(p)} aria-pressed={period === p}
              className={`px-2 py-1 ${period === p ? "bg-primary text-white" : ""}`}>{p}</button>
          ))}
        </div>
        <Button size="sm" variant="secondary" onClick={suggest} disabled={saving || !data.accounts.length}>Suggest</Button>
      </div>

      {error && <p className="text-sm text-red-500 mb-3" role="alert">{error}</p>}

      {suggestion && (
        <div className="mb-3 rounded-lg border border-border p-3 text-sm">
          {changes.length === 0 ? <p>Current assignment is already balanced.</p> : (
            <ul className="mb-2 space-y-1">
              {changes.map(([kid, cid]) => {
                const k = data.keys.find((x) => x.id === kid);
                return <li key={kid}><b>{k.name}</b> ({fmt(tokensOf(kid))} tok): {nameOf(k.pinned)} → {nameOf(cid)}</li>;
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
        {zones.map((zone) => {
          const inZone = keysIn(zone.id);
          const zoneTokens = inZone.reduce((s, k) => s + tokensOf(k.id), 0);
          const q = zone.id ? quota[zone.id] : null;
          const low = q?.remaining != null && q.remaining < LOW_QUOTA && zoneTokens > 0;
          return (
            <div
              key={zone.id || "unassigned"}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); assign(e.dataTransfer.getData("text/plain"), zone.id); }}
              className={`rounded-lg border border-dashed p-3 min-h-24 ${low ? "border-red-500" : "border-border"} ${zone.isActive ? "" : "opacity-50"}`}
            >
              <div className="text-sm font-medium truncate">
                {zone.name}{!zone.isActive && <span className="ml-1 text-xs text-text-muted">(disabled)</span>}
              </div>
              <div className="text-xs text-text-muted mb-2">
                {inZone.length} key(s) · {fmt(zoneTokens)} tok/{period}
              </div>
              {zone.id && (
                <div className="mb-2">
                  {q === undefined ? <div className="text-xs text-text-muted">Loading quota…</div>
                    : q.remaining == null ? <div className="text-xs text-text-muted">Quota n/a</div>
                    : (
                      <>
                        <div className="h-1.5 rounded bg-surface-2 overflow-hidden" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(q.remaining)} aria-label="Quota remaining">
                          <div className={`h-full ${q.remaining < LOW_QUOTA ? "bg-red-500" : "bg-green-500"}`} style={{ width: `${q.remaining}%` }} />
                        </div>
                        <div className={`text-xs mt-1 ${low ? "text-red-500" : "text-text-muted"}`}>
                          {Math.round(q.remaining)}% left{q.resetAt && ` · resets ${new Date(q.resetAt).toLocaleString()}`}
                        </div>
                      </>
                    )}
                </div>
              )}
              <div className="flex flex-col gap-2">
                {inZone.map((k) => (
                  <div
                    key={k.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", k.id)}
                    className={`rounded-md bg-surface-2 border border-border px-2 py-1 text-sm cursor-grab ${k.isActive ? "" : "opacity-50"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate flex-1" title={k.masked}>{k.name || k.masked}</span>
                      <select
                        aria-label={`Account for ${k.name}`}
                        value={zone.id}
                        disabled={saving}
                        onChange={(e) => assign(k.id, e.target.value)}
                        className="text-xs bg-transparent border border-border rounded px-1 max-w-28"
                      >
                        {zones.map((z) => <option key={z.id || "u"} value={z.id}>{z.name}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="h-1 flex-1 rounded bg-border overflow-hidden">
                        <div className="h-full bg-primary" style={{ width: `${(tokensOf(k.id) / maxTokens) * 100}%` }} />
                      </div>
                      <span className="text-xs text-text-muted tabular-nums">
                        {fmt(tokensOf(k.id))} tok · {data.usage[k.id]?.req || 0} req
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

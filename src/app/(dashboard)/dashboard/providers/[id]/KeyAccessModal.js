"use client";

import { useState, useEffect } from "react";
import { Modal } from "@/shared/components";

const UNASSIGNED = "";

// Drag API keys into account zones: pins each key to one account of this provider.
export default function KeyAccessModal({ isOpen, onClose, providerId, connections }) {
  const [keys, setKeys] = useState([]);
  const [maps, setMaps] = useState({}); // keyId -> { [provider]: connectionId }
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      setError("");
      try {
        const { keys: list = [] } = await (await fetch("/api/keys")).json();
        const entries = await Promise.all(list.map(async (k) => {
          const { accounts = {} } = await (await fetch(`/api/keys/${k.id}/accounts`)).json();
          return [k.id, accounts];
        }));
        if (!cancelled) { setKeys(list); setMaps(Object.fromEntries(entries)); }
      } catch {
        if (!cancelled) setError("Failed to load API keys");
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen]);

  const assign = async (keyId, connectionId) => {
    const current = maps[keyId] || {};
    if ((current[providerId] || UNASSIGNED) === connectionId) return;
    // PUT replaces the whole map, so keep other providers' pins
    const next = { ...current, [providerId]: connectionId || null };
    setSavingId(keyId);
    setError("");
    try {
      const res = await fetch(`/api/keys/${keyId}/accounts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setMaps((m) => ({ ...m, [keyId]: data.accounts }));
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingId(null);
    }
  };

  const zones = [{ id: UNASSIGNED, name: "Unassigned", isActive: true }, ...connections.map((c) => ({
    id: c.id, name: c.name || c.email || c.id.slice(0, 8), isActive: c.isActive !== false,
  }))];
  const keysIn = (zoneId) => keys.filter((k) => ((maps[k.id] || {})[providerId] || UNASSIGNED) === zoneId);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="API key access" size="full">
      <p className="text-sm text-text-muted mb-3">
        Drag an API key into an account. A pinned key only uses that account for this provider, with no fallback.
      </p>
      {error && <p className="text-sm text-red-500 mb-3" role="alert">{error}</p>}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 max-h-[60vh] overflow-y-auto">
        {zones.map((zone) => (
          <div
            key={zone.id || "unassigned"}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); assign(e.dataTransfer.getData("text/plain"), zone.id); }}
            className={`rounded-lg border border-dashed border-border p-3 min-h-24 ${zone.isActive ? "" : "opacity-50"}`}
          >
            <div className="text-sm font-medium mb-2 truncate">
              {zone.name}{!zone.isActive && <span className="ml-1 text-xs text-text-muted">(disabled)</span>}
            </div>
            <div className="flex flex-col gap-2">
              {keysIn(zone.id).map((k) => (
                <div
                  key={k.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", k.id)}
                  className="flex items-center gap-2 rounded-md bg-surface-2 border border-border px-2 py-1 text-sm cursor-grab"
                >
                  <span className="truncate flex-1">{k.name || k.id.slice(0, 8)}</span>
                  <select
                    aria-label={`Account for ${k.name}`}
                    value={zone.id}
                    disabled={savingId === k.id}
                    onChange={(e) => assign(k.id, e.target.value)}
                    className="text-xs bg-transparent border border-border rounded px-1 max-w-28"
                  >
                    {zones.map((z) => <option key={z.id || "u"} value={z.id}>{z.name}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

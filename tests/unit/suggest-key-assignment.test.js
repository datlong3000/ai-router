import { describe, it, expect } from "vitest";
import { suggestKeyAssignment, minRemaining } from "../../src/app/(dashboard)/dashboard/providers/[id]/suggestKeyAssignment.js";

describe("suggestKeyAssignment", () => {
  it("balances 12 keys across 3 accounts and favors headroom", () => {
    const keys = Array.from({ length: 12 }, (_, i) => ({ id: `k${i}`, load: (12 - i) * 100 }));
    const out = suggestKeyAssignment(keys, [{ id: "a", remaining: 90 }, { id: "b", remaining: 90 }, { id: "c", remaining: 10 }]);
    expect(Object.keys(out)).toHaveLength(12);
    expect(out.k0).not.toBe("c");
    const count = (id) => Object.values(out).filter((v) => v === id).length;
    expect(count("c")).toBeLessThan(count("a"));
  });
  it("spreads zero-load keys evenly with unknown quota", () => {
    const keys = Array.from({ length: 6 }, (_, i) => ({ id: `k${i}`, load: 0 }));
    const out = suggestKeyAssignment(keys, [{ id: "a", remaining: null }, { id: "b", remaining: null }, { id: "c", remaining: null }]);
    for (const id of ["a", "b", "c"]) expect(Object.values(out).filter((v) => v === id)).toHaveLength(2);
  });
  it("minRemaining picks lowest window", () => {
    expect(minRemaining({ s: { remaining: 70, total: 100 }, w: { remaining: 15, total: 100 } })).toBe(15);
    expect(minRemaining({})).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { suggestKeyAssignment, minRemaining, median, sessionWeekly, timeLeft } from "../../src/app/(dashboard)/dashboard/providers/[id]/suggestKeyAssignment.js";

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
  it('median odd/even/empty', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  it('keeps only session + weekly, lowest per bucket (MiniMax 5h/7d folded in)', () => {
    const w = sessionWeekly({
      'MiniMax-M2 (5h)': { remainingPercentage: 60, resetAt: 'a' },
      'MiniMax-M2 (7d)': { remainingPercentage: 30, resetAt: 'b' },
      'Speech-02 (5h)': { remainingPercentage: 20, resetAt: 'c' },
      code_review: { remaining: 5, total: 100 },
    });
    expect(w.map((x) => [x.name, x.remaining, x.resetAt])).toEqual([['session', 20, 'c'], ['weekly', 30, 'b']]);
    expect(sessionWeekly({ session: { remaining: 82, total: 100 }, weekly: { remaining: 2, total: 100 } }).map((x) => x.remaining)).toEqual([82, 2]);
    expect(sessionWeekly({ foo: { remaining: 1, total: 100 } })).toEqual([]);
  });
  it('timeLeft formats remaining reset time', () => {
    const now = 0;
    expect(timeLeft(new Date(90 * 60000).toISOString(), now)).toBe('1h 30m');
    expect(timeLeft(new Date((3 * 24 + 4) * 3600000).toISOString(), now)).toBe('3d 4h');
    expect(timeLeft(new Date(0).toISOString(), 1)).toBe('now');
    expect(timeLeft('garbage', now)).toBeNull();
  });
});

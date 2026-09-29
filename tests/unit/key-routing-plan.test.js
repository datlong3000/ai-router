// Key routing rebalance (spec 2026-09-29): load = 24h tokens, capacity = weekly quota left.
// AC-S1 load share per account ∝ capacity (within one key's granularity)
// AC-S2 equal capacity → even split by load AND by key count where loads are similar
// AC-S3 already balanced → zero moves (sticky)
// AC-S4 near-empty account gets little/no load
// AC-S5 keys with no usage still spread (median fill), unpinned keys get assigned
// AC-S6 window resetting within 24h counts as full capacity
import { describe, it, expect } from "vitest";
import { planKeyAssignment, capacityOf, median } from "../../src/lib/keyRoutingPlan.js";

const share = (plan, id) => plan.accounts.find((a) => a.id === id);
const keys = (loads) => loads.map((load, i) => ({ id: `k${i}`, load }));

describe("planKeyAssignment", () => {
  it("S1 load share tracks capacity", () => {
    const plan = planKeyAssignment({
      keys: keys([900, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50]),
      accounts: [{ id: "a", cap: 80 }, { id: "b", cap: 40 }, { id: "c", cap: 20 }],
    });
    for (const id of ["a", "b", "c"]) {
      const s = share(plan, id);
      expect(Math.abs(s.loadShare - s.targetShare)).toBeLessThan(0.05);
    }
  });

  it("S2 equal capacity, skewed loads (user's 12×3 shape) → balanced load", () => {
    // Shape from the dashboard: 1 huge key, 2 medium, rest small
    const plan = planKeyAssignment({
      keys: keys([1475, 783, 237, 235, 163, 120, 90, 60, 40, 20, 10, 5]),
      accounts: [{ id: "a", cap: 100 }, { id: "b", cap: 100 }, { id: "c", cap: 100 }],
    });
    const shares = plan.accounts.map((a) => a.loadShare);
    // Huge key is 45% of total → it must be alone; others split the rest
    const huge = plan.assignment.k0;
    expect(Object.values(plan.assignment).filter((x) => x === huge)).toHaveLength(1);
    const rest = plan.accounts.filter((a) => a.id !== huge).map((a) => a.loadShare);
    expect(Math.abs(rest[0] - rest[1])).toBeLessThan(0.05);
    expect(Math.max(...shares)).toBeLessThan(0.5);
  });

  it("S3 already balanced → no moves", () => {
    const pins = { k0: "a", k1: "b", k2: "c", k3: "a", k4: "b", k5: "c" };
    const plan = planKeyAssignment({
      keys: keys([100, 100, 100, 100, 100, 100]),
      accounts: [{ id: "a", cap: 100 }, { id: "b", cap: 100 }, { id: "c", cap: 100 }],
      pins,
    });
    expect(plan.moves).toBe(0);
    expect(plan.assignment).toEqual(pins);
  });

  it("S3b one overloaded account → minimal moves fix it", () => {
    const pins = { k0: "a", k1: "a", k2: "a", k3: "b", k4: "c", k5: "a" };
    const plan = planKeyAssignment({
      keys: keys([100, 100, 100, 100, 100, 100]),
      accounts: [{ id: "a", cap: 100 }, { id: "b", cap: 100 }, { id: "c", cap: 100 }],
      pins,
    });
    expect(plan.moves).toBe(2);
    expect(plan.accounts.map((a) => a.keys)).toEqual([2, 2, 2]);
  });

  it("S4 exhausted account gets nothing", () => {
    const plan = planKeyAssignment({
      keys: keys([300, 200, 100, 50]),
      accounts: [{ id: "a", cap: 90 }, { id: "b", cap: 0 }],
      pins: { k0: "b", k1: "b" },
    });
    expect(Object.values(plan.assignment)).not.toContain("b");
  });

  it("S5 zero-usage keys spread evenly and unpinned keys are assigned", () => {
    const plan = planKeyAssignment({
      keys: keys([0, 0, 0, 0, 0, 0]),
      accounts: [{ id: "a", cap: 100 }, { id: "b", cap: 100 }, { id: "c", cap: 100 }],
    });
    expect(plan.accounts.map((a) => a.keys)).toEqual([2, 2, 2]);
    expect(Object.keys(plan.assignment)).toHaveLength(6);
  });

  it("S6 capacityOf: weekly left, but near-reset or unknown counts as full", () => {
    const now = 0, H = 3600000;
    expect(capacityOf({ remaining: 30, resetAt: new Date(3 * 24 * H).toISOString() }, now)).toBe(30);
    expect(capacityOf({ remaining: 2, resetAt: new Date(5 * H).toISOString() }, now)).toBe(100);
    expect(capacityOf(null)).toBe(100);
  });

  it("empty inputs and median", () => {
    expect(planKeyAssignment({ keys: [], accounts: [{ id: "a", cap: 1 }] }).assignment).toEqual({});
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

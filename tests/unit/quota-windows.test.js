import { describe, it, expect } from "vitest";
import { sessionWeekly, timeLeft, timeToEmpty } from "../../src/app/(dashboard)/dashboard/providers/[id]/quotaWindows.js";

describe("quota windows", () => {
  it("keeps only session + weekly, lowest per bucket (MiniMax 5h/7d folded in)", () => {
    const w = sessionWeekly({
      "MiniMax-M2 (5h)": { remainingPercentage: 60, resetAt: "a" },
      "MiniMax-M2 (7d)": { remainingPercentage: 30, resetAt: "b" },
      "Speech-02 (5h)": { remainingPercentage: 20, resetAt: "c" },
      code_review: { remaining: 5, total: 100 },
    });
    expect(w.map((x) => [x.name, x.remaining, x.resetAt])).toEqual([["session", 20, "c"], ["weekly", 30, "b"]]);
  });
  it("timeLeft formats", () => {
    expect(timeLeft(new Date(90 * 60000).toISOString(), 0)).toBe("1h 30m");
    expect(timeLeft(new Date((3 * 24 + 4) * 3600000).toISOString(), 0)).toBe("3d 4h");
    expect(timeLeft("garbage", 0)).toBeNull();
  });
  it("timeToEmpty only when it empties before reset", () => {
    const H = 3600000, W = 5 * H;
    expect(timeToEmpty({ remaining: 50, resetAt: new Date(4 * H).toISOString(), windowMs: W }, 0)).toBe(H);
    expect(timeToEmpty({ remaining: 80, resetAt: new Date(H).toISOString(), windowMs: W }, 0)).toBeNull();
  });
});

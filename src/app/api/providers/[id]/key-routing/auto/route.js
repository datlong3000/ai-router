import { NextResponse } from "next/server";
import { runAutoBalance, undoLastRun } from "@/lib/keyAutoBalance.js";

export const dynamic = "force-dynamic";

// POST /api/providers/[id]/key-routing/auto - body { action: "undo" | "run" }
// "undo" reverts the last auto-balance run; "run" triggers one now (same guardrails as the scheduler).
export async function POST(request, { params }) {
  try {
    const { id: providerId } = await params;
    if (!/^[a-z0-9][\w.-]{0,63}$/i.test(providerId) || ["__proto__", "constructor", "prototype"].includes(providerId)) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    const { action } = (await request.json().catch(() => null)) || {};
    if (action === "undo") return NextResponse.json(await undoLastRun(providerId));
    if (action === "run") return NextResponse.json({ last: await runAutoBalance(providerId) });
    return NextResponse.json({ error: "action must be \"undo\" or \"run\"" }, { status: 400 });
  } catch (error) {
    console.log("Error in key auto-balance:", error);
    return NextResponse.json({ error: "Auto-balance failed" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { buildPlan } from "@/lib/keyAutoBalance.js";

export const dynamic = "force-dynamic";

// GET /api/providers/[id]/key-routing/suggest
// Rebalance plan: key load = last-24h tokens, account capacity = weekly quota left;
// load share per account ∝ capacity, minimal pin moves. Read-only.
export async function GET(_request, { params }) {
  try {
    const { id: providerId } = await params;
    const { changes, accounts } = await buildPlan(providerId);
    return NextResponse.json({ changes, accounts });
  } catch (error) {
    console.log("Error building key routing suggestion:", error);
    return NextResponse.json({ error: "Failed to build suggestion" }, { status: 500 });
  }
}

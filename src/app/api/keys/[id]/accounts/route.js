import { NextResponse } from "next/server";
import { getApiKeyById, getKeyAccounts, setKeyAccounts, getProviderConnectionById } from "@/lib/localDb";

// GET /api/keys/[id]/accounts - { accounts: { [provider]: connectionId } }
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    if (!(await getApiKeyById(id))) return NextResponse.json({ error: "Key not found" }, { status: 404 });
    return NextResponse.json({ accounts: await getKeyAccounts(id) });
  } catch (error) {
    console.log("Error fetching key accounts:", error);
    return NextResponse.json({ error: "Failed to fetch key accounts" }, { status: 500 });
  }
}

// PUT /api/keys/[id]/accounts - body { accounts: { [provider]: connectionId|null } }
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    if (!(await getApiKeyById(id))) return NextResponse.json({ error: "Key not found" }, { status: 404 });

    const body = await request.json().catch(() => null);
    const accounts = body?.accounts;
    if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) {
      return NextResponse.json({ error: "accounts must be an object" }, { status: 400 });
    }
    for (const [provider, connectionId] of Object.entries(accounts)) {
      if (connectionId === null || connectionId === "") continue;
      if (typeof connectionId !== "string") {
        return NextResponse.json({ error: `Invalid connection for ${provider}` }, { status: 400 });
      }
      const conn = await getProviderConnectionById(connectionId);
      if (!conn || conn.provider !== provider) {
        return NextResponse.json({ error: `Connection ${connectionId} does not belong to provider ${provider}` }, { status: 400 });
      }
    }
    return NextResponse.json({ accounts: await setKeyAccounts(id, accounts) });
  } catch (error) {
    console.log("Error updating key accounts:", error);
    return NextResponse.json({ error: "Failed to update key accounts" }, { status: 500 });
  }
}

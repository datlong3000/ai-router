import { getApiKeyByKey, getKeyAccounts } from "@/lib/localDb";
import { resolveProviderId } from "@/shared/constants/providers.js";

export const PINNED_UNAVAILABLE = "Assigned provider account unavailable";

/**
 * Resolve which provider account an API key may use. Derived only from the
 * authenticated key server-side — never from client-supplied ids.
 * @returns {{mode:"pool"}|{mode:"pinned",connectionId:string}|{mode:"reject",status:number,message:string}}
 */
export async function resolveKeyAccount({ apiKey, provider, strict = false }) {
  const key = apiKey ? await getApiKeyByKey(apiKey) : null;
  if (!key || !key.isActive) {
    // Non-strict: requireApiKey gate (if on) already ran in the handler
    return strict ? { mode: "reject", status: 401, message: apiKey ? "Invalid API key" : "Missing API key" } : { mode: "pool" };
  }
  const accounts = await getKeyAccounts(key.id);
  const providerId = resolveProviderId(provider);
  if (accounts[providerId]) return { mode: "pinned", connectionId: accounts[providerId] };
  if (Object.keys(accounts).length > 0 || strict) {
    return { mode: "reject", status: 403, message: `API key not assigned to an account for provider ${providerId}` };
  }
  return { mode: "pool" };
}

// Handler helper: { reject } or { allowedConnectionIds } (null = unrestricted pool)
export async function getKeyAccountScope(apiKey, provider, settings) {
  const route = await resolveKeyAccount({ apiKey, provider, strict: !!settings?.strictKeyAccountRouting });
  if (route.mode === "reject") return { reject: route };
  if (route.mode !== "pinned") return { allowedConnectionIds: null, pinnedFirst: null };
  // Per-provider fallback: pinned account first, then the rest of the pool in Connections priority order
  if (settings?.keyAccountFallback?.[resolveProviderId(provider)]) {
    return { allowedConnectionIds: null, pinnedFirst: route.connectionId };
  }
  return { allowedConnectionIds: new Set([route.connectionId]), pinnedFirst: null };
}

// Pinned key whose account is gone/disabled/locked/failed: fixed 403, never try another account
export function pinnedUnavailableResponse(scope) {
  if (!scope?.allowedConnectionIds) return null;
  return new Response(JSON.stringify({ error: { message: PINNED_UNAVAILABLE, type: "permission_error" } }), {
    status: 403, headers: { "Content-Type": "application/json" },
  });
}

export function keyRejectResponse(scope) {
  if (!scope?.reject) return null;
  const { status, message } = scope.reject;
  return new Response(JSON.stringify({ error: { message, type: status === 401 ? "authentication_error" : "permission_error" } }), {
    status, headers: { "Content-Type": "application/json" },
  });
}

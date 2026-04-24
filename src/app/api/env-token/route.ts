import { NextResponse } from "next/server";
import { getOptimizelyEnvToken } from "@/lib/resolve-token";

/** Returns the server-configured token for dev UI prefill (do not expose in production without auth). */
export async function GET() {
  const t = getOptimizelyEnvToken();
  return NextResponse.json({ token: t.length > 0 ? t : null });
}

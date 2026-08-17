import { NextResponse } from "next/server";
import {
  getExpAuthTokenHeader,
  getOptimizelyEnvToken,
} from "@/lib/resolve-token";

/**
 * Prefill token for the UI.
 * Prefer browser/proxy ExpAuthToken header, then OPTIMIZELY_API_TOKEN.
 * (Do not expose in production without auth.)
 */
export async function GET(req: Request) {
  const fromHeader = getExpAuthTokenHeader(req);
  const fromEnv = getOptimizelyEnvToken();
  const t = fromHeader || fromEnv;
  return NextResponse.json({
    token: t.length > 0 ? t : null,
    source: fromHeader ? "ExpAuthToken" : fromEnv ? "env" : null,
  });
}

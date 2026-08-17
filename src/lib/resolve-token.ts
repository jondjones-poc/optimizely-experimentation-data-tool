import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Browser / proxy header that supplies the Optimizely PAT for this app. */
export const EXP_AUTH_TOKEN_HEADER = "ExpAuthToken";

let envLocalCache: { mtimeMs: number; value: string } | null = null;

/** Parse OPTIMIZELY_API_TOKEN from .env.local when process.env is empty (e.g. OS env set to blank overrides dotenv). */
function tokenFromEnvLocalFile(): string {
  try {
    const path = join(process.cwd(), ".env.local");
    const st = statSync(path);
    if (envLocalCache && envLocalCache.mtimeMs === st.mtimeMs) {
      return envLocalCache.value;
    }
    const raw = readFileSync(path, "utf8");
    let token = "";
    for (const line of raw.split("\n")) {
      const trimmed = line.replace(/\r$/, "").trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (key !== "OPTIMIZELY_API_TOKEN") continue;
      let v = trimmed.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      token = v.trim();
      break;
    }
    envLocalCache = { mtimeMs: st.mtimeMs, value: token };
    return token;
  } catch {
    return "";
  }
}

/** Token from environment / .env.local only (no request body). */
export function getOptimizelyEnvToken(): string {
  // Dynamic key so the bundler does not replace with a build-time empty value.
  const fromProcess = (process.env["OPTIMIZELY" + "_API_TOKEN"] ?? "").trim();
  if (fromProcess.length > 0) return fromProcess;
  return tokenFromEnvLocalFile();
}

/** Read ExpAuthToken from a browser/proxy-injected request header. */
export function getExpAuthTokenHeader(req: Request): string {
  const raw = req.headers.get(EXP_AUTH_TOKEN_HEADER)?.trim() ?? "";
  if (!raw) return "";
  return raw.replace(/^Bearer\s+/i, "").trim();
}

/**
 * Resolve PAT for Optimizely API calls.
 * Priority: ExpAuthToken header → form body token → Authorization Bearer → .env
 */
export function resolveOptimizelyToken(
  req: Request,
  body: Record<string, unknown> = {},
): string {
  const expAuth = getExpAuthTokenHeader(req);
  if (expAuth) return expAuth;

  const bodyToken = typeof body.token === "string" ? body.token.trim() : "";
  if (bodyToken) return bodyToken;

  const headerAuth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")?.trim();
  if (headerAuth) return headerAuth;

  return getOptimizelyEnvToken() || "";
}

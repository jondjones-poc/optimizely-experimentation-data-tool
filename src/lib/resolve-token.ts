import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

export function resolveOptimizelyToken(
  req: Request,
  body: Record<string, unknown>,
): string {
  const headerAuth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")?.trim();
  const bodyToken = typeof body.token === "string" ? body.token.trim() : "";
  return bodyToken || headerAuth || getOptimizelyEnvToken() || "";
}

let insecureTlsApplied = false;

/** Dev-only: set OPTIMIZELY_INSECURE_TLS=1 in .env.local when a corporate proxy breaks Node TLS. */
export function applyInsecureTlsIfConfigured(): void {
  if (insecureTlsApplied) return;
  const flag = (process.env.OPTIMIZELY_INSECURE_TLS ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    insecureTlsApplied = true;
  }
}

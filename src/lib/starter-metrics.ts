/** Default arm rates when seeding per-metric inputs (0–1). */
export const DEFAULT_CONTROL_RATE = "0.20";
export const DEFAULT_TREATMENT_RATE = "0.85";

export type StarterCustomEventDef = {
  name: string;
  key: string;
};

/** Custom events created when an experiment has no resolved metrics. */
export const STARTER_CUSTOM_EVENTS: StarterCustomEventDef[] = [
  { name: "Visited Page", key: "visited_page" },
  { name: "Clicked on CTA Button", key: "clicked_on_cta_button" },
];

/** Match project-prefixed keys from Optimizely (e.g. `{projectId}_visited_page`). */
export function logxPropertiesForEventKey(_key: string): Record<string, string> | undefined {
  return undefined;
}

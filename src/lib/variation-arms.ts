/** Client-safe helpers (no Node crypto). Used by UI and logx. */

export type VariationInfo = { variation_id: string; name: string };

export type ControlTreatmentPair = {
  control: VariationInfo;
  treatment: VariationInfo;
};

export type TrafficMode = "balanced" | "all_treatment";

/**
 * Pick variation for simulated logx traffic: an even split across every variation (balanced), or
 * 100% treatment. onControl is false for every non-control arm, so extra arms use treatment rates.
 */
export function pickSimulationVariation(
  variations: VariationInfo[],
  mode: TrafficMode,
): { variation: VariationInfo; onControl: boolean } {
  const { control, treatment } = resolveControlTreatment(variations);
  if (mode === "all_treatment") {
    return { variation: treatment, onControl: false };
  }
  const variation = variations[Math.floor(Math.random() * variations.length)] ?? control;
  return { variation, onControl: variation.variation_id === control.variation_id };
}

/** Original/control vs challenger; defaults to first variation as control if unnamed. */
export function resolveControlTreatment(variations: VariationInfo[]): ControlTreatmentPair {
  if (variations.length === 0) {
    throw new Error("resolveControlTreatment requires at least one variation");
  }
  if (variations.length === 1) {
    return { control: variations[0]!, treatment: variations[0]! };
  }
  const controlIdx = variations.findIndex((v) => /\boriginal\b|\bcontrol\b/i.test(v.name));
  const control = variations[controlIdx >= 0 ? controlIdx : 0]!;
  const treatment =
    variations.find((v) => v.variation_id !== control.variation_id) ?? variations[1]!;
  return { control, treatment };
}

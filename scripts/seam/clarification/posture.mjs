// Owned clarification posture (spec #221, ticket #222): the one evaluation
// of the config block that the seam's clarification routes gate on and the
// dashboard's affordance reads. Three states, never a score: "disabled" —
// the block is absent or switched off (public installs live here by
// construction, ADR 0013); "invalid" — the block asks to be enabled but is
// incomplete or malformed, with one reason per offending element;
// "enabled" — the posture names its provider and data destination. Enabled
// is posture, not availability: the clarification runtime ships in a later
// ticket, so `available` is false in every state this build can produce.

export const evaluateClarificationPosture = (clarification) => {
  const reasons = [...(clarification?.problems ?? [])];
  const enabled = clarification?.enabled === true;
  if (enabled) {
    // `null` fields are present-but-invalid — their own problem already
    // names the defect; only a truly absent field is called missing.
    if (clarification.provider === undefined)
      reasons.push("clarification.provider is required when clarification is enabled");
    if (clarification.dataDestination === undefined)
      reasons.push("clarification.dataDestination is required when clarification is enabled");
  }
  if (reasons.length > 0) return { posture: "invalid", reasons, available: false };
  if (!enabled) return { posture: "disabled", available: false };
  return { posture: "enabled", available: false };
};

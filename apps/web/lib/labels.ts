/** Plain-word labels for provider and role names stored on a transcript. */

/** "deepgram/nova-3-live" -> "Deepgram Nova-3 (live)". Unknown names pass through. */
export function sttLabel(stt: string | null | undefined): string {
  if (!stt) return "unknown";
  if (stt.startsWith("script/")) return "Script (ground truth)";
  const m = /^deepgram\/(nova-\d+)(-live)?$/.exec(stt);
  if (m) return `Deepgram ${m[1]!.replace(/^nova/, "Nova")} (${m[2] ? "live" : "file"})`;
  return stt;
}

export const ROLE_SOURCE: Record<string, { label: string; help: string }> = {
  channel: { label: "separate channels", help: "Customer and crew were on separate audio channels, so each line's role comes from its channel." },
  diarization: {
    label: "diarization",
    help: "One mixed channel: the transcriber told the voices apart, and each voice was labeled crew or customer from what it said. Lines marked ? were guessed from wording.",
  },
  wording: { label: "wording", help: "Roles were guessed from what each line says. Lines marked ? were guessed." },
  script: { label: "script", help: "Lines come from the fixture's script, which says who spoke each one." },
};

const GOOD = "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400";
const BUSY = "bg-sky-500/12 text-sky-700 dark:text-sky-400";
const BAD = "bg-rose-500/12 text-rose-700 dark:text-rose-400";
const IDLE = "bg-fill text-muted";

const TONES: Record<string, string> = {
  completed: GOOD,
  delivered: GOOD,
  pass: GOOD,
  needs_review: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  pending: BUSY,
  running: BUSY,
  delivering: BUSY,
  queued: IDLE,
  cancelled: IDLE,
  abandoned: "bg-orange-500/12 text-orange-700 dark:text-orange-400",
  incomplete: "bg-violet-500/12 text-violet-700 dark:text-violet-400",
  failed: BAD,
  dead: BAD,
  fail: BAD,
};

export function Badge({ value, label }: { value: string; label?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${TONES[value] ?? IDLE}`}>
      {label ?? value.replace(/_/g, " ")}
    </span>
  );
}

export function Flag({ value }: { value: string }) {
  const tone =
    value === "placeholder_values"
      ? "bg-yellow-400/20 text-yellow-800 dark:text-yellow-300"
      : value.includes("mismatch") || value.includes("missing")
        ? BAD
        : IDLE;
  return <span className={`inline-flex rounded px-1.5 py-0.5 font-mono text-[10.5px] ${tone}`}>{value}</span>;
}

/** Yellow badge for any value that is still a sandbox default rather than a real Serv value. */
export function Placeholder({ note }: { note?: string }) {
  return (
    <span title={note} className="inline-flex items-center rounded-full bg-yellow-400/20 px-1.5 py-px text-[10px] font-semibold text-yellow-800 dark:text-yellow-300">
      Placeholder
    </span>
  );
}

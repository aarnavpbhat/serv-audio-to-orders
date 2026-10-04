const TONES: Record<string, string> = {
  completed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  delivered: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  pass: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  needs_review: "bg-amber-50 text-amber-800 ring-amber-200",
  pending: "bg-sky-50 text-sky-700 ring-sky-200",
  running: "bg-sky-50 text-sky-700 ring-sky-200",
  queued: "bg-slate-50 text-slate-600 ring-slate-200",
  delivering: "bg-sky-50 text-sky-700 ring-sky-200",
  cancelled: "bg-slate-100 text-slate-600 ring-slate-200",
  abandoned: "bg-orange-50 text-orange-700 ring-orange-200",
  incomplete: "bg-violet-50 text-violet-700 ring-violet-200",
  failed: "bg-rose-50 text-rose-700 ring-rose-200",
  dead: "bg-rose-50 text-rose-700 ring-rose-200",
  fail: "bg-rose-50 text-rose-700 ring-rose-200",
};

export function Badge({ value, label }: { value: string; label?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[value] ?? "bg-slate-50 text-slate-700 ring-slate-200"}`}>
      {label ?? value.replace(/_/g, " ")}
    </span>
  );
}

export function Flag({ value }: { value: string }) {
  const tone = value === "placeholder_values" ? "bg-yellow-50 text-yellow-800 ring-yellow-300" : value.includes("mismatch") || value.includes("missing") ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-slate-50 text-slate-700 ring-slate-200";
  return <span className={`inline-flex rounded-md px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-inset ${tone}`}>{value}</span>;
}

/** Yellow badge for any value that is still a sandbox default rather than a real Serv value. */
export function Placeholder({ note }: { note?: string }) {
  return (
    <span title={note} className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-[11px] font-semibold text-yellow-800 ring-1 ring-inset ring-yellow-300">
      Placeholder
    </span>
  );
}

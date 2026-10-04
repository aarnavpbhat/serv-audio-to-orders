export function JsonView({ value, summary = "JSON" }: { value: unknown; summary?: string }) {
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-xs font-medium text-muted hover:text-ink">{summary}</summary>
      <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

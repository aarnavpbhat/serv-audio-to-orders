export function JsonView({ value, summary = "JSON" }: { value: unknown; summary?: string }) {
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-[11px] font-medium text-muted hover:text-ink">{summary}</summary>
      <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-black/85 p-3 font-mono text-[11px] leading-relaxed text-neutral-100 dark:bg-black/50">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

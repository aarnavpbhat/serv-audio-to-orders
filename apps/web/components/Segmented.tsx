"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup";

/** macOS segmented control, built on the shadcn ToggleGroup. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; disabled?: boolean }[];
  label: string;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      spacing={0}
      aria-label={label}
      value={value}
      // Radix sends "" when the active item is clicked again; keep the selection.
      onValueChange={(v) => v && onChange(v as T)}
      className="rounded-lg bg-muted p-0.5"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className="h-6 rounded-md! px-3 text-[12px] font-medium text-muted-foreground hover:bg-transparent data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-fill-strong"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

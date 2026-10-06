"use client";

import { ChevronRightIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/Collapsible";

export function JsonView({ value, summary = "JSON" }: { value: unknown; summary?: string }) {
  return (
    <Collapsible className="group/json">
      <CollapsibleTrigger className="flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/json:rotate-90" />
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-black/85 p-3 font-mono text-[11px] leading-relaxed text-neutral-100 dark:bg-black/50">{JSON.stringify(value, null, 2)}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

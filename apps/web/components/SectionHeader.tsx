import { cn } from "@/lib/utils";

/**
 * A card or section title with its details on their own line below (smaller,
 * muted), and optional actions on the right. Details never share the title's
 * line, so a long details string wraps instead of running into the title.
 */
export function SectionHeader({
  title,
  details,
  actions,
  className,
  titleClassName,
  detailsClassName,
}: {
  title: React.ReactNode;
  details?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  titleClassName?: string;
  detailsClassName?: string;
}) {
  return (
    <div data-section-header className={cn("mb-2 flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <h2 data-header-title className={cn("section-title", titleClassName)}>
          {title}
        </h2>
        {details && (
          <p data-header-details className={cn("mt-0.5 break-words text-[12px] text-muted-foreground", detailsClassName)}>
            {details}
          </p>
        )}
      </div>
      {actions && (
        <div data-header-actions className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
          {actions}
        </div>
      )}
    </div>
  );
}

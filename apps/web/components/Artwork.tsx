/**
 * Generated "album art" for a fixture or run: a deterministic two-tone gradient
 * with a waveform glyph, so the same file always gets the same cover.
 */
/** Two-tone gradients from Serv's palette (globals.css --art-*), so covers follow the brand and the theme. */
const PALETTES: [string, string][] = Array.from({ length: 6 }, (_, i) => [`var(--art-${i}a)`, `var(--art-${i}b)`]);

export function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The base fixture id ("05_removed_and_upsell") so mono and stereo copies share a cover. */
export function coverKey(file: string): string {
  return file.split(/[./]/)[0] ?? file;
}

export function palette(key: string): [string, string] {
  return PALETTES[hashOf(coverKey(key)) % PALETTES.length] ?? PALETTES[0]!;
}

export function Artwork({ seed, label, size = "md", className = "" }: { seed: string; label?: string; size?: "xs" | "sm" | "md" | "lg" | "xl"; className?: string }) {
  const [a, b] = palette(seed);
  const h = hashOf(seed);
  const bars = Array.from({ length: 9 }, (_, i) => 0.25 + (((h >>> (i * 3)) & 7) / 7) * 0.75);
  const dims = { xs: "h-6 w-6 rounded", sm: "h-10 w-10 rounded-md", md: "aspect-square w-full rounded-lg", lg: "h-48 w-48 rounded-xl", xl: "h-56 w-56 rounded-xl" }[size];
  const showLabel = label && (size === "md" || size === "lg" || size === "xl");
  return (
    <div className={`relative shrink-0 overflow-hidden shadow-art ${dims} ${className}`} style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}>
      <div className="absolute inset-0 flex items-center justify-center gap-[6%] px-[18%]">
        {bars.map((v, i) => (
          <span key={i} className="flex-1 rounded-full bg-white/85 mix-blend-overlay" style={{ height: `${v * 46}%` }} />
        ))}
      </div>
      {showLabel && (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/45 to-transparent px-[8%] pb-[7%] pt-[20%]">
          <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-white/90">{label}</div>
        </div>
      )}
    </div>
  );
}

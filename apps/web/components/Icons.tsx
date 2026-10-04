/** Small inline SF Symbols-style icons, so the UI needs no icon dependency. */
type P = { className?: string };

const base = (className?: string) => ({ className: className ?? "h-4 w-4", viewBox: "0 0 24 24", "aria-hidden": true });

export const PlayIcon = ({ className }: P) => (
  <svg {...base(className)} fill="currentColor">
    <path d="M7 4.8v14.4c0 .8.9 1.3 1.6.9l11.3-7.2c.6-.4.6-1.3 0-1.7L8.6 3.9C7.9 3.5 7 4 7 4.8Z" />
  </svg>
);

export const PauseIcon = ({ className }: P) => (
  <svg {...base(className)} fill="currentColor">
    <rect x="6" y="4" width="4.2" height="16" rx="1.2" />
    <rect x="13.8" y="4" width="4.2" height="16" rx="1.2" />
  </svg>
);

export const BackIcon = ({ className }: P) => (
  <svg {...base(className)} fill="currentColor">
    <path d="M11.5 6.2v11.6c0 .7-.8 1.1-1.3.7L2.9 12.7a.9.9 0 0 1 0-1.4l7.3-5.8c.5-.4 1.3 0 1.3.7Zm10 0v11.6c0 .7-.8 1.1-1.3.7l-7.3-5.8a.9.9 0 0 1 0-1.4l7.3-5.8c.5-.4 1.3 0 1.3.7Z" />
  </svg>
);

export const ForwardIcon = ({ className }: P) => (
  <svg {...base(className)} fill="currentColor">
    <path d="M12.5 6.2v11.6c0 .7.8 1.1 1.3.7l7.3-5.8a.9.9 0 0 0 0-1.4l-7.3-5.8c-.5-.4-1.3 0-1.3.7Zm-10 0v11.6c0 .7.8 1.1 1.3.7l7.3-5.8a.9.9 0 0 0 0-1.4L3.8 5.5c-.5-.4-1.3 0-1.3.7Z" />
  </svg>
);

export const SearchIcon = ({ className }: P) => (
  <svg {...base(className)} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m20 20-4.8-4.8" />
  </svg>
);

export const WaveIcon = ({ className }: P) => (
  <svg {...base(className)} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <path d="M3 10v4M7 6v12M11 3v18M15 7v10M19 10v4" />
  </svg>
);

export const InboxIcon = ({ className }: P) => (
  <svg {...base(className)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
    <path d="M3 13h5l1.5 3h5l1.5-3h5" />
    <path d="M5.5 5h13l2.5 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l2.5-8Z" />
  </svg>
);

export const ChartIcon = ({ className }: P) => (
  <svg {...base(className)} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <path d="M5 20V12M10 20V6M15 20v-9M20 20V4" />
  </svg>
);

export const LyricsIcon = ({ className }: P) => (
  <svg {...base(className)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5v-9Z" />
    <path d="M8 8.5h8M8 12h5" strokeLinecap="round" />
  </svg>
);

export const ListIcon = ({ className }: P) => (
  <svg {...base(className)} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1" fill="currentColor" />
    <circle cx="4.5" cy="12" r="1" fill="currentColor" />
    <circle cx="4.5" cy="18" r="1" fill="currentColor" />
  </svg>
);

export const ClockIcon = ({ className }: P) => (
  <svg {...base(className)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const GearIcon = ({ className }: P) => (
  <svg {...base(className)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </svg>
);

export const UploadIcon = ({ className }: P) => (
  <svg {...base(className)} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
  </svg>
);

export const CheckIcon = ({ className }: P) => (
  <svg {...base(className)} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

export const XIcon = ({ className }: P) => (
  <svg {...base(className)} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </svg>
);

/** Animated equalizer bars, shown next to the row that is "now playing". */
export const Equalizer = ({ className }: P) => (
  <span className={`inline-flex h-3 items-end gap-[2px] ${className ?? ""}`} aria-hidden>
    {[0, 1, 2].map((i) => (
      <span key={i} className="w-[3px] animate-[eq_0.9s_ease-in-out_infinite] rounded-sm bg-current" style={{ animationDelay: `${i * 0.18}s`, height: "100%" }} />
    ))}
  </span>
);

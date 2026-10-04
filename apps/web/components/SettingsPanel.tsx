import { GearIcon } from "./Icons";
import { Placeholder } from "./Badge";

interface Props {
  settings: {
    serv: { key: string; value: string; placeholder: boolean; note: string }[];
    keys: { deepgram: boolean; gemini: boolean };
    geminiModel: string;
    language: string;
  };
}

/** Grouped settings list, in the style of macOS System Settings. */
export function SettingsPanel({ settings }: Props) {
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="section-title">Sandbox Settings</h2>
        <span className="text-[12px] text-muted">Values that depend on Serv live in config/sandbox.ts. Defaults are marked until replaced.</span>
      </div>
      <div className="panel divide-y divide-line overflow-hidden">
        {settings.serv.map((s) => (
          <div key={s.key} className="flex items-center gap-3 px-4 py-2">
            <GearIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="w-56 shrink-0 font-mono text-[12px]">{s.key}</span>
            <span className="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-muted" title={s.value}>
              {s.value === "null" ? "unset" : s.value}
            </span>
            <span className="w-[74px] shrink-0 text-right">{s.placeholder && <Placeholder note={s.note} />}</span>
          </div>
        ))}
        <div className="flex items-center gap-3 px-4 py-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${settings.keys.deepgram ? "bg-emerald-500" : "bg-rose-500"}`} />
          <span className="flex-1">Deepgram Nova-3 ({settings.language})</span>
          <span className="text-muted">{settings.keys.deepgram ? "key set" : "no key"}</span>
        </div>
        <div className="flex items-center gap-3 px-4 py-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${settings.keys.gemini ? "bg-emerald-500" : "bg-rose-500"}`} />
          <span className="flex-1">Gemini ({settings.geminiModel}), free tier with daily cap</span>
          <span className="text-muted">{settings.keys.gemini ? "key set" : "no key"}</span>
        </div>
      </div>
    </section>
  );
}

import { Placeholder } from "./Badge";

interface Props {
  settings: {
    serv: { key: string; value: string; placeholder: boolean; note: string }[];
    keys: { deepgram: boolean; gemini: boolean };
    geminiModel: string;
    language: string;
  };
}

export function SettingsPanel({ settings }: Props) {
  return (
    <aside className="card h-fit p-4">
      <h2 className="font-semibold">Sandbox settings</h2>
      <p className="mt-1 text-xs text-muted">Values that depend on Serv live in config/sandbox.ts. Defaults are marked until replaced.</p>
      <dl className="mt-4 space-y-3">
        {settings.serv.map((s) => (
          <div key={s.key}>
            <dt className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-ink">{s.key}</span>
              {s.placeholder && <Placeholder note={s.note} />}
            </dt>
            <dd className="mt-0.5 truncate font-mono text-xs text-muted" title={s.value}>
              {s.value === "null" ? "unset" : s.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 border-t border-line pt-3 text-xs">
        <div className="label mb-2">Providers</div>
        <div className="flex justify-between">
          <span>Deepgram Nova-3 ({settings.language})</span>
          <span className={settings.keys.deepgram ? "text-emerald-700" : "text-rose-700"}>{settings.keys.deepgram ? "key set" : "no key"}</span>
        </div>
        <div className="mt-1 flex justify-between">
          <span>Gemini ({settings.geminiModel})</span>
          <span className={settings.keys.gemini ? "text-emerald-700" : "text-rose-700"}>{settings.keys.gemini ? "key set" : "no key"}</span>
        </div>
      </div>
    </aside>
  );
}

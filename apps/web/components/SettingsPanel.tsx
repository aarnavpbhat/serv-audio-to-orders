import { Card } from "@/components/ui/Card";
import { Separator } from "@/components/ui/Separator";
import { cn } from "@/lib/utils";
import { Placeholder } from "./Badge";
import { GearIcon } from "./Icons";

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
  const rows = [
    ...settings.serv.map((s) => (
      <div key={s.key} className="flex items-center gap-3 px-4 py-2">
        <GearIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="w-56 shrink-0 font-mono text-[12px]">{s.key}</span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-muted-foreground" title={s.value}>
          {s.value === "null" ? "unset" : s.value}
        </span>
        <span className="w-[74px] shrink-0 text-right">{s.placeholder && <Placeholder note={s.note} />}</span>
      </div>
    )),
    <KeyRow key="deepgram" ok={settings.keys.deepgram} label={`Deepgram Nova-3 (${settings.language})`} />,
    <KeyRow key="gemini" ok={settings.keys.gemini} label={`Gemini (${settings.geminiModel}), free tier with daily cap`} />,
  ];
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="section-title">Sandbox Settings</h2>
        <span className="text-[12px] text-muted-foreground">Values that depend on Serv live in config/sandbox.ts. Defaults are marked until replaced.</span>
      </div>
      <Card className="gap-0 py-0">
        {rows.map((row, i) => (
          <div key={row.key}>
            {i > 0 && <Separator />}
            {row}
          </div>
        ))}
      </Card>
    </section>
  );
}

function KeyRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <span className={cn("size-2 shrink-0 rounded-full", ok ? "bg-emerald-500" : "bg-rose-500")} />
      <span className="flex-1">{label}</span>
      <span className="text-muted-foreground">{ok ? "key set" : "no key"}</span>
    </div>
  );
}

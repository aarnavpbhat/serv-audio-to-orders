import { NewRunForm } from "@/components/NewRunForm";
import { RunsTable } from "@/components/RunsTable";
import { SettingsPanel } from "@/components/SettingsPanel";
import { settings } from "@/lib/data";
import { listFixtureAudio } from "@/lib/fixtures";

export const dynamic = "force-dynamic";

export default function Home() {
  const s = settings();
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <section>
          <h1 className="text-xl font-semibold">Runs</h1>
          <p className="mt-1 text-sm text-muted">Upload an HME drive-thru recording or pick a generated fixture. Each conversation becomes an order and is POSTed to the webhook.</p>
        </section>
        <NewRunForm fixtures={listFixtureAudio()} keys={s.keys} />
        <RunsTable />
      </div>
      <SettingsPanel settings={s} />
    </div>
  );
}

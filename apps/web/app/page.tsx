import { NewRunForm } from "@/components/NewRunForm";
import { RunsTable } from "@/components/RunsTable";
import { SettingsPanel } from "@/components/SettingsPanel";
import { settings } from "@/lib/data";
import { listFixtureAudio } from "@/lib/fixtures";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const s = settings();
  return (
    <div className="mx-auto max-w-[1180px] space-y-10 px-8 pb-16 pt-8">
      <header>
        <h1 className="title-xl">{q ? `Results for "${q}"` : "Runs"}</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">Drive-thru audio in, structured orders out, every step visible.</p>
      </header>
      <NewRunForm fixtures={listFixtureAudio()} keys={s.keys} query={q} />
      <RunsTable query={q} />
      <SettingsPanel settings={s} />
    </div>
  );
}

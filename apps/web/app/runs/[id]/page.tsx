import { getConfig } from "@serv/config";
import { notFound } from "next/navigation";
import { RunView } from "@/components/run/RunView";
import { getRunDetail, menuJson } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const initial = getRunDetail(id);
  if (!initial) notFound();
  const cfg = getConfig();
  return (
    <RunView
      id={id}
      initial={initial}
      menu={menuJson()}
      thresholds={cfg.thresholds.value}
      site={{
        location: { value: cfg.locationId.value, placeholder: cfg.locationId.placeholder, note: cfg.locationId.note },
        lane: { value: cfg.laneId.value, placeholder: cfg.laneId.placeholder, note: cfg.laneId.note },
        webhook: { value: cfg.webhookUrl.value, placeholder: cfg.webhookUrl.placeholder, note: cfg.webhookUrl.note },
      }}
    />
  );
}

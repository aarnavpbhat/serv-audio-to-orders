import { getConfig } from "@serv/config";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Simulator } from "@/components/simulator/Simulator";
import { menuJson } from "@/lib/data";
import { isLocalHeaders } from "@/lib/dev-routes";

export const dynamic = "force-dynamic";

/** Dev only: a fake HME base station in the browser (plan D11). */
export default async function SimulatorPage() {
  const cfg = getConfig();
  if (!cfg.enableDevRoutes || !isLocalHeaders(await headers())) notFound();
  return <Simulator menu={menuJson()} defaults={{ storeId: "store_sim", laneId: "lane_1" }} deepgram={!!cfg.deepgramApiKey} />;
}

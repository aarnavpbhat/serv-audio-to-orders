import { LivePage } from "@/components/live/LivePage";
import { menuJson } from "@/lib/data";

export const dynamic = "force-dynamic";

export default function Live() {
  return <LivePage menu={menuJson()} />;
}

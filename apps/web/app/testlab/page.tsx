import { getConfig } from "@serv/config";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { TestLab } from "@/components/testlab/TestLab";
import { menuJson } from "@/lib/data";
import { isLocalHeaders } from "@/lib/dev-routes";
import { scenarios } from "@/lib/testlab";

export const dynamic = "force-dynamic";

/** Dev only: guided tests against the real endpoint (v2.1 step 7). */
export default async function TestLabPage() {
  const cfg = getConfig();
  if (!cfg.enableDevRoutes || !isLocalHeaders(await headers())) notFound();
  return <TestLab scenarios={scenarios()} menu={menuJson()} deepgram={!!cfg.deepgramApiKey} />;
}

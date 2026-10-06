import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { LivePage } from "@/components/live/LivePage";
import { menuJson } from "@/lib/data";
import { isLocalHeaders } from "@/lib/dev-routes";

export const dynamic = "force-dynamic";

export default async function Live() {
  if (!isLocalHeaders(await headers())) notFound();
  return <LivePage menu={menuJson()} />;
}

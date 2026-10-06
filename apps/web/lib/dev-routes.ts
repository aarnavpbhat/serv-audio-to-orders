/**
 * Dev-only routes (simulator, ingest tickets, review tools) answer only when
 * ENABLE_DEV_ROUTES=true and the request came to a local address. The app also
 * binds to 127.0.0.1 by default, which is the control that actually keeps
 * other machines out; the Host check is a second line.
 */
import { getConfig } from "@serv/config";
import { NotFoundError } from "@/lib/error-handler";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLocalRequest(req: Request): boolean {
  const host = req.headers.get("host") ?? "";
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOCAL.has(name ?? "") && !req.headers.get("x-forwarded-for");
}

/** Throws 404 (not 403, so the route's existence is not revealed) unless dev routes are on and the request is local. */
export function assertDevRoute(req: Request): void {
  if (!getConfig().enableDevRoutes || !isLocalRequest(req)) throw new NotFoundError("Not found");
}

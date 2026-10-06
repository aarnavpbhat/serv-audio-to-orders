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
  return isLocalHeaders(req.headers);
}

/** Same check from request headers (server components get headers, not a Request). */
export function isLocalHeaders(headers: { get(name: string): string | null }): boolean {
  const host = headers.get("host") ?? "";
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOCAL.has(name ?? "") && loopbackOnly(headers.get("x-forwarded-for"));
}

/** A browser request from another site (or another origin) never reaches a dev route. */
function crossSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return !LOCAL.has(new URL(origin).hostname);
  } catch {
    return true;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Next.js sets x-forwarded-for to the socket address on every request, so the
 * header alone means nothing. Every hop must be loopback: a proxy in front of
 * the app adds the real client's address, which is refused.
 */
function loopbackOnly(xff: string | null): boolean {
  if (xff === null) return true;
  const hops = xff.split(",").map((h) => h.trim());
  return hops.length > 0 && hops.every((h) => LOOPBACK.has(h));
}

/** Throws 404 (not 403, so the route's existence is not revealed) unless dev routes are on and the request is local. */
export function assertDevRoute(req: Request): void {
  if (!getConfig().enableDevRoutes || !isLocalRequest(req) || crossSite(req)) throw new NotFoundError("Not found");
}

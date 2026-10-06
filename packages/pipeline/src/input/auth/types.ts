/**
 * Ingest authentication. TokenAuth is the only implementation for now; mutual
 * TLS, an IP allowlist or signed connect requests can implement the same
 * interface later without changes anywhere else.
 */

export interface IngestRequest {
  /** Client address as seen by the server. */
  ip: string;
  /** Lower-cased request headers. */
  headers: Record<string, string | string[] | undefined>;
  /** Parsed query string of the upgrade request. */
  query: URLSearchParams;
}

export type AuthResult =
  | { ok: true; storeId: string; allowedLanes: string[]; tokenId: string; /** Set when a dev ticket bound the lane. */ laneId?: string }
  | { ok: false; status: 401 | 429; reason: AuthFailure };

export type AuthFailure = "rate_limited" | "missing" | "malformed" | "unknown" | "wrong_secret" | "revoked" | "query_not_allowed" | "ticket_invalid" | "tickets_disabled";

export interface IngestAuth {
  authenticate(req: IngestRequest): AuthResult;
}

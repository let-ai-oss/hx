// Shape of the CCD sidebar group mirror the daemon uploads. Kept in hx-client
// (not imported from the app DB) so the daemon has no app-side dependency; the
// gateway's zod schema + Drizzle jsonb type (apps/workbench/.../hx-gateway.ts:
// HxCcdGroupMirrorBlob) must stay in sync with this.

export interface HxCcdGroup {
  /** CCD's group id (e.g. "cg-<uuid>"). */
  id: string;
  name: string;
  subtitle?: string | null;
  sectionName?: string | null;
  collapsed: boolean;
  /** Member sessions in CCD's order, as cli/jsonl sessionIds (what the workbench
   *  keys sessions by). Resolved from CCD's internal "local_<uuid>" ids; an id
   *  that couldn't be resolved keeps its "local_<uuid>" form as a fallback. */
  sessionIds: string[];
}

export interface HxCcdGroupMirrorBlob {
  groupingEnabled: boolean;
  groups: HxCcdGroup[];
  unreadIds: string[];
  note?: string | null;
  syncedAtMs?: number | null;
}

import { googleReadScopes } from "./rest.mjs";
import { googleWriteScopes } from "./write.mjs";

/** Google edit grants include reads, never the reverse or another service. */
export function hasGoogleScope(grants, requested) {
  if (grants.includes(requested)) return true;
  if (requested === googleReadScopes.docs) return grants.includes(googleWriteScopes.docs);
  if (requested === googleReadScopes.sheets) return grants.includes(googleWriteScopes.sheets);
  return false;
}

/**
 * Deleting a module is ambiguous once a repository holds several refs: the user
 * may mean "drop this one version" or "drop the whole repository". The scope is
 * therefore explicit in the request rather than inferred, so a mis-sent request
 * fails loudly instead of destroying more than intended.
 */
export type DeleteScope = "version" | "module";

export function parseScope(raw: string | null): DeleteScope | null {
  if (raw === "version" || raw === "module") return raw;
  // Missing scope defaults to the narrower, less destructive interpretation.
  if (raw === null || raw.trim() === "") return "version";
  return null;
}

-- Archived definitions reserve their stable ids, but should not reserve an
-- organisation within a scope. This lets an operator replace an archived
-- definition with a new id without deleting either configuration or imports.
DROP INDEX "public"."module_library_definitions_scope_org_key";

CREATE UNIQUE INDEX "module_library_definitions_active_scope_org_key"
ON "public"."module_library_definitions"("scope", lower("org"))
WHERE "active" = true;

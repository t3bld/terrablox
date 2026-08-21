-- Whether a resource block is created at all, and on what.
--
-- Reading HCL is not reading a plan: `count = var.create_x ? 1 : 0` is a resource
-- that exists in the code and usually not in the account. The architecture graph
-- infers "this subnet is public" from a route to an internet gateway, and with no
-- way to see that the route is conditional it stated as fact something that
-- depends on a variable nobody has set.
--
-- The expression is kept rather than a boolean so the UI can name the variable.
-- NULL means the block is always created; a literal `count = 2` is multiplicity
-- rather than a condition and is also stored as NULL.
--
-- Existing rows keep NULL until their module is re-imported, which is the correct
-- default: it reproduces exactly the behaviour they were analysed under.
ALTER TABLE "public"."provider_resources"
  ADD COLUMN "conditional_on" TEXT;

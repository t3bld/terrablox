import { notFound, redirect } from "next/navigation";

import { ModuleDetailView } from "@/components/module-detail/module-detail-view";
import type { ModuleDetailDto } from "@/components/module-detail/types";
import { getCurrentUserId } from "@/lib/auth/server-helpers";
import {
  loadModuleDetail,
  loadModuleParent,
} from "@/lib/modules/detail-service";

/**
 * Loads the module on the server.
 *
 * Fetching this in the browser meant waiting for the session to resolve before
 * the request could even start, then paying a round trip through the API for
 * data this process can read directly. `loading.tsx` now covers the real wait
 * rather than a second one that only began after hydration.
 */
export default async function ModuleDetailPage({
  params,
}: {
  params: { moduleId: string };
}) {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");

  const mod = await loadModuleDetail(userId, params.moduleId);
  if (!mod) notFound();

  const parentMod =
    mod.isSubmodule && mod.parentModuleId
      ? await loadModuleParent(userId, mod.parentModuleId)
      : null;

  return (
    <ModuleDetailView mod={mod as ModuleDetailDto} parentMod={parentMod} />
  );
}

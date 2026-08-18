import { PageSkeleton } from "@/components/layout/page-skeleton";
import { ModuleDetailSkeleton } from "@/components/module-detail/detail-skeleton";

/**
 * Shown while the detail route segment is still being fetched. Without it the
 * previous page stays frozen on screen for the whole navigation, which reads
 * as an unresponsive click.
 */
export default function ModuleDetailLoading() {
  return (
    <PageSkeleton
      breadcrumbs={[
        { label: "Modules", href: "/modules" },
        { label: "Module" },
      ]}
      loadingTitle
      mainClassName="p-4"
    >
      <ModuleDetailSkeleton />
    </PageSkeleton>
  );
}

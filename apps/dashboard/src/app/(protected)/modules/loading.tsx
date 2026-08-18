import { Skeleton } from "@terrablox/ui/skeleton";

import {
  CardGridSkeleton,
  PageSkeleton,
} from "@/components/layout/page-skeleton";

export default function ModulesLoading() {
  return (
    <PageSkeleton breadcrumbs={[{ label: "Modules" }]} mainClassName="p-4">
      <Skeleton className="h-10 w-full" />
      <CardGridSkeleton />
    </PageSkeleton>
  );
}

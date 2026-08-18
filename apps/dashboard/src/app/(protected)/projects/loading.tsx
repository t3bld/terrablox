import {
  CardGridSkeleton,
  PageSkeleton,
} from "@/components/layout/page-skeleton";

export default function ProjectsLoading() {
  return (
    <PageSkeleton breadcrumbs={[{ label: "Projects" }]}>
      <CardGridSkeleton count={3} />
    </PageSkeleton>
  );
}

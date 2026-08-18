import {
  PageSkeleton,
  SettingsSkeleton,
} from "@/components/layout/page-skeleton";

export default function CompanyLoading() {
  return (
    <PageSkeleton breadcrumbs={[{ label: "Company" }]}>
      <SettingsSkeleton />
    </PageSkeleton>
  );
}

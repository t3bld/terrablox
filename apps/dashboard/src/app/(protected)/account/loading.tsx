import {
  PageSkeleton,
  SettingsSkeleton,
} from "@/components/layout/page-skeleton";

export default function AccountLoading() {
  return (
    <PageSkeleton breadcrumbs={[{ label: "Account Settings" }]}>
      <SettingsSkeleton count={3} />
    </PageSkeleton>
  );
}

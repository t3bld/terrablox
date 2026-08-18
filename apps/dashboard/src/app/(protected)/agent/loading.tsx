import {
  PageSkeleton,
  SettingsSkeleton,
} from "@/components/layout/page-skeleton";

export default function AgentSettingsLoading() {
  return (
    <PageSkeleton breadcrumbs={[{ label: "Agent Settings" }]}>
      <SettingsSkeleton />
    </PageSkeleton>
  );
}

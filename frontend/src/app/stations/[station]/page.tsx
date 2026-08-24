// Deep-linkable command center for one station.
// params is a Promise in this Next.js version, so it is awaited here and the
// station key handed to the client dashboard.

import type { Metadata } from "next";

import StationDashboard from "@/components/StationDashboard";

export async function generateMetadata(
  props: PageProps<"/stations/[station]">,
): Promise<Metadata> {
  const { station } = await props.params;
  return {
    title: `${decodeURIComponent(station)} | AREE Command Center`,
  };
}

export default async function StationPage(props: PageProps<"/stations/[station]">) {
  const { station } = await props.params;
  return <StationDashboard station={decodeURIComponent(station)} />;
}

// Deep-linkable command center for one station.
// params is a Promise in this Next.js version, so it is awaited here and the
// station key handed to the client dashboard.

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import StationDashboard from "@/components/StationDashboard";
import { stationLabel } from "@/lib/station";

/** The station key from the URL, or null when the segment is not valid encoding. */
function decodeStation(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed escape ("%E0%A4") is not a station anybody could have linked to.
    return null;
  }
}

export async function generateMetadata(
  props: PageProps<"/stations/[station]">,
): Promise<Metadata> {
  const { station } = await props.params;
  const decoded = decodeStation(station);
  // The root layout's title template appends "· AREE".
  return decoded ? { title: `${stationLabel(decoded)} · Command Center` } : {};
}

export default async function StationPage(props: PageProps<"/stations/[station]">) {
  const { station } = await props.params;
  const decoded = decodeStation(station);
  if (decoded === null) notFound();
  // An unknown but well-formed key is handled client-side: the engine's 404 on the
  // station detail request renders a single "Station not found" state.
  return <StationDashboard station={decoded} />;
}

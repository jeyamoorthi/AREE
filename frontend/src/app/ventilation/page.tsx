/**
 * The Ventilation Outlook is now the Diagnostics tab of /outlook.
 *
 * The route is kept rather than deleted: it has been the dispersion diagnostic's
 * address for the whole life of the project, it is linked from written material and
 * it is the sort of page an operator bookmarks. A 404 would be a worse answer than
 * the content itself, which still exists — one tab across.
 *
 * `at` is carried through so a replay link survives the move, and `tab` lands the
 * visitor on the view they actually asked for instead of the other one.
 */

import { redirect } from "next/navigation";

export default async function VentilationPage(
  props: PageProps<"/ventilation">,
) {
  const params = await props.searchParams;
  const at = params?.at;
  const query = new URLSearchParams({ tab: "diagnostics" });
  if (typeof at === "string" && at) query.set("at", at);
  redirect(`/outlook?${query.toString()}`);
}

import VentilationOutlook from "@/components/VentilationOutlook";

export const metadata = {
  title: "Ventilation outlook — AREE",
  description:
    "72-hour ventilation forecast and the remaining intervention window for Delhi NCR.",
};

export default function VentilationPage() {
  return <VentilationOutlook />;
}

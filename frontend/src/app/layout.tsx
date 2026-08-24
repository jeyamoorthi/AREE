import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import AppShell from "@/components/AppShell";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800", "900"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "AREE | Autonomous Regulatory Escalation Engine",
  description:
    "Autonomous Regulatory Escalation Engine — environmental intelligence platform. " +
    "Pathway streaming, satellite intelligence and policy-grounded regulatory advisories.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="bg-aree-bg text-aree-body flex min-h-full flex-col">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

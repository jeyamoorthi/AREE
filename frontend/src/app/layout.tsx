import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import AppShell from "@/components/AppShell";
import { THEME_STORAGE_KEY } from "@/lib/themeMode";
import "./globals.css";

/**
 * Runs synchronously, before the browser paints anything, so a dark-mode operator
 * never gets a white frame on a full document load. ThemeProvider adopts whatever
 * this decided rather than deciding again — see the note in that file.
 *
 * It is wrapped in try/catch because localStorage THROWS in some contexts rather
 * than returning null, and a theme preference is not worth a blank page.
 */
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="dark"){document.documentElement.setAttribute("data-theme","dark");}}catch(e){}})();`;

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
  applicationName: "AREE",
  // The tab icon comes from app/icon.png via the file convention — declaring
  // `icons` here would replace it, so it is deliberately absent.
  openGraph: {
    type: "website",
    siteName: "AREE",
    title: "AREE — Environmental Intelligence",
    description:
      "Autonomous Regulatory Escalation Engine — environmental intelligence platform.",
    images: [{ url: "/aree-mark.png", width: 1040, height: 706, alt: "AREE" }],
  },
};

/**
 * Mobile viewport and browser chrome.
 *
 * `width=device-width, initial-scale=1` is Next's default and is restated here only
 * because this export also carries the two things that are not defaults:
 *
 *   themeColor — the colour a phone paints its own status and address bars. Two
 *   entries, matched to --aree-bg in each palette, so the chrome above the page is
 *   the same surface as the page rather than a white strip over a dark command
 *   center. The values are literals because a media query cannot read a custom
 *   property; they must be kept in step with --aree-bg in globals.css.
 *
 *   The page is deliberately NOT zoom-locked. `maximum-scale=1` / `user-scalable=no`
 *   is the usual line here and it is an accessibility failure: this application
 *   prints 10px uppercase labels, and pinch-zoom is how a reader who needs them
 *   larger gets them larger.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f4ed" },
    { media: "(prefers-color-scheme: dark)", color: "#100f0c" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="bg-aree-bg text-aree-body flex min-h-full flex-col">
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

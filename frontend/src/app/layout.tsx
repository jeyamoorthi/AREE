import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import AppShell from "@/components/AppShell";
import { THEME_CHROME_COLORS, THEME_STORAGE_KEY } from "@/lib/themeMode";
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
)});if(t==="dark"){document.documentElement.setAttribute("data-theme","dark");var m=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++){m[i].setAttribute("content",${JSON.stringify(
  THEME_CHROME_COLORS.dark,
)});}}}catch(e){}})();`;

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

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000";

const DESCRIPTION =
  "Autonomous Regulatory Escalation Engine for Delhi NCR — real-time air-quality and " +
  "ventilation risk, deterministic GRAP escalation, human-authorised decisions.";

export const metadata: Metadata = {
  // Resolves the relative Open Graph image; without it Next warns at build time.
  metadataBase: new URL(SITE_URL),
  // Pages set a short title ("Outlook", "Reports") and inherit the suffix.
  title: {
    default: "AREE — Autonomous Regulatory Escalation Engine",
    template: "%s · AREE",
  },
  description: DESCRIPTION,
  applicationName: "AREE",
  // The tab icon comes from app/icon.png via the file convention — declaring
  // `icons` here would replace it, so it is deliberately absent.
  openGraph: {
    type: "website",
    siteName: "AREE",
    title: "AREE — Autonomous Regulatory Escalation Engine",
    description: DESCRIPTION,
    images: [{ url: "/aree-mark.png", width: 1040, height: 706, alt: "AREE" }],
  },
};

/**
 * Mobile viewport and browser chrome.
 *
 * `width=device-width, initial-scale=1` is Next's default and is restated here only
 * because this export also carries the two things that are not defaults:
 *
 *   themeColor — the colour a phone paints its own status and address bars. ONE
 *   entry, the light --aree-bg, because the application defaults to light whatever
 *   the OS prefers; keying it to prefers-color-scheme painted a black status bar
 *   over a light page. The bootstrap script below and AppShell repoint it at the
 *   dark value when the dark theme is actually in force.
 *
 *   The page is deliberately NOT zoom-locked. `maximum-scale=1` / `user-scalable=no`
 *   is the usual line here and it is an accessibility failure: this application
 *   prints 10px uppercase labels, and pinch-zoom is how a reader who needs them
 *   larger gets them larger.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: THEME_CHROME_COLORS.light,
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

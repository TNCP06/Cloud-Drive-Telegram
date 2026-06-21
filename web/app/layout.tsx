import type { Metadata } from "next";
import { Hanken_Grotesk, Instrument_Serif } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import { UploadProvider } from "@/components/UploadProvider";
import { FloatingUploadPanel } from "@/components/FloatingUploadPanel";

const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-hanken",
});

const instrument = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument",
});

export const metadata: Metadata = {
  title: "Vault — Telegram Cloud Drive",
  description: "Personal cloud drive dengan Telegram sebagai storage.",
};

// Applied before first paint to avoid a light→dark flash: use the saved choice,
// else fall back to the OS color-scheme preference.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('tcd_theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" className={`${hanken.variable} ${instrument.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <ServiceWorkerRegister />
        <UploadProvider>
          {children}
          <FloatingUploadPanel />
        </UploadProvider>
      </body>
    </html>
  );
}


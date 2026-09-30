import "uplot/dist/uPlot.min.css";
import "../styles/tokens.css";
import "../styles/ui.css";
import "../styles/shell.css";
import "../styles/pages.css";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata = {
  title: "Tenant Pulse",
  description: "Local multi-tenant API performance testing",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

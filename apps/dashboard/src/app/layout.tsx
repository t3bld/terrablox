import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "../styles/globals.css";
// React Flow ships its own stylesheet; without it the graph renders unstyled.
import "@terrablox/graph/styles.css";
import { NavigationProgress } from "@terrablox/ui/navigation-progress";
import { Providers } from "./providers";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Dashboard - Terrablox",
  description: "Terrablox Dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <Providers>
          <NavigationProgress />
          {children}
        </Providers>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Space_Grotesk, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

const body = Hanken_Grotesk({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

const siteTagline = "Remote OMP — Your coding agents, in your pocket";
const siteDescription =
  "Pair your phone once, then drive any omp coding agent from it — keep a fleet running 24/7 and link every machine into one mesh. Open source, self-hostable.";

export const metadata: Metadata = {
  metadataBase: new URL("https://remote-pi.jacobmoura.work"),
  title: {
    default: siteTagline,
    template: "%s · Remote OMP",
  },
  description: siteDescription,
  applicationName: "Remote OMP",
  authors: [{ name: "Flutterando", url: "https://flutterando.com.br" }],
  keywords: [
    "Remote OMP",
    "coding agents",
    "omp coding agent",
    "mobile agent control",
    "24/7 agent daemon",
    "agent mesh",
    "self-hostable relay",
  ],
  openGraph: {
    type: "website",
    url: "https://remote-pi.jacobmoura.work",
    title: siteTagline,
    description: siteDescription,
    siteName: "Remote OMP",
  },
  twitter: {
    card: "summary_large_image",
    title: siteTagline,
    description: siteDescription,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-bg text-fg">
        <main className="flex-1 flex flex-col min-h-screen">{children}</main>
      </body>
    </html>
  );
}

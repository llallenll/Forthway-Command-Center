import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Forthway starter",
  description: "A Next.js and TypeScript starter, deployed by the Forthway Command Center.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}

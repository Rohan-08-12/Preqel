import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Preqel",
  description: "Hiring-signal intelligence built from Canadian public regulatory data.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900">{children}</body>
    </html>
  );
}

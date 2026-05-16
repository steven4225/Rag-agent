import type { Metadata } from "next";
import { Suspense } from "react";

import "@/app/globals.css";

export const metadata: Metadata = {
  title: "Ragent Web",
  description: "TS-first agent platform shell for the Ragent reconstruction."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen text-slate-950 antialiased">
        <Suspense fallback={<div className="p-6 text-sm text-slate-500">Loading shell...</div>}>
          {children}
        </Suspense>
      </body>
    </html>
  );
}

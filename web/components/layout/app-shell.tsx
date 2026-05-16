"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { getRouteMeta } from "@/lib/navigation";

export function AppShell({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const routeMeta = getRouteMeta(pathname);
  const currentTitle = routeMeta?.title ?? title;
  const currentDescription = routeMeta?.description ?? description;

  const navItems = [
    { href: "/chat", label: "Chat" },
    { href: "/admin/dashboard", label: "Admin" },
    { href: "/login", label: "Login" }
  ];

  return (
    <main className="min-h-screen px-6 py-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl items-center justify-between rounded-3xl border border-slate-200/70 bg-white/80 px-5 py-4 shadow-sm backdrop-blur">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-700">Ragent Web</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">{currentTitle}</h1>
          <p className="mt-1 text-sm text-slate-500">{currentDescription}</p>
        </div>
        <nav className="flex items-center gap-3 text-sm text-slate-600">
          {navItems.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

            return (
              <Link
                key={item.href}
                className={[
                  "rounded-full px-4 py-2 transition",
                  active ? "bg-teal-700 text-white" : "hover:bg-slate-100"
                ].join(" ")}
                href={item.href}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="mx-auto mt-6 max-w-7xl">{children}</div>
    </main>
  );
}

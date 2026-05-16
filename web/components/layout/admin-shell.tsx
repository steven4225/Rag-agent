"use client";

import type { ComponentType, ReactNode } from "react";
import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Database,
  GitBranch,
  LayoutDashboard,
  Menu,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  Waypoints,
  Workflow,
  Wrench
} from "lucide-react";

import type { OrgScopedSessionUser } from "@/lib/auth/session";
import { adminNavGroups, getRouteMeta } from "@/lib/navigation";

const iconMap: Record<string, ComponentType<{ className?: string }>> = {
  "/admin/dashboard": LayoutDashboard,
  "/admin/knowledge": Database,
  "/admin/intent-tree": GitBranch,
  "/admin/intent-list": BookOpen,
  "/admin/ingestion": Wrench,
  "/admin/traces": Workflow,
  "/admin/mappings": Waypoints,
  "/admin/sample-questions": Sparkles,
  "/admin/settings": Settings,
  "/admin/users": Users
};

export function AdminShell({
  children,
  user
}: {
  children: ReactNode;
  user: OrgScopedSessionUser;
}) {
  const pathname = usePathname();
  const routeMeta = getRouteMeta(pathname);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const breadcrumbs = useMemo(() => {
    const segments = pathname.split("/").filter(Boolean);
    const items: { label: string; href?: string }[] = [
      { label: "Admin", href: "/admin/dashboard" }
    ];

    if (segments[0] !== "admin") {
      return items;
    }

    if (segments[1]) {
      items.push({
        label: routeMeta?.title ?? segments[1],
        href: segments.length > 2 ? `/admin/${segments[1]}` : undefined
      });
    }

    if (segments[1] === "knowledge" && segments[2]) {
      items.push({ label: segments[2] });
      if (segments[3] === "docs" && segments[4]) {
        items.push({ label: segments[4] });
      }
    }

    if (segments[1] === "traces" && segments[2]) {
      items.push({ label: decodeURIComponent(segments[2]) });
    }

    return items;
  }, [pathname, routeMeta?.title]);

  return (
    <div className="flex min-h-screen bg-[#f4f7fb] text-slate-900">
      <div
        className={[
          "fixed inset-0 z-30 bg-slate-950/30 backdrop-blur-sm transition lg:hidden",
          sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
        ].join(" ")}
        onClick={() => setSidebarOpen(false)}
      />

      <aside
        className={[
          "fixed left-0 top-0 z-40 flex h-screen w-[272px] flex-col bg-[linear-gradient(180deg,#182033_0%,#1f2937_48%,#243046_100%)] text-white/72 transition-transform lg:static lg:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        ].join(" ")}
      >
        <div className="border-b border-white/10 px-5 pb-5 pt-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-[0_14px_30px_rgba(37,99,235,0.35)]">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Ragent Admin</p>
              <p className="text-xs text-white/50">Knowledge Console</p>
            </div>
          </div>
          <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-3">
            <p className="text-sm font-medium text-white">{user.name}</p>
            <p className="mt-1 text-xs text-white/50">{user.userId}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.18em] text-white/55">
              <span className="rounded-full border border-white/10 bg-white/8 px-2.5 py-1">{user.role}</span>
              <span className="rounded-full border border-white/10 bg-white/8 px-2.5 py-1">{user.tenantId}</span>
            </div>
          </div>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          {adminNavGroups.map((group) => (
            <section key={group.title} className="mb-5">
              <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.24em] text-white/35">{group.title}</p>
              <div className="mt-2 space-y-1">
                {group.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const Icon = iconMap[item.href] ?? Sparkles;

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setSidebarOpen(false)}
                      className={[
                        "group relative block rounded-2xl px-3 py-3 transition",
                        active ? "bg-blue-500/18 text-white" : "hover:bg-white/8 hover:text-white"
                      ].join(" ")}
                    >
                      <div
                        className={[
                          "absolute inset-y-3 left-0 w-1 rounded-full transition",
                          active ? "bg-blue-400" : "bg-transparent"
                        ].join(" ")}
                      />
                      <div className="flex items-start gap-3">
                        <span
                          className={[
                            "mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-xl border text-sm",
                            active
                              ? "border-blue-400/30 bg-blue-400/16 text-blue-200"
                              : "border-white/10 bg-white/5 text-white/55 group-hover:text-white/80"
                          ].join(" ")}
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{item.label}</p>
                          <p className={["mt-1 text-xs leading-5", active ? "text-blue-100/75" : "text-white/40"].join(" ")}>
                            {item.description}
                          </p>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </nav>

        <div className="border-t border-white/10 px-4 py-4">
          <Link
            href="/chat"
            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/6 px-4 py-3 text-sm text-white/78 transition hover:bg-white/10 hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to chat
          </Link>
        </div>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/88 backdrop-blur">
          <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 lg:hidden"
                onClick={() => setSidebarOpen((current) => !current)}
                aria-label="Toggle sidebar"
              >
                <Menu className="h-4 w-4" />
              </button>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Control Plane</p>
                <h1 className="truncate text-base font-semibold text-slate-900 sm:text-lg">
                  {routeMeta?.title ?? "Admin"}
                </h1>
              </div>
            </div>
            <div className="hidden items-center gap-2 md:flex">
              <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-500">
                Org {user.orgId}
              </div>
              <div className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600">
                Next.js App Router preserved
              </div>
            </div>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6">
          <div className="mx-auto flex min-h-full max-w-[1400px] flex-col gap-5">
            <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
              {breadcrumbs.map((item, index) => {
                const isLast = index === breadcrumbs.length - 1;

                return (
                  <div key={`${item.label}-${index}`} className="flex items-center gap-2">
                    {item.href && !isLast ? (
                      <Link href={item.href} className="transition hover:text-slate-700">
                        {item.label}
                      </Link>
                    ) : (
                      <span className={isLast ? "font-medium text-slate-700" : undefined}>{item.label}</span>
                    )}
                    {!isLast ? <ChevronRight className="h-4 w-4 text-slate-300" /> : null}
                  </div>
                );
              })}
            </nav>

            {routeMeta ? (
              <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_18px_45px_rgba(15,23,42,0.08)]">
                <div className="border-b border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] px-5 py-5 sm:px-6">
                  <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div className="max-w-3xl">
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-blue-700">Phase 3 Admin Console</p>
                      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{routeMeta.title}</h2>
                      <p className="mt-2 text-sm leading-6 text-slate-500">{routeMeta.description}</p>
                    </div>
                  </div>
                </div>
                <div className="px-5 py-5 sm:px-6">{children}</div>
              </section>
            ) : (
              children
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

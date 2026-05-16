"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Building2, LockKeyhole, ShieldCheck, Sparkles, UserCircle2 } from "lucide-react";

type LoginState = "idle" | "loading" | "error";
type SessionRole = "user" | "admin";
type SessionUser = {
  userId: string;
  role: SessionRole;
  name: string;
  orgId?: string | null;
  tenantId?: string | null;
};

type SessionBootstrap = {
  mode?: "oidc" | "mock";
  oidcEnabled?: boolean;
  oidcLoginPath?: string | null;
  mockFallbackEnabled?: boolean;
  user?: SessionUser | null;
  users?: SessionUser[];
};

async function createMockSession(role: SessionRole, userId?: string) {
  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      role,
      userId: userId?.trim() || undefined
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`);
  }
}

export default function LoginPage() {
  const [state, setState] = useState<LoginState>("idle");
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [oidcLoginPath, setOidcLoginPath] = useState<string>("/api/auth/oidc/login");
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [mockFallbackEnabled, setMockFallbackEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadUsers() {
      const response = await fetch("/api/auth/session");
      const body = (await response.json().catch(() => ({}))) as SessionBootstrap;
      if (cancelled) return;
      setUsers(Array.isArray(body.users) ? body.users : []);
      setOidcEnabled(body.oidcEnabled === true);
      setMockFallbackEnabled(body.mockFallbackEnabled === true);
      setOidcLoginPath(body.oidcLoginPath || "/api/auth/oidc/login");
    }

    void loadUsers();

    return () => {
      cancelled = true;
    };
  }, []);

  const adminUsers = users.filter((item) => item.role === "admin");
  const normalUsers = users.filter((item) => item.role === "user");

  async function handleSignIn(role: SessionRole, userId?: string) {
    try {
      setState("loading");
      await createMockSession(role, userId);
      window.location.href = role === "admin" ? "/admin/dashboard" : "/chat";
    } catch {
      setState("error");
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#f5f7fb]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.16),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(14,165,233,0.14),_transparent_24%)]" />
      <div className="relative mx-auto flex min-h-screen max-w-7xl items-center px-4 py-10 sm:px-6 lg:px-8">
        <section className="grid w-full overflow-hidden rounded-[28px] border border-slate-200/80 bg-white shadow-[0_28px_80px_rgba(15,23,42,0.12)] lg:grid-cols-[minmax(0,1.05fr)_460px]">
          <article className="hidden bg-[linear-gradient(160deg,#0f172a_0%,#1e293b_42%,#1d4ed8_100%)] p-10 text-white lg:flex lg:flex-col">
            <div className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-white/12">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="mt-10 max-w-xl">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-sky-200">Ragent AI</p>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight">A cleaner entry into the current control plane.</h1>
              <p className="mt-4 text-sm leading-7 text-slate-200">
                This UI transplant keeps the current Next.js auth and API flow intact, while bringing over the more mature framing from the legacy frontend.
              </p>
            </div>
            <div className="mt-10 grid gap-4">
              <div className="rounded-2xl border border-white/10 bg-white/8 p-4 backdrop-blur-sm">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 text-sky-200" />
                  <div>
                    <p className="text-sm font-medium">Current auth path stays untouched</p>
                    <p className="mt-1 text-sm text-slate-200">OIDC, mock fallback, tenant scope, and admin scope still come from the existing `web/` session control plane.</p>
                  </div>
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/8 p-4 backdrop-blur-sm">
                <div className="flex items-start gap-3">
                  <Building2 className="mt-0.5 h-5 w-5 text-sky-200" />
                  <div>
                    <p className="text-sm font-medium">Two workspaces, one contract</p>
                    <p className="mt-1 text-sm text-slate-200">Users land in chat, admins unlock the knowledge, ingestion, mapping, trace, and settings workspace.</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-auto flex items-center justify-between rounded-2xl border border-white/10 bg-white/8 px-4 py-3 text-sm text-slate-200">
              <span>TS-first control plane</span>
              <span>Next.js App Router</span>
            </div>
          </article>

          <article className="p-6 sm:p-8 lg:p-10">
            <div className="mx-auto flex max-w-md flex-col">
              <div className="inline-flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-[0_14px_28px_rgba(37,99,235,0.28)]">
                  <LockKeyhole className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-blue-700">Secure Access</p>
                  <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">Sign in to Ragent Web</h2>
                </div>
              </div>

              <p className="mt-4 text-sm leading-6 text-slate-500">
                Continue with your configured identity provider, or use the existing mock fallback when this environment allows it.
              </p>

              <div className="mt-8 rounded-[24px] border border-slate-200 bg-slate-50/80 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                {oidcEnabled ? (
                  <a
                    href={oidcLoginPath}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-950 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
                  >
                    Continue with SSO
                    <ArrowRight className="h-4 w-4" />
                  </a>
                ) : (
                  <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                    OIDC is not enabled in the current environment configuration.
                  </p>
                )}

                {mockFallbackEnabled ? (
                  <div className="mt-4 grid gap-3">
                    <button
                      type="button"
                      onClick={() => void handleSignIn("user")}
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-medium text-slate-800 transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60"
                      disabled={state === "loading"}
                    >
                      Continue as user
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSignIn("admin")}
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-medium text-slate-800 transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60"
                      disabled={state === "loading"}
                    >
                      Continue as admin
                    </button>
                  </div>
                ) : null}

                {state === "error" ? (
                  <p className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                    Failed to create fallback session.
                  </p>
                ) : null}
              </div>

              {mockFallbackEnabled && users.length > 0 ? (
                <div className="mt-8">
                  <div className="flex items-center gap-2">
                    <UserCircle2 className="h-4 w-4 text-slate-400" />
                    <p className="text-sm font-medium text-slate-700">Mock users</p>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    These keep session bootstrap aligned with the current admin user repository.
                  </p>
                  <div className="mt-4 space-y-2">
                    {[...normalUsers, ...adminUsers].map((item) => (
                      <button
                        key={item.userId}
                        type="button"
                        onClick={() => void handleSignIn(item.role, item.userId)}
                        disabled={state === "loading"}
                        className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-blue-200 hover:bg-blue-50/50 disabled:opacity-60"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-slate-900">{item.name}</p>
                            <p className="mt-1 text-xs text-slate-500">
                              {item.userId} / tenant {item.tenantId ?? "null"} / org {item.orgId ?? "null"}
                            </p>
                          </div>
                          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">
                            {item.role}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}

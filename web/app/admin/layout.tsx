import { AdminShell } from "@/components/layout/admin-shell";
import { requireAdmin, requireOrgScope, requireTenantScope } from "@/lib/auth/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = requireOrgScope(requireTenantScope(await requireAdmin()));

  return <AdminShell user={admin}>{children}</AdminShell>;
}

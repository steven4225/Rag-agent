import type { MCPToolExecutionContext, MCPToolGuardResult } from "@/lib/mcp/types";

function allow(): MCPToolGuardResult {
  return { ok: true };
}

function deny(reason: string): MCPToolGuardResult {
  return { ok: false, reason };
}

export function allowSignedIn(context: MCPToolExecutionContext): MCPToolGuardResult {
  if (!context.actor.userId) return deny("user identity is required");
  return context.actor.tenantId ? allow() : deny("tenant scope is required");
}

export function allowTenantScope(context: MCPToolExecutionContext): MCPToolGuardResult {
  return context.actor.tenantId ? allow() : deny("tenant scope is required");
}

export function allowOrgScope(context: MCPToolExecutionContext): MCPToolGuardResult {
  return context.actor.orgId ? allow() : deny("org scope is required");
}

export function allowAdminOnly(context: MCPToolExecutionContext): MCPToolGuardResult {
  if (context.actor.role !== "admin") {
    return deny("admin role required");
  }
  return allow();
}

export function allowAdminWithScope(context: MCPToolExecutionContext): MCPToolGuardResult {
  const admin = allowAdminOnly(context);
  if (!admin.ok) return admin;
  const tenant = allowTenantScope(context);
  if (!tenant.ok) return tenant;
  const org = allowOrgScope(context);
  if (!org.ok) return org;
  return allow();
}

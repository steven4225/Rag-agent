export type AdminNavItem = {
  href: string;
  label: string;
  description: string;
};

export type AdminNavGroup = {
  title: string;
  items: AdminNavItem[];
};

export const adminNavGroups: AdminNavGroup[] = [
  {
    title: "Core",
    items: [
      { href: "/admin/dashboard", label: "Dashboard", description: "Platform metrics, pipeline health, and ingestion stats." },
      { href: "/admin/knowledge", label: "Knowledge", description: "Knowledge bases, documents, and chunk drill-down." },
      { href: "/admin/intent-tree", label: "Intent Tree", description: "Hierarchical agent routing intent visualization." },
      { href: "/admin/intent-list", label: "Intent List", description: "CRUD management for agent routing intents." },
      { href: "/admin/ingestion", label: "Ingestion", description: "Upload entrypoint and task-state pipeline tracking." },
      { href: "/admin/traces", label: "Traces", description: "Trace execution records with filtering and timeline view." }
    ]
  },
  {
    title: "Configuration",
    items: [
      { href: "/admin/mappings", label: "Mappings", description: "Query-term rewrite and retrieval rule management." },
      { href: "/admin/sample-questions", label: "Sample Questions", description: "Curated prompt starters for chat onboarding." },
      { href: "/admin/settings", label: "Settings", description: "Model and runtime configuration management." },
      { href: "/admin/users", label: "Users", description: "User and role administration." }
    ]
  }
];

type RouteMeta = {
  title: string;
  description: string;
};

const routeMeta: Record<string, RouteMeta> = {
  "/chat": {
    title: "Chat Workspace",
    description: "Agent-facing chat shell with session rail, orchestration rail, and conversation panel."
  },
  "/login": {
    title: "Login",
    description: "Authentication entry shell for the TS-hosted control plane."
  },
  "/admin/dashboard": {
    title: "Admin Dashboard",
    description: "Platform overview with traffic, pipeline, knowledge, and ingestion health metrics."
  },
  "/admin/knowledge": {
    title: "Knowledge Management",
    description: "Knowledge base CRUD, document listing, and chunk detail drill-down."
  },
  "/admin/intent-tree": {
    title: "Intent Tree",
    description: "Hierarchical visualization of agent routing intents and their relationships."
  },
  "/admin/intent-list": {
    title: "Intent List",
    description: "CRUD management for intent nodes with parent, route, and priority configuration."
  },
  "/admin/ingestion": {
    title: "Ingestion",
    description: "Task creation, pipeline stage tracking, and execution status visibility."
  },
  "/admin/traces": {
    title: "Traces",
    description: "Trace execution records with client-side filtering, pagination, and timeline detail."
  },
  "/admin/mappings": {
    title: "Mappings",
    description: "Query-term rewrite rules for retrieval augmentation."
  },
  "/admin/sample-questions": {
    title: "Sample Questions",
    description: "Curated prompt starters for chat workspace onboarding."
  },
  "/admin/settings": {
    title: "Settings",
    description: "Model and runtime setting management for the control plane."
  },
  "/admin/users": {
    title: "Users",
    description: "User and role administration with tenant and org scoping."
  }
};

export function getRouteMeta(pathname: string): RouteMeta | undefined {
  const direct = routeMeta[pathname];
  if (direct) return direct;

  if (pathname.startsWith("/admin/knowledge/")) {
    if (pathname.includes("/docs/")) {
      return {
        title: "Knowledge Chunks",
        description: "Document chunk visibility with metadata, offsets, and indexing markers."
      };
    }

    return {
      title: "Knowledge Documents",
      description: "Knowledge-base scoped document list with parser/indexing status and chunk counts."
    };
  }

  if (pathname.startsWith("/admin/traces/")) {
    return {
      title: "Trace Detail",
      description: "Per-trace lifecycle placeholder for chat, retrieval, and ingestion stages."
    };
  }

  if (pathname.startsWith("/admin/intent-list/")) {
    return {
      title: "Intent Edit",
      description: "Intent node editing with parent, route expression, and priority configuration."
    };
  }

  if (pathname.startsWith("/chat/")) {
    return {
      title: "Chat Session",
      description: "Session-scoped chat shell route."
    };
  }

  return undefined;
}

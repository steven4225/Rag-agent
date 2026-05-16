"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, Circle, GitBranch, Layers3, Search } from "lucide-react";

import { ReadModelState } from "@/components/common/read-model-state";
import { getIntentReadModel } from "@/lib/client/web-api";
import { useApiResource } from "@/lib/client/use-api-resource";
import type { IntentReadModel } from "@/lib/contracts";

interface IntentNode extends IntentReadModel {
  children: IntentNode[];
  depth: number;
}

function buildTree(items: IntentReadModel[]): IntentNode[] {
  const map = new Map<string, IntentNode>();
  const roots: IntentNode[] = [];

  for (const item of items) {
    map.set(item.intentId, { ...item, children: [], depth: 0 });
  }

  for (const node of map.values()) {
    if (node.parentIntentId && map.has(node.parentIntentId)) {
      map.get(node.parentIntentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  function assignDepth(nodes: IntentNode[], depth: number) {
    for (const node of nodes) {
      node.depth = depth;
      assignDepth(node.children, depth + 1);
    }
  }
  assignDepth(roots, 0);

  function sortByPriority(nodes: IntentNode[]) {
    nodes.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    for (const node of nodes) sortByPriority(node.children);
  }
  sortByPriority(roots);

  return roots;
}

function TreeNode({ node }: { node: IntentNode }) {
  const hasChildren = node.children.length > 0;
  const childCount = node.children.length;

  return (
    <div className="ml-0">
      <div
        className={[
          "group relative rounded-2xl border bg-white p-4 shadow-sm transition",
          node.enabled
            ? "border-slate-200 hover:border-blue-200"
            : "border-dashed border-slate-200 opacity-60"
        ].join(" ")}
        style={{ marginLeft: `${node.depth * 2}rem` }}
      >
        {/* Connector line to parent */}
        {node.depth > 0 ? (
          <div className="absolute -left-8 top-1/2 h-0.5 w-8 bg-slate-200" />
        ) : null}

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs text-slate-500">{node.intentId}</span>
              <span
                className={[
                  "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                  node.enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
                ].join(" ")}
              >
                {node.enabled ? "Active" : "Disabled"}
              </span>
              {node.routeExpression ? (
                <span className="rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-mono text-purple-700">
                  {node.routeExpression}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm font-semibold text-slate-900">{node.name}</p>
            {node.description ? (
              <p className="mt-0.5 text-xs text-slate-500">{node.description}</p>
            ) : null}
            <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-400">
              <span>priority {node.priority}</span>
              {node.knowledgeBaseIds.length > 0 ? (
                <span>kbs: {node.knowledgeBaseIds.join(", ")}</span>
              ) : null}
              {hasChildren ? (
                <span className="inline-flex items-center gap-1">
                  <GitBranch className="h-3 w-3" />
                  {childCount} child{childCount !== 1 ? "ren" : ""}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Circle className="h-2 w-2" />
                  leaf
                </span>
              )}
            </div>
          </div>
          <Link
            href="/admin/intent-list"
            className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            Manage
          </Link>
        </div>
      </div>

      {hasChildren ? (
        <div className="relative" style={{ marginLeft: `${node.depth * 2}rem` }}>
          {node.children.map((child) => (
            <TreeNode key={child.intentId} node={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function IntentTreePage() {
  const { data, status, error, reload } = useApiResource(getIntentReadModel);
  const items = data?.items ?? [];
  const tree = useMemo(() => buildTree(items), [items]);

  const rootCount = tree.length;
  const totalNodes = items.length;
  const activeCount = items.filter((i) => i.enabled).length;
  const maxDepth = useMemo(() => {
    let max = 0;
    function walk(nodes: IntentNode[], depth: number) {
      if (depth > max) max = depth;
      for (const n of nodes) walk(n.children, depth + 1);
    }
    walk(tree, 0);
    return max;
  }, [tree]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Intent Tree</h3>
          <p className="mt-1 text-sm text-slate-500">Hierarchical view of agent routing intents and their relationships.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/intent-list"
            className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            List View
          </Link>
          <button
            type="button"
            onClick={() => void reload()}
            className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { label: "Total Intents", value: totalNodes, icon: Layers3, tone: "bg-blue-50 text-blue-600" },
          { label: "Root Nodes", value: rootCount, icon: GitBranch, tone: "bg-violet-50 text-violet-600" },
          { label: "Active", value: activeCount, icon: Search, tone: "bg-emerald-50 text-emerald-600" },
          { label: "Max Depth", value: maxDepth, icon: ArrowDown, tone: "bg-amber-50 text-amber-600" }
        ].map((card) => {
          const Icon = card.icon;
          return (
            <article key={card.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{card.label}</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-950">{card.value}</p>
                </div>
                <span className={["inline-flex h-10 w-10 items-center justify-center rounded-xl", card.tone].join(" ")}>
                  <Icon className="h-5 w-5" />
                </span>
              </div>
            </article>
          );
        })}
      </div>

      <ReadModelState status={status} error={error} empty={items.length === 0}>
        <div className="rounded-3xl border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-6">
          <div className="space-y-0">
            {tree.map((root) => (
              <TreeNode key={root.intentId} node={root} />
            ))}
          </div>
        </div>
      </ReadModelState>
    </section>
  );
}

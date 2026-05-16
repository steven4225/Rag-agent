export function ReadModelState({
  status,
  error,
  empty,
  children
}: {
  status: "idle" | "loading" | "success" | "error";
  error: string | null;
  empty: boolean;
  children: React.ReactNode;
}) {
  if (status === "loading" && empty) {
    return <p className="text-sm text-slate-500">Loading data...</p>;
  }

  if (status === "error") {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
        {error ?? "Request failed."}
      </div>
    );
  }

  if (status === "success" && empty) {
    return <p className="text-sm text-slate-500">No data available yet.</p>;
  }

  return <>{children}</>;
}

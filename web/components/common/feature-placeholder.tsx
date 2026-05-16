export function FeaturePlaceholder({
  title,
  summary,
  bullets
}: {
  title: string;
  summary: string;
  bullets: string[];
}) {
  return (
    <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50/80 p-6">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{summary}</p>
      <ul className="mt-5 grid gap-3 sm:grid-cols-2">
        {bullets.map((bullet) => (
          <li key={bullet} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
            {bullet}
          </li>
        ))}
      </ul>
    </div>
  );
}

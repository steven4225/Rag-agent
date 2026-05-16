import * as React from "react";

interface AvatarProps {
  name: string;
  src?: string;
  className?: string;
}

export function Avatar({ name, src, className }: AvatarProps) {
  const fallback = React.useMemo(() => {
    if (!name) return "?";
    const parts = name.trim().split(" ");
    const letters = parts.map((part) => part[0]).join("");
    return letters.slice(0, 2).toUpperCase();
  }, [name]);

  return (
    <span
      className={[
        "inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-xs font-semibold text-slate-500",
        className ?? "",
      ].join(" ")}
      title={name}
    >
      {src ? (
        <img
          src={src}
          alt={name}
          className="h-full w-full rounded-full object-cover"
        />
      ) : (
        <span className="select-none">{fallback}</span>
      )}
    </span>
  );
}

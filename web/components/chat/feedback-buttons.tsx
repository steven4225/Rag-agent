"use client";

import { useState } from "react";
import { Check, Copy, ThumbsDown, ThumbsUp } from "lucide-react";

type FeedbackValue = "like" | "dislike" | null;

interface FeedbackButtonsProps {
  messageId: string;
  feedback?: FeedbackValue;
  content: string;
  className?: string;
  alwaysVisible?: boolean;
  onFeedback?: (messageId: string, value: FeedbackValue) => void;
}

export function FeedbackButtons({
  messageId,
  feedback = null,
  content,
  className,
  alwaysVisible,
  onFeedback,
}: FeedbackButtonsProps) {
  const [currentFeedback, setCurrentFeedback] = useState<FeedbackValue>(feedback);
  const [copied, setCopied] = useState(false);

  const handleFeedback = (value: FeedbackValue) => {
    const next = currentFeedback === value ? null : value;
    setCurrentFeedback(next);
    onFeedback?.(messageId, next);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available — silently ignore
    }
  };

  return (
    <div
      className={[
        "flex items-center gap-1 transition-opacity",
        alwaysVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        className ?? "",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={handleCopy}
        aria-label="复制内容"
        className="inline-flex h-8 w-8 items-center justify-center rounded text-[#999999] hover:bg-[#F5F5F5] hover:text-[#666666] transition-colors"
      >
        {copied ? (
          <Check className="h-4 w-4 text-green-600" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
      <button
        type="button"
        onClick={() => handleFeedback("like")}
        aria-label="点赞"
        className={[
          "inline-flex h-8 w-8 items-center justify-center rounded transition-colors",
          currentFeedback === "like"
            ? "text-[#10B981] bg-[#ECFDF5]"
            : "text-[#999999] hover:text-[#10B981] hover:bg-[#F5F5F5]",
        ].join(" ")}
      >
        <ThumbsUp className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => handleFeedback("dislike")}
        aria-label="点踩"
        className={[
          "inline-flex h-8 w-8 items-center justify-center rounded transition-colors",
          currentFeedback === "dislike"
            ? "text-[#EF4444] bg-[#FEF2F2]"
            : "text-[#999999] hover:text-[#EF4444] hover:bg-[#F5F5F5]",
        ].join(" ")}
      >
        <ThumbsDown className="h-4 w-4" />
      </button>
    </div>
  );
}

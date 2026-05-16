"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, ImageIcon } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="prose prose-gray max-w-none prose-headings:font-semibold prose-headings:text-[#1A1A1A] prose-p:text-[#333333] prose-p:leading-relaxed prose-li:text-[#333333] prose-strong:text-[#1A1A1A]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || "");
            const language = match?.[1] || "text";
            const value = String(children).replace(/\n$/, "");

            if (!className) {
              return (
                <code
                  className="rounded px-1.5 py-0.5 text-[13px] font-mono bg-[#f6f8fa] text-[#24292f]"
                  {...props}
                >
                  {children}
                </code>
              );
            }

            return (
              <div className="my-3 overflow-hidden rounded-md border border-[#d0d7de] bg-[#f6f8fa]">
                <div className="flex items-center justify-between border-b border-[#d0d7de] bg-[#f6f8fa] px-3 py-1.5">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[#57606a]">
                    {language}
                  </span>
                  <CopyButton value={value} />
                </div>
                <div className="overflow-x-auto">
                  <SyntaxHighlighter
                    language={language}
                    style={oneLight}
                    PreTag="div"
                    customStyle={{
                      margin: 0,
                      padding: "0.75rem 1rem",
                      background: "transparent",
                      fontSize: "13px",
                      lineHeight: "1.5",
                    }}
                    showLineNumbers={false}
                    wrapLines={true}
                  >
                    {value}
                  </SyntaxHighlighter>
                </div>
              </div>
            );
          },
          img({ src, alt, ...props }: any) {
            const [hasError, setHasError] = React.useState(false);

            if (hasError) {
              return (
                <div className="my-3 flex items-center gap-2 text-sm text-[#999999]">
                  <ImageIcon className="h-4 w-4" />
                  <span>图片加载失败</span>
                </div>
              );
            }

            return (
              <img
                src={src}
                alt={alt ?? ""}
                className="my-3 max-w-full rounded-lg"
                onError={() => setHasError(true)}
                loading="lazy"
                {...props}
              />
            );
          },
          a({ href, children, ...props }: any) {
            const safe = typeof href === "string" && /^https?:\/\//i.test(href);
            return (
              <a
                className="text-[#0969da] underline-offset-4 hover:underline"
                target={safe ? "_blank" : undefined}
                rel={safe ? "noreferrer" : undefined}
                href={safe ? href : undefined}
                {...props}
              >
                {children}
              </a>
            );
          },
          table({ children, ...props }: any) {
            return (
              <div className="overflow-x-auto">
                <table
                  className="w-full border-collapse border border-[#d0d7de] rounded-md"
                  {...props}
                >
                  {children}
                </table>
              </div>
            );
          },
          thead({ children, ...props }: any) {
            return (
              <thead className="bg-[#f6f8fa]" {...props}>
                {children}
              </thead>
            );
          },
          th({ children, ...props }: any) {
            return (
              <th
                className="border-b border-[#d0d7de] border-r border-r-[#d0d7de] px-3 py-2 text-left text-sm font-semibold text-[#24292f] last:border-r-0"
                {...props}
              >
                {children}
              </th>
            );
          },
          td({ children, ...props }: any) {
            return (
              <td
                className="border-b border-[#d0d7de] border-r border-r-[#d0d7de] px-3 py-2.5 text-sm text-[#24292f] last:border-r-0"
                {...props}
              >
                {children}
              </td>
            );
          },
          blockquote({ children, ...props }: any) {
            return (
              <blockquote
                className="my-3 border-l-4 border-[#3B82F6] bg-[#F0F7FF] pl-3 pr-3 py-2 italic text-[#333333]"
                {...props}
              >
                {children}
              </blockquote>
            );
          },
          ul({ children, ...props }: any) {
            return (
              <ul className="my-2 ml-6 list-disc space-y-1" {...props}>
                {children}
              </ul>
            );
          },
          ol({ children, ...props }: any) {
            return (
              <ol className="my-2 ml-6 list-decimal space-y-1" {...props}>
                {children}
              </ol>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label="复制代码"
      className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[#eaeef2] transition-colors"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-600" />
      ) : (
        <Copy className="h-3.5 w-3.5 text-[#57606a]" />
      )}
    </button>
  );
}

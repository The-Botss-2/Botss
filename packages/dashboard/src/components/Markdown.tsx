import { memo, useEffect, useId, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useResolvedTheme } from "../lib/theme";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function textOf(children: unknown): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (children && typeof children === "object" && "props" in children)
    return textOf((children as { props: { children?: unknown } }).props.children);
  return "";
}

/** Mermaid is ~1MB, so it is imported only when a document actually contains a diagram. */
function Mermaid({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const theme = useResolvedTheme();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "neutral",
          fontFamily: "IBM Plex Sans, sans-serif",
        });
        const { svg } = await mermaid.render(`${id}-${theme}`, code);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, id, theme]);
  return (
    <figure className="my-4 border border-rule bg-surface p-3">
      <div ref={ref} className="mermaid-block flex justify-center" role="img" aria-label="Diagram" />
      {err && (
        <>
          <div className="mono mb-2 text-[11px] text-danger">Diagram could not be rendered: {err}</div>
          <pre className="mono overflow-x-auto text-[12px]">{code}</pre>
        </>
      )}
    </figure>
  );
}

const components: Components = {
  code({ className, children, ...rest }) {
    const lang = /language-(\w+)/.exec(className ?? "")?.[1];
    const text = String(children ?? "").replace(/\n$/, "");
    if (lang === "mermaid") return <Mermaid code={text} />;
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
  pre({ children }) {
    // Mermaid figures must not sit inside <pre>.
    const child = Array.isArray(children) ? children[0] : children;
    if (
      child &&
      typeof child === "object" &&
      "type" in child &&
      (child as { type: unknown }).type === Mermaid
    )
      return <>{children}</>;
    return <pre>{children}</pre>;
  },
  h1: ({ children }) => <h1 id={slugify(textOf(children))}>{children}</h1>,
  h2: ({ children }) => <h2 id={slugify(textOf(children))}>{children}</h2>,
  h3: ({ children }) => <h3 id={slugify(textOf(children))}>{children}</h3>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
};

export const Markdown = memo(function Markdown({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`prose ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** Headings for comment anchors. */
export function headingsOf(md: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (m) out.push(m[2]!);
  }
  return out;
}

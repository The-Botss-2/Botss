import { html as diffHtml } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import { memo, useMemo, useState } from "react";
import { useResolvedTheme } from "../lib/theme";

/** Unified diff -> diff2html, side by side or line by line. diff2html escapes the code it renders. */
export const DiffView = memo(function DiffView({
  diff,
  defaultFormat = "side-by-side",
  fileList = true,
}: {
  diff: string;
  defaultFormat?: "side-by-side" | "line-by-line";
  fileList?: boolean;
}) {
  const theme = useResolvedTheme();
  const [format, setFormat] = useState(defaultFormat);
  const rendered = useMemo(
    () =>
      diffHtml(diff, {
        outputFormat: format,
        drawFileList: fileList,
        matching: "lines",
        colorScheme: theme === "dark" ? ("dark" as never) : ("light" as never),
      }),
    [diff, format, theme, fileList],
  );
  if (!diff.trim()) return <div className="text-[13px] text-ink-3">No changes.</div>;
  return (
    <div className="diff-view">
      <div className="mb-2 flex justify-end gap-1" role="group" aria-label="Diff layout">
        {(["side-by-side", "line-by-line"] as const).map((f) => (
          <button
            key={f}
            className={`btn btn-sm ${format === f ? "btn-primary" : ""}`}
            aria-pressed={format === f}
            onClick={() => setFormat(f)}
          >
            {f === "side-by-side" ? "Side by side" : "Unified"}
          </button>
        ))}
      </div>
      <div dangerouslySetInnerHTML={{ __html: rendered }} />
    </div>
  );
});

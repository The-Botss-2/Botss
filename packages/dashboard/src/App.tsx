import { useEffect, useState } from "react";
import { Shell, defaultScreen } from "./components/Shell";
import { Toaster } from "./components/ui";
import { getToken, setToken } from "./lib/api";
import { useProject } from "./lib/queries";
import { href, navigate, useRoute } from "./lib/router";
import { AgentsScreen } from "./screens/Agents";
import { BoardScreen } from "./screens/Board";
import { DesignScreen } from "./screens/Design";
import { DocsScreen } from "./screens/Docs";
import { FeedScreen } from "./screens/Feed";
import { IdeaScreen } from "./screens/Idea";
import { PreviewScreen } from "./screens/Preview";
import { ProjectsScreen } from "./screens/Projects";
import { QuestionsScreen } from "./screens/Questions";
import { SettingsScreen } from "./screens/Settings";
import { TeamScreen } from "./screens/Team";
import { UsageScreen } from "./screens/Usage";

export function App() {
  const route = useRoute();
  const [hasToken, setHasToken] = useState(Boolean(getToken()));
  if (!hasToken) return <NeedToken onToken={() => setHasToken(true)} />;
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-surface focus:px-3 focus:py-2"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      {route.pid ? (
        <ProjectRoute pid={route.pid} screen={route.screen} rest={route.rest} />
      ) : (
        <ProjectsScreen openPath={route.screen === "open" ? (route.params.get("path") ?? "") : null} />
      )}
      <Toaster />
    </>
  );
}

function ProjectRoute({ pid, screen, rest }: { pid: string; screen: string; rest: string[] }) {
  const project = useProject(pid);
  useEffect(() => {
    if (!screen && project.data) {
      const [s = "board", ...r] = defaultScreen(project.data).split("/");
      navigate(href(pid, s, ...r), true);
    }
  }, [screen, project.data, pid]);
  useEffect(() => {
    document.title = project.data ? `${project.data.name} · Botss` : "Botss";
  }, [project.data]);
  return (
    <Shell pid={pid} screen={screen}>
      <div className="px-6 py-5 max-[1100px]:px-4">
        <Screen pid={pid} screen={screen} rest={rest} />
      </div>
    </Shell>
  );
}

function Screen({ pid, screen, rest }: { pid: string; screen: string; rest: string[] }) {
  switch (screen) {
    case "idea":
      return <IdeaScreen pid={pid} />;
    case "questions":
      return <QuestionsScreen pid={pid} />;
    case "docs":
      return <DocsScreen pid={pid} name={rest.length ? rest.join("/") : null} />;
    case "design":
      return <DesignScreen pid={pid} />;
    case "team":
      return <TeamScreen pid={pid} />;
    case "board":
      return <BoardScreen pid={pid} taskId={rest[0] ?? null} />;
    case "agents":
      return <AgentsScreen pid={pid} />;
    case "feed":
      return <FeedScreen pid={pid} />;
    case "preview":
      return <PreviewScreen pid={pid} />;
    case "usage":
      return <UsageScreen pid={pid} />;
    case "settings":
      return <SettingsScreen pid={pid} />;
    case "":
      return null;
    default:
      return <div className="text-ink-2">Unknown screen “{screen}”.</div>;
  }
}

function NeedToken({ onToken }: { onToken: () => void }) {
  const [v, setV] = useState("");
  return (
    <div className="canvas flex h-full items-center justify-center p-6">
      <form
        className="w-full max-w-md border border-rule bg-surface p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim()) {
            setToken(v.trim());
            onToken();
          }
        }}
      >
        <div className="mono mb-2 text-[12px] text-ink-3">botss · access token required</div>
        <h1 className="mb-2 text-[20px] font-semibold">
          Open the link from <code className="mono">botss up</code>
        </h1>
        <p className="mb-4 text-[13px] text-ink-2">
          The dashboard link printed by <code className="mono">botss up</code> carries an access token. Open
          that link, or paste the token here.
        </p>
        <label className="label" htmlFor="tok">
          Token
        </label>
        <input
          id="tok"
          className="field mono"
          value={v}
          onChange={(e) => setV(e.target.value)}
          autoComplete="off"
        />
        <button className="btn btn-primary mt-4" type="submit">
          Continue
        </button>
      </form>
    </div>
  );
}

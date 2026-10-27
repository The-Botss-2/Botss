import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { api, docPath, pp } from "./api";
import type {
  Agent,
  DesignInfo,
  DocDetail,
  DocRow,
  DocVersion,
  PlanInfo,
  ProjectInfo,
  ProjectListItem,
  Run,
  Question,
  SkillFile,
  SkillsInfo,
  Task,
  TaskDetail,
  UsageInfo,
} from "./types";

// Query keys are ["p", pid, <topic>, ...]. The first segment after pid is the WebSocket topic that invalidates it
// (see topicsFor in packages/server/src/bus.ts).

type Opts<T> = Omit<UseQueryOptions<T>, "queryKey" | "queryFn">;

function useP<T>(pid: string, topic: string, path: string, extra: unknown[] = [], opts: Opts<T> = {}) {
  return useQuery<T>({
    queryKey: ["p", pid, topic, path, ...extra],
    queryFn: () => api<T>("GET", pp(pid, path)),
    ...opts,
  });
}

export const useProjects = () =>
  useQuery({ queryKey: ["projects"], queryFn: () => api<ProjectListItem[]>("GET", "/api/projects") });
export const useProject = (pid: string) => useP<ProjectInfo>(pid, "project", "");
export const useTasks = (pid: string) => useP<Task[]>(pid, "tasks", "/tasks");
export const useTask = (pid: string, id: string | null) =>
  useP<TaskDetail>(pid, "tasks", `/tasks/${encodeURIComponent(id ?? "")}`, [], { enabled: Boolean(id) });
export const useTaskDiff = (pid: string, id: string, enabled: boolean) =>
  useP<{ diff: string; base?: string; head?: string }>(
    pid,
    "tasks",
    `/tasks/${encodeURIComponent(id)}/diff`,
    ["diff"],
    { enabled },
  );
export const useQuestions = (pid: string) => useP<Question[]>(pid, "questions", "/questions");
export const useDocs = (pid: string) => useP<DocRow[]>(pid, "docs", "/docs");
export const useDoc = (pid: string, name: string | null) =>
  useP<DocDetail>(pid, "docs", `/docs/${docPath(name ?? "")}`, [], { enabled: Boolean(name) });
export const useDocVersion = (pid: string, name: string, v: number | null) =>
  useQuery({
    queryKey: ["docver", pid, name, v],
    queryFn: () => api<DocVersion>("GET", pp(pid, `/docs/${docPath(name)}/versions/${v}`)),
    enabled: v !== null && v > 0,
    staleTime: Infinity,
  });
export const useAgents = (pid: string) => useP<Agent[]>(pid, "agents", "/agents");
export const useRuns = (pid: string) => useP<Run[]>(pid, "runs", "/runs");
export const usePlan = (pid: string) => useP<PlanInfo>(pid, "tasks", "/plan");
export const useUsage = (pid: string) =>
  useP<UsageInfo>(pid, "usage", "/usage", [], { refetchInterval: 30_000 });
export const useDesign = (pid: string) => useP<DesignInfo>(pid, "docs", "/design", ["design"]);
export const useSkills = (pid: string) => useP<SkillsInfo>(pid, "skills", "/skills");
export const useSkillFile = (pid: string, path: string | null) =>
  useP<SkillFile>(pid, "skills", `/skills/file?path=${encodeURIComponent(path ?? "")}`, [], {
    enabled: Boolean(path),
    staleTime: Infinity,
  });

/** A POST/PATCH/PUT that refreshes the project's queries afterwards. */
export function useAction<TBody = unknown, TOut = unknown>(
  pid: string,
  method: string,
  path: string | ((b: TBody) => string),
  topics: string[] = ["project"],
) {
  const qc = useQueryClient();
  return useMutation<TOut, Error, TBody>({
    mutationFn: (body: TBody) =>
      api<TOut>(method, pp(pid, typeof path === "function" ? path(body) : path), body ?? {}),
    onSuccess: () => {
      for (const t of topics) void qc.invalidateQueries({ queryKey: ["p", pid, t] });
    },
  });
}

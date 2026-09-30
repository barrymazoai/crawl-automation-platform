import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  StateSchema,
  STORAGE_KEY,
  seed,
  type DemoState,
  type ResultFilter,
} from "./data/model";

export type Route = "overview" | "brands" | "launch" | "schedules" | "results";
export type Dialog =
  | { type: "brand-detail" | "run" | "product"; id: string }
  | { type: "brand-edit" | "schedule-edit"; id?: string }
  | { type: "source-edit"; brandId: string; id?: string }
  | { type: "confirm-launch"; ids: string[]; scheduleId?: string }
  | { type: "import" | "all-runs" | "reset" | "help" };
interface Store {
  state: DemoState;
  mutate: <T>(fn: (draft: DemoState) => T) => T;
  reset: () => void;
  dialog: Dialog | null;
  open: (dialog: Dialog) => void;
  close: () => void;
  route: Route;
  navigate: (route: Route) => void;
  brandScope: string;
  setBrandScope: (value: string) => void;
  resultFilter: ResultFilter;
  setResultFilter: (filter: ResultFilter) => void;
  message: string;
  notify: (message: string) => void;
  storageError: string;
}
const Context = createContext<Store | null>(null);
function initial() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return {
      state: raw ? StateSchema.parse(JSON.parse(raw)) : seed(),
      error: "",
    };
  } catch {
    return { state: seed(), error: "已有演示数据无法读取，已使用初始样例。" };
  }
}
const readRoute = (): Route => {
  const hash = location.hash.slice(1);
  return ["overview", "brands", "launch", "schedules", "results"].includes(hash)
    ? (hash as Route)
    : "overview";
};
export function DemoProvider({ children }: { children: ReactNode }) {
  const [boot] = useState(initial);
  const [state, setState] = useState(boot.state);
  const latest = useRef(state);
  const [storageError, setStorageError] = useState(boot.error);
  const [route, setRoute] = useState<Route>(readRoute);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [brandScope, setBrandScope] = useState("");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [message, notify] = useState("");
  useEffect(() => {
    const onHash = () => {
      setRoute(readRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => notify(""), 5000);
    return () => clearTimeout(timer);
  }, [message]);
  function commit(next: DemoState) {
    StateSchema.parse(next);
    latest.current = next;
    setState(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      setStorageError("浏览器存储不可用，修改只在当前页面保留。");
    }
  }
  function mutate<T>(fn: (draft: DemoState) => T): T {
    const draft = structuredClone(latest.current),
      result = fn(draft);
    commit(draft);
    return result;
  }
  const value: Store = {
    state,
    mutate,
    reset: () => commit(seed()),
    dialog,
    open: setDialog,
    close: () => setDialog(null),
    route,
    navigate: (next) => {
      location.hash = next;
      setRoute(next);
    },
    brandScope,
    setBrandScope,
    resultFilter,
    setResultFilter,
    message,
    notify,
    storageError,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useDemo() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("DemoProvider is required");
  return ctx;
}

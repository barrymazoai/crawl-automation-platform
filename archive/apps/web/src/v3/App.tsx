import { useEffect } from "react";
import { Button, Chip } from "@heroui/react";
import {
  Box,
  CalendarClock,
  Database,
  Info,
  LayoutDashboard,
  Layers3,
  Play,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useDemo, type Route } from "./store";
import { metrics } from "./data/model";
import { Overview } from "./pages/Overview";
import { Brands } from "./pages/Brands";
import { Launch } from "./pages/Launch";
import { Schedules } from "./pages/Schedules";
import { Results } from "./pages/Results";
import { Dialogs } from "./dialogs/Dialogs";
import { Note } from "./ui";

const navs = [
  { id: "overview", name: "工作总览", icon: LayoutDashboard },
  { id: "brands", name: "Brand 管理", icon: Layers3 },
  { id: "launch", name: "发起采集", icon: Play },
  { id: "schedules", name: "定时计划", icon: CalendarClock },
  { id: "results", name: "数据与 Review", icon: Database },
] satisfies { id: Route; name: string; icon: typeof Box }[];
function Navigation({ mobile = false }: { mobile?: boolean }) {
  const { route, state } = useDemo();
  return (
    <nav
      aria-label={mobile ? "移动导航" : "主要导航"}
      className={
        mobile
          ? "fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-border bg-[#f5f8eff5] px-1 py-3 backdrop-blur md:hidden"
          : "grid gap-1"
      }
    >
      {navs.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          aria-current={route === item.id ? "page" : undefined}
          className={
            mobile
              ? `flex flex-col items-center gap-1.5 px-1 text-[9px] ${route === item.id ? "font-semibold text-accent" : "text-muted"}`
              : `flex items-center gap-3 rounded-xl px-3 py-3 text-xs transition-colors ${route === item.id ? "bg-[#dce8d2] font-semibold text-[#31512d]" : "text-muted hover:bg-[#e5ecdE]"}`
          }
        >
          <item.icon size={17} />
          {item.name}
          {item.id === "results" && !mobile && (
            <span className="ml-auto rounded bg-[#f2f6ea] px-1.5 py-0.5 text-[10px]">
              {metrics(state).review}
            </span>
          )}
        </a>
      ))}
    </nav>
  );
}
export function App() {
  const { route, open, message, storageError } = useDemo();
  const title = navs.find((n) => n.id === route)!.name;
  useEffect(() => {
    document.title = `${title} · HeroUI v3 / Crawler`;
  }, [title]);
  const Page = {
    overview: Overview,
    brands: Brands,
    launch: Launch,
    schedules: Schedules,
    results: Results,
  }[route];
  return (
    <>
      <a
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
        className="fixed -top-20 left-5 z-50 rounded-lg bg-white p-3 text-xs focus:top-4"
      >
        跳到主要内容
      </a>
      <div className="min-h-screen md:grid md:grid-cols-[205px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-screen flex-col border-r border-[#dfe6d7] bg-[#edf2e8] px-4 py-7 md:flex">
          <a
            href="#overview"
            className="flex items-center gap-2.5 px-2"
            aria-label="Crawler 工作总览"
          >
            <span className="grid size-9 place-items-center rounded-xl bg-accent text-[#d6eab5]">
              <Layers3 size={20} />
            </span>
            <div>
              <p className="text-lg font-bold tracking-tight">
                crawler<span className="text-[#859c70]">.</span>
              </p>
              <p className="mt-0.5 text-[8px] tracking-[.16em] text-muted">
                COLLECTION WORKSPACE
              </p>
            </div>
          </a>
          <div className="my-8 flex gap-3 rounded-xl border border-[#dce5d4] bg-[#f7faf2] p-3">
            <span className="grid size-8 place-items-center rounded-lg bg-[#e6eddd] text-xs font-bold">
              V3
            </span>
            <div>
              <p className="text-xs font-medium">采集工作台</p>
              <p className="mt-1 text-[9px] text-muted">
                独立模块 · 持久化流程
              </p>
            </div>
          </div>
          <p className="mb-3 px-3 text-[9px] tracking-[.2em] text-muted">
            WORKSPACE
          </p>
          <Navigation />
          <div className="mt-auto pt-8">
            <div className="rounded-xl border border-[#dce5d4] bg-[#f4f7ee] p-3 text-[10px] leading-6 text-muted">
              <p className="mb-1 flex items-center gap-1.5 font-medium text-accent">
                <ShieldCheck size={14} />
                安全的演示空间
              </p>
              所有品牌、产品与运行状态均为模拟，操作仅保存在此浏览器。
            </div>
            <div className="mt-5 flex items-center gap-2.5 px-2">
              <span className="grid size-8 place-items-center rounded-full border border-[#d9e4cf] bg-[#e3ebd9] text-[10px] font-semibold">
                ST
              </span>
              <div>
                <p className="text-[11px]">我的工作空间</p>
                <p className="mt-1 text-[9px] text-muted">
                  Vite + HeroUI v3 + Tailwind
                </p>
              </div>
            </div>
          </div>
        </aside>
        <div className="min-w-0">
          <header className="flex h-16 items-center gap-3 border-b border-border bg-[#fafbf7] px-5 lg:px-8">
            <span className="text-xs font-semibold md:hidden">crawler.</span>
            <p className="hidden text-[11px] text-muted md:block">
              工作空间{" "}
              <span className="ml-3 text-foreground">/ &nbsp; {title}</span>
            </p>
            <span className="flex-1" />
            <span className="hidden text-[10px] text-muted xl:block">
              演示时钟 · 2026.09.05 17:40 CST
            </span>
            <Chip
              size="sm"
              variant="soft"
              color="success"
              className="gap-1.5 text-[10px]"
            >
              <span className="size-1.5 rounded-full bg-current" />
              HeroUI v3 DEMO
            </Chip>
            <Button
              variant="outline"
              size="sm"
              isIconOnly
              aria-label="演示说明"
              onPress={() => open({ type: "help" })}
            >
              <Info size={16} />
            </Button>
          </header>
          <main
            id="main-content"
            tabIndex={-1}
            className="mx-auto max-w-[1510px] p-4 pb-28 outline-none sm:p-6 md:pb-8 lg:p-8"
          >
            {storageError && (
              <div className="mb-5">
                <Note warning>{storageError}</Note>
              </div>
            )}
            <Page />
            <footer className="mt-7 flex flex-wrap items-center justify-between gap-3 text-[10px] text-muted">
              <span>本地模拟数据 · 未连接 Temporal / R2 / 生产数据库</span>
              <Button
                variant="ghost"
                size="sm"
                className="text-[11px] text-muted"
                onPress={() => open({ type: "reset" })}
              >
                <RotateCcw size={12} />
                重置演示
              </Button>
            </footer>
          </main>
        </div>
      </div>
      <Navigation mobile />
      <Dialogs />
      {message && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-24 left-1/2 z-50 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl bg-accent px-5 py-3 text-xs leading-6 text-white shadow-xl md:bottom-7"
        >
          {message}
        </div>
      )}
    </>
  );
}

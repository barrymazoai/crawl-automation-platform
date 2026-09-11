import { Button, Chip } from "@heroui/react";
import {
  ArrowRight,
  Box,
  CalendarClock,
  Database,
  Layers3,
  Link2,
  Monitor,
  Play,
  Plus,
  ShieldCheck,
  Upload,
} from "lucide-react";
import {
  metrics,
  nextOccurrence,
  STAGES,
  type Run,
  type ResultFilter,
} from "../data/model";
import { useDemo } from "../store";
import {
  BrandAvatar,
  ChannelChip,
  Empty,
  Kv,
  PageHead,
  Panel,
  Status,
  TextButton,
} from "../ui";

export function RunRows({ runs }: { runs: Run[] }) {
  const { state, open } = useDemo();
  return (
    <div className="divide-y divide-border">
      {runs.map((run) => {
        const brand = state.brands.find(
          (b) => b.id === run.sourceSnapshot.brandId,
        )!;
        return (
          <article key={run.id} className="p-5">
            <div className="flex flex-wrap items-center gap-3">
              <BrandAvatar brand={brand} />
              <div className="min-w-20 flex-1">
                <p className="text-xs font-semibold">{brand.name}</p>
                <p className="mt-1 text-[10px] text-muted">
                  {run.trigger} · {run.createdAt} 开始
                </p>
              </div>
              <ChannelChip channel={run.sourceSnapshot.channel} />
              <Status
                value={
                  run.step === 0
                    ? "queued"
                    : run.step === 4
                      ? "saved"
                      : "running"
                }
              />
              <TextButton onPress={() => open({ type: "run", id: run.id })}>
                详情
              </TextButton>
            </div>
            <div
              className="mt-4 grid grid-cols-4 gap-1.5"
              aria-label={`当前阶段：${STAGES[run.step]}`}
            >
              {[1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className={`h-1 rounded-full ${run.step > i ? "bg-[#aecb91]" : run.step === i ? "bg-accent" : "bg-[#edf0e7]"}`}
                />
              ))}
            </div>
            <div className="mt-2.5 flex justify-between gap-2 text-[10px]">
              <span className="text-accent">
                {STAGES[run.step]}
                {run.step === 2 && " · 单文件独立处理"}
              </span>
              <span className="text-muted">逐产品推进，无需整批等待</span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function Overview() {
  const { state, open, navigate, setResultFilter } = useDemo();
  const m = metrics(state),
    active = state.runs.filter((r) => r.step < 4);
  const results = (filter: ResultFilter) => {
    setResultFilter(filter);
    navigate("results");
  };
  const stats = [
    {
      title: "管理中的 Brand",
      value: m.brands,
      unit: "个品牌",
      sub: `${m.sources} 个抓取来源 · 独立品牌身份`,
      icon: Layers3,
      action: () => navigate("brands"),
    },
    {
      title: "运行中的采集任务",
      value: m.active,
      unit: "个任务",
      sub: "来源级并行 · Worker 独立领取",
      icon: Play,
      action: () => open({ type: "all-runs" }),
    },
    {
      title: "采集已保存",
      value: m.saved,
      unit: "个产品",
      sub: `其中 ${m.synced} 个已同步正式库`,
      icon: Database,
      action: () => results("saved"),
    },
    {
      title: "待关联公司",
      value: m.unmapped,
      unit: "个产品",
      sub: "数据已保存 · 不阻塞继续采集",
      icon: Link2,
      action: () => results("unmapped"),
    },
  ];
  const days = Array.from({ length: 7 }, (_, day) => ({
    saved: state.products.filter((p) => p.day === day && p.status !== "review")
      .length,
    review: state.products.filter((p) => p.day === day && p.status === "review")
      .length,
  }));
  const max = Math.max(1, ...days.map((d) => d.saved + d.review));
  return (
    <>
      <PageHead
        title="让采集，有条不紊。"
        description="从一个 Brand 出发，让每一份数据都有来处、每一步处理都有记录。"
        eyebrow="OVERVIEW"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onPress={() => open({ type: "import" })}
            >
              <Upload size={15} />
              导入 Brand
            </Button>
            <Button size="sm" onPress={() => navigate("launch")}>
              <Plus size={15} />
              发起采集
            </Button>
          </>
        }
      />
      <section
        className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4"
        aria-label="演示业务汇总"
      >
        {stats.map((item, i) => (
          <Button
            key={item.title}
            onPress={item.action}
            variant="outline"
            className={`relative h-auto w-full min-w-0 flex-col items-stretch gap-0 overflow-hidden rounded-2xl p-5 text-left shadow-none ${i === 0 ? "border-accent bg-accent text-white hover:bg-[#214e3d]" : "border-border bg-white"}`}
          >
            <div
              className={`flex items-center gap-2 text-[11px] font-normal ${i === 0 ? "text-[#d4e5cb]" : "text-muted"}`}
            >
              <item.icon size={14} />
              {item.title}
            </div>
            <div className="my-4 flex items-end gap-2">
              <span className="text-4xl font-medium tracking-tighter">
                {item.value}
              </span>
              <span
                className={`pb-1 text-[10px] font-normal ${i === 0 ? "text-[#d4e5cb]" : "text-muted"}`}
              >
                {item.unit}
              </span>
              <span
                className="ml-auto hidden h-7 items-end gap-1 sm:flex"
                aria-hidden="true"
              >
                {[9, 16, 12, 21, 18, 28].map((height, n) => (
                  <i
                    key={n}
                    style={{ height }}
                    className={`w-1.5 rounded-t-sm ${i ? "bg-[#dbe7cd]" : "bg-[#a5c984]"}`}
                  />
                ))}
              </span>
            </div>
            <div
              className={`flex justify-between gap-2 border-t pt-3 text-[10px] font-normal ${i === 0 ? "border-white/20 text-[#d4e5cb]" : "border-border text-muted"}`}
            >
              <span className="whitespace-normal leading-5">{item.sub}</span>
              <ArrowRight size={12} className="mt-1 shrink-0" />
            </div>
          </Button>
        ))}
      </section>
      <div className="grid items-start gap-5 xl:grid-cols-[1.8fr_1fr]">
        <div className="grid gap-5">
          <Panel
            title="正在进行"
            subtitle="演示状态 · 点击详情可手动推进"
            action={
              <TextButton onPress={() => open({ type: "all-runs" })}>
                全部任务 · {active.length}
              </TextButton>
            }
          >
            {active.length ? (
              <RunRows runs={active.slice(0, 3)} />
            ) : (
              <Empty
                title="当前没有运行中的采集"
                description="选一个 Brand，为它发起一轮新的采集。"
              />
            )}
          </Panel>
          <Panel
            title="采集数据沉淀"
            subtitle="最近 7 个演示日 · 产品观察数，不是去重商品数"
            action={
              <Chip size="sm" variant="soft">
                08.30 — 09.05
              </Chip>
            }
          >
            <div className="px-6 pt-5">
              <div
                className="chart-grid flex h-36 items-end gap-4"
                role="img"
                aria-label={days
                  .map(
                    (d, i) => `第${i + 1}日保存${d.saved}，Review${d.review}`,
                  )
                  .join("；")}
              >
                {days.map((d, i) => (
                  <div
                    key={i}
                    className="flex h-full flex-1 flex-col items-center justify-end gap-2"
                  >
                    <span className="text-[10px] text-muted">
                      {d.saved + d.review}
                    </span>
                    <div
                      className="flex w-7 flex-col-reverse overflow-hidden rounded-t-md bg-[#accb94]"
                      style={{
                        height: `${((d.saved + d.review) / max) * 105}px`,
                      }}
                    >
                      <div
                        className="bg-[#dfc79e]"
                        style={{
                          height: `${(d.review / (d.saved + d.review || 1)) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-around text-[10px] text-muted">
                {[
                  "08.30",
                  "08.31",
                  "09.01",
                  "09.02",
                  "09.03",
                  "09.04",
                  "09.05",
                ].map((day) => (
                  <span key={day}>{day}</span>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 text-[11px] text-muted">
              <span>
                <span className="mr-2 inline-block size-2 rounded-sm bg-[#accb94]" />
                已保存 {m.saved}
                <span className="ml-5 mr-2 inline-block size-2 rounded-sm bg-[#dfc79e]" />
                Review {m.review}
              </span>
              <TextButton onPress={() => results("all")}>查看产品</TextButton>
            </div>
          </Panel>
        </div>
        <aside className="grid gap-5 md:grid-cols-2 xl:grid-cols-1">
          <Panel
            title="接下来的计划"
            action={
              <TextButton onPress={() => navigate("schedules")}>
                管理
              </TextButton>
            }
          >
            <div className="divide-y divide-border">
              {state.schedules
                .filter((s) => s.enabled)
                .slice(0, 3)
                .map((plan) => (
                  <div key={plan.id} className="px-5 py-4">
                    <div className="flex justify-between text-xs font-medium">
                      <span>{plan.name}</span>
                      <CalendarClock size={15} className="text-muted" />
                    </div>
                    <p className="mt-2 text-[11px] text-accent">
                      {nextOccurrence(plan)}{" "}
                      <span className="text-muted">
                        · {plan.sourceIds.length} 个来源
                      </span>
                    </p>
                    <p className="mt-1 text-[10px] text-muted">{plan.zone}</p>
                  </div>
                ))}
            </div>
            <div className="flex gap-3 border-t border-border bg-[#f8faf4] px-5 py-4">
              <ShieldCheck size={20} className="shrink-0 text-[#789660]" />
              <div>
                <p className="text-xs font-medium">
                  上一轮未结束，下一轮不堆积
                </p>
                <p className="mt-1 text-[11px] leading-5 text-muted">
                  同一来源默认跳过重叠触发。暂停计划不取消在途任务。
                </p>
              </div>
            </div>
          </Panel>
          <Panel
            title="需要留意"
            action={
              <Chip size="sm" variant="soft">
                {m.review + m.unmapped}
              </Chip>
            }
          >
            <div className="px-5 py-3">
              <Kv label="公司待关联 · 数据已保存">
                <TextButton onPress={() => results("unmapped")}>
                  {m.unmapped} 个
                </TextButton>
              </Kv>
              <Kv label="Review · 被动留存">
                <TextButton onPress={() => results("review")}>
                  {m.review} 个
                </TextButton>
              </Kv>
              <p className="py-3 text-[11px] leading-5 text-muted">
                采集错误与公司关联分开记录。这里没有“全部重试”。
              </p>
            </div>
          </Panel>
          <Panel
            title="运行环境"
            action={
              <Chip size="sm" variant="soft">
                示意 · 非实时
              </Chip>
            }
          >
            {[
              ["Mac mini", "渠道抓取 / 文件 / OCR / Codex"],
              ["Windows · 美国", "DTC 浏览器 / 继承主机网络"],
            ].map(([name, desc]) => (
              <div
                key={name}
                className="flex gap-3 border-b border-border px-5 py-4 last:border-0"
              >
                <Monitor size={17} className="mt-1 text-muted" />
                <div>
                  <p className="text-xs font-medium">{name}</p>
                  <p className="mt-1 text-[10px] text-muted">{desc}</p>
                </div>
              </div>
            ))}
          </Panel>
        </aside>
      </div>
    </>
  );
}

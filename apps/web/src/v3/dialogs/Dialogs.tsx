import { Button, Chip } from "@heroui/react";
import { ArrowRight, Check, Play } from "lucide-react";
import { advanceRun, startRuns, STAGES } from "../data/model";
import { useDemo } from "../store";
import { ChannelChip, Empty, Kv, Note, Status } from "../ui";
import { RunRows } from "../pages/Overview";
import { Shell } from "./Shell";
import {
  BrandDetail,
  BrandEditor,
  ImportDialog,
  SourceEditor,
} from "./BrandDialogs";
import { ScheduleEditor } from "./ScheduleEditor";

function RunDetail({ id }: { id: string }) {
  const { state, mutate, close, navigate, setResultFilter } = useDemo(),
    run = state.runs.find((r) => r.id === id)!;
  const b = state.brands.find((b) => b.id === run.sourceSnapshot.brandId)!;
  return (
    <Shell
      title={`${b.name} · ${run.sourceSnapshot.channel}`}
      description="执行详情示意 · 正式版在此跳转 Temporal UI"
      footer={
        run.step < 4 ? (
          <Button onPress={() => mutate((s) => advanceRun(s, id))}>
            推进演示 · 下一阶段
            <ArrowRight size={15} />
          </Button>
        ) : (
          <Button
            onPress={() => {
              close();
              setResultFilter("all");
              navigate("results");
            }}
          >
            查看采集结果
          </Button>
        )
      }
    >
      <Note>
        前端模拟流程，不是实际 Temporal 历史。每次点击只推进一个演示阶段。
      </Note>
      <div>
        <Kv label="本次执行">
          <span className="font-mono text-[10px]">{run.id}</span>
        </Kv>
        <Kv label="触发方式">{run.trigger}</Kv>
        <Kv label="来源快照">{run.sourceSnapshot.url}</Kv>
      </div>
      <ol className="space-y-0">
        {STAGES.map((stage, index) => (
          <li key={stage} className="flex gap-4">
            <div className="flex w-6 flex-col items-center">
              <span
                className={`grid size-6 shrink-0 place-items-center rounded-full text-[10px] ${index <= run.step ? "bg-[#e5efda] text-accent" : "bg-[#f0f3eb] text-muted"}`}
              >
                {index < run.step ? <Check size={12} /> : index + 1}
              </span>
              {index < 4 && (
                <span className="my-1 min-h-10 w-px flex-1 bg-border" />
              )}
            </div>
            <div className="pb-6">
              <p
                className={`text-sm font-medium ${index === run.step ? "text-accent" : ""}`}
              >
                {stage}
                {index === run.step && (
                  <Chip size="sm" variant="soft" className="ml-2 text-[10px]">
                    当前
                  </Chip>
                )}
              </p>
              <p className="mt-1 text-xs leading-6 text-muted">
                {
                  [
                    "有容量的 Worker 主动领取",
                    "发现一个产品，即可继续下游",
                    "单文件独立处理，证据先保存",
                    "Formula + Ingredients；产品归属核验",
                    "产品保存到采集库，未关联公司则待关联",
                  ][index]
                }
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Shell>
  );
}
function ProductDetail({ id }: { id: string }) {
  const { state, close } = useDemo(),
    product = state.products.find((p) => p.id === id)!,
    b = state.brands.find((b) => b.id === product.brandId)!;
  return (
    <Shell
      title={product.name}
      description={`${b.name} / ${product.variant} · 模拟产品，非真实营养信息`}
      footer={
        <Button variant="outline" onPress={close}>
          关闭
        </Button>
      }
    >
      <div className="flex justify-between">
        <Status value={product.status} />
        <ChannelChip
          channel={
            state.sources.find((s) => s.id === product.sourceId)!.channel
          }
        />
      </div>
      <div>
        <Kv label="采集 Brand">{b.name}</Kv>
        <Kv label="当前公司映射">{b.company || "尚未关联"}</Kv>
        <Kv label="观察 ID">
          <span className="font-mono text-[10px]">{product.id}</span>
        </Kv>
        <Kv label="数据是否保存">
          {product.status === "review"
            ? "完整候选与证据已留存"
            : "已保存在采集库"}
        </Kv>
      </div>
      {product.error && (
        <Note warning>
          <b className="break-all font-mono text-[11px]">{product.error}</b>
          <br />
          核心字段缺失，分类留在 Review，不自动重试。
        </Note>
      )}
      {product.status === "unmapped" && (
        <Note warning>
          {b.company
            ? "Brand 已更新关联，但历史结果尚未显式同步。"
            : "公司尚未关联，核心产品数据已经保存，不需要重新抓取。"}
        </Note>
      )}
      {[
        ["Formula", product.formula],
        ["Ingredients", product.ingredients],
      ].map(([label, value]) => (
        <section
          key={label}
          className="rounded-xl border border-border bg-[#f8faf4] p-4"
        >
          <h3 className="mb-2 text-xs font-semibold">{label}</h3>
          <p className="text-xs leading-6 text-muted">
            {value || "未获取到可验证内容，不使用占位值通过校验。"}
          </p>
        </section>
      ))}
      <section className="rounded-xl border border-border p-4">
        <h3 className="text-xs font-semibold">
          证据清单示意 · {product.artifacts} 份文件
        </h3>
        <p className="mt-2 text-xs leading-6 text-muted">
          页面快照 / 标签图片 / OCR 输出 / 完成清单。ArtifactRef、hash 与 R2 key
          将在正式版展示；Demo 没有创建真实文件。
        </p>
      </section>
    </Shell>
  );
}
function ConfirmLaunch({
  ids,
  scheduleId,
}: {
  ids: string[];
  scheduleId?: string;
}) {
  const { state, mutate, close, navigate, notify } = useDemo();
  const schedule = state.schedules.find((s) => s.id === scheduleId);
  return (
    <Shell
      title={schedule ? "模拟立即触发" : "确认本次采集"}
      description={schedule?.name || "只创建新的演示记录，不重试历史任务。"}
      footer={
        <>
          <Button variant="outline" onPress={close}>
            返回修改
          </Button>
          <Button
            onPress={() => {
              const result = mutate((s) =>
                startRuns(
                  s,
                  ids,
                  schedule ? `计划手动触发 · ${schedule.name}` : "手动采集",
                ),
              );
              close();
              if (!schedule) navigate("overview");
              notify(
                `已新建 ${result.created} 个演示任务，跳过 ${result.skipped} 个运行中或停用来源。`,
              );
            }}
          >
            <Play size={15} />
            确认发起演示
          </Button>
        </>
      }
    >
      <p className="text-sm">本次选择 {ids.length} 个抓取来源：</p>
      <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-xl border border-border">
        {ids.map((id) => {
          const s = state.sources.find((s) => s.id === id)!;
          return (
            <div
              key={id}
              className="flex items-center justify-between gap-3 px-4 py-3 text-xs"
            >
              <span>{state.brands.find((b) => b.id === s.brandId)!.name}</span>
              <ChannelChip channel={s.channel} />
            </div>
          );
        })}
      </div>
      {schedule && (
        <p className="text-xs leading-6 text-muted">
          显式手动触发不会恢复已暂停的计划。运行中或停用的来源会跳过。
        </p>
      )}
      <Note>全部操作只在浏览器里模拟，不发送外部请求，不产生调用费用。</Note>
    </Shell>
  );
}
export function Dialogs() {
  const { dialog, state, close, reset, notify } = useDemo();
  if (!dialog) return null;
  switch (dialog.type) {
    case "brand-detail":
      return <BrandDetail id={dialog.id} />;
    case "brand-edit":
      return (
        <BrandEditor
          key={dialog.id || "new"}
          {...(dialog.id ? { id: dialog.id } : {})}
        />
      );
    case "source-edit":
      return (
        <SourceEditor
          key={dialog.id || "new"}
          brandId={dialog.brandId}
          {...(dialog.id ? { id: dialog.id } : {})}
        />
      );
    case "import":
      return <ImportDialog />;
    case "schedule-edit":
      return (
        <ScheduleEditor
          key={dialog.id || "new"}
          {...(dialog.id ? { id: dialog.id } : {})}
        />
      );
    case "confirm-launch":
      return (
        <ConfirmLaunch
          ids={dialog.ids}
          {...(dialog.scheduleId ? { scheduleId: dialog.scheduleId } : {})}
        />
      );
    case "run":
      return <RunDetail id={dialog.id} />;
    case "product":
      return <ProductDetail id={dialog.id} />;
    case "all-runs":
      return (
        <Shell
          title="采集任务"
          description="仅展示演示状态，正式执行详情交给 Temporal UI。"
        >
          {state.runs.length ? <RunRows runs={state.runs} /> : <Empty />}
        </Shell>
      );
    case "reset":
      return (
        <Shell
          title="重置本地演示？"
          description="只影响这个浏览器中的 HeroUI Demo。"
          footer={
            <>
              <Button variant="outline" onPress={close}>
                保留修改
              </Button>
              <Button
                onPress={() => {
                  reset();
                  close();
                  notify("HeroUI Demo 已恢复初始样例。");
                }}
              >
                重置演示数据
              </Button>
            </>
          }
        >
          <p className="text-sm leading-7">
            将恢复初始样例，清除在这个 Demo 中新建的
            Brand、来源、计划和模拟任务。不会影响 HTML 原型或任何真实业务数据。
          </p>
        </Shell>
      );
    case "help":
      return (
        <Shell
          title="这次是真正的组件版。"
          description="Vite + React 19 + HeroUI 3.2.4 + Tailwind CSS v4"
          footer={<Button onPress={close}>开始体验</Button>}
        >
          <Note>
            运行在 apps/web 的独立 v3.html 入口，没有嵌入原来的
            HTML，也没有连接旧生产接口。
          </Note>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">HeroUI 负责组件交互</h3>
            <p className="text-xs leading-7 text-muted">
              Button、Card、Avatar、Chip、Table、Tabs、Modal、TextField、Input、TextArea、Select、ListBox、Checkbox、Switch、Form
              都使用 HeroUI v3。
            </p>
            <h3 className="text-sm font-semibold">Tailwind 负责布局和主题</h3>
            <p className="text-xs leading-7 text-muted">
              响应式网格、间距、排版和细节样式用 Tailwind；深绿主色通过 HeroUI
              主题变量统一设置。
            </p>
            <h3 className="text-sm font-semibold">安全的演示数据</h3>
            <p className="text-xs leading-7 text-muted">
              状态只保存在当前浏览器。没有真实 Temporal 调度、OCR / Codex
              调用、R2 上传或数据库写入。演示时钟固定为 2026-09-05 17:40
              上海时间。
            </p>
          </div>
        </Shell>
      );
  }
}

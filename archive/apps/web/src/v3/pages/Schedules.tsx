import { Button, Chip } from "@heroui/react";
import { CalendarClock, Play, Plus } from "lucide-react";
import { frequencyLabel, nextOccurrence } from "../data/model";
import { useDemo } from "../store";
import { ChannelChip, Note, PageHead, Panel, Toggle } from "../ui";

export function Schedules() {
  const { state, mutate, open, notify } = useDemo();
  return (
    <>
      <PageHead
        title="把重复的事，交给计划。"
        description="按 Brand 和来源安排采集时间，不需要每次手动发起。"
        eyebrow="SCHEDULES"
        actions={
          <Button size="sm" onPress={() => open({ type: "schedule-edit" })}>
            <Plus size={15} />
            新建计划
          </Button>
        }
      />
      <div className="mb-6">
        <Note>
          正式版由 Temporal Schedules 触发。Demo 只保存配置、预览下次时间，
          <b>不会在后台计时执行</b>。
        </Note>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {state.schedules.map((plan) => (
          <Panel key={plan.id}>
            <div className="p-6">
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-xl bg-[#eef4e7] text-[#6d8b56]">
                  <CalendarClock size={20} />
                </span>
                <span className="ml-auto text-xs text-muted">
                  {plan.enabled ? "计划已启用" : "计划已暂停"}
                </span>
                <Toggle
                  label={`启用 ${plan.name}`}
                  value={plan.enabled}
                  onChange={(enabled) => {
                    mutate((s) => {
                      s.schedules.find((p) => p.id === plan.id)!.enabled =
                        enabled;
                    });
                    notify(
                      enabled
                        ? "演示计划已启用，不会在后台实际触发。"
                        : "计划已暂停，在途任务不受影响。",
                    );
                  }}
                />
              </div>
              <h2 className="mt-5 text-base font-semibold">{plan.name}</h2>
              <p className="mt-2 text-sm text-accent">
                {frequencyLabel(plan.frequency)} {plan.time}{" "}
                <span className="text-xs text-muted">/ {plan.zone}</span>
              </p>
              <div className="my-5 flex flex-wrap gap-1.5">
                {[
                  ...new Set(
                    state.sources
                      .filter((s) => plan.sourceIds.includes(s.id))
                      .map((s) => s.channel),
                  ),
                ].map((c) => (
                  <ChannelChip key={c} channel={c} />
                ))}
                <Chip size="sm" variant="soft">
                  {plan.sourceIds.length} 个来源
                </Chip>
              </div>
              <div className="flex justify-between gap-3 border-t border-border pt-4 text-xs">
                <span className="text-muted">下次运行 · 演示时钟</span>
                <b className="font-medium text-accent">
                  {nextOccurrence(plan)}
                </b>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-border bg-[#fafbf7] px-5 py-3">
              <Button
                variant="outline"
                size="sm"
                onPress={() => open({ type: "schedule-edit", id: plan.id })}
              >
                编辑计划
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-accent"
                onPress={() =>
                  open({
                    type: "confirm-launch",
                    ids: plan.sourceIds,
                    scheduleId: plan.id,
                  })
                }
              >
                <Play size={13} />
                模拟立即触发
              </Button>
              <Chip className="ml-auto text-[10px]" size="sm" variant="soft">
                重叠：跳过
              </Chip>
            </div>
          </Panel>
        ))}
      </div>
      <div className="mt-6">
        <Note>
          暂停只影响未来触发，不取消在途任务。时间基于固定演示时钟 2026-09-05
          17:40（上海）。新采集不等于重试旧 Review。
        </Note>
      </div>
    </>
  );
}

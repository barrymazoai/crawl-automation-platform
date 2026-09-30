import { useState } from "react";
import { Button, Form } from "@heroui/react";
import {
  frequencyLabel,
  saveSchedule,
  ZONES,
  type Schedule,
} from "../data/model";
import { useDemo } from "../store";
import { ChannelChip, Check, Field, Note, SelectField } from "../ui";
import { ErrorText, Shell, errorMessage } from "./Shell";

export function ScheduleEditor({ id }: { id?: string }) {
  const { state, mutate, close, notify } = useDemo(),
    current = state.schedules.find((s) => s.id === id);
  const [name, setName] = useState(current?.name || ""),
    [time, setTime] = useState(current?.time || "09:00");
  const [frequency, setFrequency] = useState<Schedule["frequency"]>(
    current?.frequency || "daily",
  );
  const [zone, setZone] = useState<Schedule["zone"]>(
    current?.zone || "Asia/Shanghai",
  );
  const [selected, setSelected] = useState(current?.sourceIds || []),
    [error, setError] = useState("");
  return (
    <Shell
      title={current ? "编辑定时计划" : "新建定时计划"}
      description="配置由业务界面管理；正式触发由 Temporal 承担。"
      footer={
        <>
          <Button variant="outline" onPress={close}>
            取消
          </Button>
          <Button form="schedule-editor" type="submit">
            保存计划
          </Button>
        </>
      }
    >
      <Form
        id="schedule-editor"
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            mutate((s) =>
              saveSchedule(
                s,
                { name, time, frequency, zone, sourceIds: selected },
                id,
              ),
            );
            close();
            notify("计划已保存到本地 Demo，没有启用真实定时调度。");
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        <ErrorText value={error} />
        <Field
          label="计划名称"
          value={name}
          onChange={setName}
          required
          placeholder="例如：核心品牌 · 每日更新"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="重复频率"
            value={frequency}
            onChange={(value) => setFrequency(value as Schedule["frequency"])}
            options={(["daily", "weekdays", "weekly"] as const).map((f) => ({
              id: f,
              label: frequencyLabel(f),
            }))}
          />
          <Field
            label="执行时间"
            type="time"
            value={time}
            onChange={setTime}
            required
          />
        </div>
        <SelectField
          label="时区"
          value={zone}
          onChange={(value) => setZone(value as Schedule["zone"])}
          options={ZONES.map((z) => ({ id: z, label: z }))}
        />
        <fieldset>
          <legend className="mb-3 text-xs font-medium">
            抓取来源（至少选择一个）
          </legend>
          <div className="max-h-48 divide-y divide-border overflow-y-auto rounded-xl border border-border">
            {state.sources.map((src) => (
              <div key={src.id} className="flex items-center gap-3 px-3 py-2.5">
                <Check
                  label={`${state.brands.find((b) => b.id === src.brandId)!.name} ${src.channel}`}
                  checked={selected.includes(src.id)}
                  disabled={!src.enabled && !selected.includes(src.id)}
                  onChange={(checked) =>
                    setSelected((prev) =>
                      checked
                        ? [...new Set([...prev, src.id])]
                        : prev.filter((id) => id !== src.id),
                    )
                  }
                />
                <span className="min-w-0 flex-1 text-xs">
                  {state.brands.find((b) => b.id === src.brandId)!.name}
                </span>
                {!src.enabled && (
                  <span className="text-[10px] text-muted">已停用</span>
                )}
                <ChannelChip channel={src.channel} />
              </div>
            ))}
          </div>
        </fieldset>
        <Note>
          同一来源重叠时跳过；不补跑历史计划、不重试旧
          Review。这里只模拟配置，不会到点执行。
        </Note>
      </Form>
    </Shell>
  );
}

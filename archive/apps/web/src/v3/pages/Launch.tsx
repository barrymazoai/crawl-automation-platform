import { useEffect, useState } from "react";
import { Button, Chip } from "@heroui/react";
import { Play } from "lucide-react";
import { CHANNELS, busy } from "../data/model";
import { useDemo } from "../store";
import {
  BrandAvatar,
  ChannelChip,
  Check,
  Empty,
  Kv,
  Note,
  PageHead,
  Panel,
  SearchInput,
  SelectField,
  Status,
} from "../ui";

export function Launch() {
  const { state, open, brandScope, setBrandScope } = useDemo();
  const [search, setSearch] = useState(
    () => state.brands.find((b) => b.id === brandScope)?.name || "",
  );
  const [channel, setChannel] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    if (brandScope) {
      setSearch(state.brands.find((b) => b.id === brandScope)?.name || "");
      setBrandScope("");
    }
  }, [brandScope, setBrandScope, state.brands]);
  const rows = state.sources.filter(
    (s) =>
      state.brands
        .find((b) => b.id === s.brandId)!
        .name.toLowerCase()
        .includes(search.toLowerCase()) &&
      (channel === "all" || s.channel === channel),
  );
  const countBrands = new Set(
    state.sources.filter((s) => selected.includes(s.id)).map((s) => s.brandId),
  ).size;
  return (
    <>
      <PageHead
        title="下一轮，从哪些 Brand 开始？"
        description="选择具体抓取来源，一次发起；每个来源独立执行，每个产品持续推进。"
        eyebrow="NEW COLLECTION"
      />
      <div className="mb-5 flex items-center gap-3 text-[11px] text-muted">
        <Chip size="sm" variant="soft" color="success">
          1
        </Chip>
        选择来源
        <span className="h-px w-12 bg-border" />
        <Chip size="sm" variant="soft" color="success">
          2
        </Chip>
        确认范围
        <span className="h-px w-12 bg-border" />
        独立执行
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[1.8fr_1fr]">
        <Panel>
          <div className="flex flex-wrap gap-3 border-b border-border p-4">
            <SearchInput
              label="搜索抓取品牌"
              value={search}
              onChange={setSearch}
              placeholder="搜索要采集的 Brand…"
            />
            <SelectField
              compact
              label="抓取渠道"
              value={channel}
              onChange={setChannel}
              options={[
                { id: "all", label: "全部渠道" },
                ...CHANNELS.map((c) => ({ id: c, label: c })),
              ]}
            />
            <Button
              size="sm"
              variant="ghost"
              className="text-xs text-accent"
              onPress={() =>
                setSelected([
                  ...new Set([
                    ...selected,
                    ...rows
                      .filter((s) => s.enabled && !busy(state, s.id))
                      .map((s) => s.id),
                  ]),
                ])
              }
            >
              选择当前可用
            </Button>
          </div>
          <div className="divide-y divide-border">
            {rows.map((src) => {
              const b = state.brands.find((b) => b.id === src.brandId)!,
                occupied = busy(state, src.id);
              return (
                <div
                  key={src.id}
                  className={`flex items-center gap-3 px-4 py-4 sm:px-5 ${selected.includes(src.id) ? "bg-[#f1f6e9]" : ""} ${!src.enabled || occupied ? "opacity-60" : ""}`}
                >
                  <Check
                    label={`选择 ${b.name} ${src.channel}`}
                    checked={selected.includes(src.id)}
                    disabled={!src.enabled || occupied}
                    onChange={(checked) =>
                      setSelected((prev) =>
                        checked
                          ? [...new Set([...prev, src.id])]
                          : prev.filter((id) => id !== src.id),
                      )
                    }
                  />
                  <div className="hidden sm:block">
                    <BrandAvatar brand={b} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold">
                      {b.name}{" "}
                      <span className="font-normal text-muted">
                        / {src.channel}
                      </span>
                    </p>
                    <p className="mt-1.5 break-all text-[10px] text-muted">
                      {src.url}
                    </p>
                  </div>
                  {occupied ? (
                    <Status value="running" />
                  ) : !src.enabled ? (
                    <Chip size="sm">已停用</Chip>
                  ) : (
                    <ChannelChip channel={src.channel} />
                  )}
                </div>
              );
            })}
            {!rows.length && (
              <Empty
                title="没有匹配的来源"
                description="可以先到 Brand 管理里添加入口。"
              />
            )}
          </div>
        </Panel>
        <Panel
          title="本次采集范围"
          action={
            <Chip size="sm" variant="soft">
              仅演示
            </Chip>
          }
          className="xl:sticky xl:top-5"
        >
          <div className="p-5">
            <p className="mb-5 text-5xl font-medium tracking-tighter text-accent">
              {selected.length}
              <span className="ml-2 text-xs font-normal tracking-normal text-muted">
                个抓取来源
              </span>
            </p>
            <Kv label="覆盖 Brand">{countBrands} 个</Kv>
            <Kv label="触发方式">手动 · 新一轮采集</Kv>
            <Kv label="公司未关联">允许采集，数据先保存</Kv>
            <Kv label="同一来源重叠">跳过，不重复排队</Kv>
            <Kv label="历史 Review">保留，不自动重跑</Kv>
            <div className="my-5">
              <Note>不会调用 Temporal、网站、OCR 或生产数据库。</Note>
            </div>
            <Button
              fullWidth
              isDisabled={!selected.length}
              onPress={() => open({ type: "confirm-launch", ids: selected })}
            >
              <Play size={15} />
              确认发起 · {selected.length} 个来源
            </Button>
            {selected.length > 0 && (
              <Button
                variant="ghost"
                fullWidth
                size="sm"
                className="mt-2 text-xs"
                onPress={() => setSelected([])}
              >
                清空选择
              </Button>
            )}
            <p className="mt-3 text-[11px] leading-6 text-muted">
              运行使用提交时的配置快照。模拟任务只在手动“推进演示”时改变。
            </p>
          </div>
        </Panel>
      </div>
    </>
  );
}

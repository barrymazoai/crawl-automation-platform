import { useState } from "react";
import { Button, Chip, Tabs } from "@heroui/react";
import { ArrowLeft, ArrowRight, Check, Minus } from "lucide-react";
import { CHANNELS, metrics, type ResultFilter } from "../data/model";
import { useDemo } from "../store";
import {
  ChannelChip,
  DataTable,
  Note,
  PageHead,
  Panel,
  SearchInput,
  SelectField,
  Status,
} from "../ui";

export function Results() {
  const { state, open, resultFilter: filter, setResultFilter } = useDemo();
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("all");
  const [page, setPage] = useState(0);
  const m = metrics(state);
  const filters: { id: ResultFilter; name: string; count: number }[] = [
    { id: "all", name: "全部记录", count: state.products.length },
    { id: "saved", name: "采集已保存", count: m.saved },
    { id: "unmapped", name: "待关联公司", count: m.unmapped },
    { id: "synced", name: "已同步正式库", count: m.synced },
    { id: "review", name: "Review", count: m.review },
  ];
  const rows = state.products.filter(
    (p) =>
      (filter === "all" ||
        (filter === "saved" && p.status !== "review") ||
        p.status === filter) &&
      `${p.name} ${state.brands.find((b) => b.id === p.brandId)!.name} ${p.id}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (channel === "all" ||
        state.sources.find((s) => s.id === p.sourceId)!.channel === channel),
  );
  const pages = Math.max(1, Math.ceil(rows.length / 8)),
    current = Math.min(page, pages - 1);
  const content = (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
        <SearchInput
          label="搜索采集结果"
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(0);
          }}
        />
        <SelectField
          compact
          label="结果渠道"
          value={channel}
          onChange={(value) => {
            setChannel(value);
            setPage(0);
          }}
          options={[
            { id: "all", label: "全部渠道" },
            ...CHANNELS.map((c) => ({ id: c, label: c })),
          ]}
        />
        <span className="ml-auto text-[11px] text-muted">
          只读结果 · 完整证据
        </span>
      </div>
      <DataTable
        label="产品采集结果"
        rows={rows.slice(current * 8, current * 8 + 8)}
        columns={[
          {
            id: "product",
            title: "产品 / 本次观察",
            render: (p) => (
              <div className="min-w-44">
                <p className="font-medium">{p.name}</p>
                <p className="mt-1 text-[10px] text-muted">
                  {p.variant} · {p.id.slice(0, 16)}
                </p>
              </div>
            ),
          },
          {
            id: "brand",
            title: "Brand",
            render: (p) => (
              <span className="whitespace-nowrap">
                {state.brands.find((b) => b.id === p.brandId)!.name}
              </span>
            ),
          },
          {
            id: "channel",
            title: "来源",
            render: (p) => (
              <ChannelChip
                channel={
                  state.sources.find((s) => s.id === p.sourceId)!.channel
                }
              />
            ),
          },
          {
            id: "formula",
            title: "Formula",
            render: (p) => (
              <span
                className={`flex items-center gap-1 whitespace-nowrap ${p.formula ? "text-[#648248]" : "text-amber-700"}`}
              >
                {p.formula ? <Check size={12} /> : <Minus size={12} />}{" "}
                {p.formula ? "已获取" : "缺失"}
              </span>
            ),
          },
          {
            id: "ingredients",
            title: "Ingredients",
            render: (p) => (
              <span
                className={`flex items-center gap-1 whitespace-nowrap ${p.ingredients ? "text-[#648248]" : "text-amber-700"}`}
              >
                {p.ingredients ? <Check size={12} /> : <Minus size={12} />}{" "}
                {p.ingredients ? "已获取" : "缺失"}
              </span>
            ),
          },
          {
            id: "status",
            title: "业务结果",
            render: (p) => <Status value={p.status} />,
          },
          {
            id: "action",
            title: "操作",
            render: (p) => (
              <Button
                variant="outline"
                size="sm"
                onPress={() => open({ type: "product", id: p.id })}
              >
                查看
              </Button>
            ),
          },
        ]}
      />
      <div className="flex items-center justify-between gap-3 px-5 py-3 text-[11px] text-muted">
        <span>共 {rows.length} 条 · 每页 8 条</span>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label="上一页"
            isDisabled={current === 0}
            onPress={() => setPage(current - 1)}
          >
            <ArrowLeft size={14} />
          </Button>
          <span>
            {current + 1} / {pages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label="下一页"
            isDisabled={current + 1 >= pages}
            onPress={() => setPage(current + 1)}
          >
            <ArrowRight size={14} />
          </Button>
        </div>
      </div>
    </>
  );
  return (
    <>
      <PageHead
        title="数据留下，问题分开。"
        description="采集结果、公司关联与正式库同步分别记录。完成一个流程，不一定代表成功入库。"
        eyebrow="DATA & REVIEW"
      />
      <Panel>
        <Tabs
          selectedKey={filter}
          onSelectionChange={(key) => {
            setResultFilter(key as ResultFilter);
            setPage(0);
          }}
          variant="secondary"
          className="gap-0"
        >
          <Tabs.ListContainer className="border-b border-border px-4 py-2">
            <Tabs.List aria-label="结果分类">
              {filters.map((item) => (
                <Tabs.Tab
                  key={item.id}
                  id={item.id}
                  className="shrink-0 gap-2 whitespace-nowrap px-3 text-xs"
                >
                  {item.name}
                  <Chip size="sm" variant="soft" className="text-[10px]">
                    {item.count}
                  </Chip>
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
          {filters.map((item) => (
            <Tabs.Panel key={item.id} id={item.id} className="p-0">
              {filter === item.id && content}
            </Tabs.Panel>
          ))}
        </Tabs>
      </Panel>
      <div className="mt-5">
        <Note warning={filter === "review"}>
          {filter === "review"
            ? "Review 只保留分类、候选数据和证据；不提供自动修复或“全部重试”。"
            : "Formula + Ingredients 是数据完整性门槛。公司待关联的产品已保存在采集库，不会因没有 companyId 丢失。"}
        </Note>
      </div>
    </>
  );
}

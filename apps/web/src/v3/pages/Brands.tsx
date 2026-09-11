import { useState } from "react";
import { Button } from "@heroui/react";
import { Plus, Upload } from "lucide-react";
import { CHANNELS, busy } from "../data/model";
import { useDemo } from "../store";
import {
  BrandAvatar,
  ChannelChip,
  DataTable,
  Note,
  PageHead,
  Panel,
  SearchInput,
  SelectField,
  Status,
  TextButton,
} from "../ui";

export function Brands() {
  const { state, open } = useDemo();
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("all");
  const [mapping, setMapping] = useState("all");
  const rows = state.brands.filter(
    (b) =>
      `${b.name} ${b.company} ${b.externalId}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (mapping === "all" ||
        (mapping === "linked" ? Boolean(b.company) : !b.company)) &&
      (channel === "all" ||
        state.sources.some((s) => s.brandId === b.id && s.channel === channel)),
  );
  return (
    <>
      <PageHead
        title="每个 Brand，都有自己的档案。"
        description="先建立品牌身份，再连接各个抓取来源。公司关联可以稍后完成。"
        eyebrow="BRANDS"
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              onPress={() => open({ type: "import" })}
            >
              <Upload size={14} />
              导入 Brand
            </Button>
            <Button size="sm" onPress={() => open({ type: "brand-edit" })}>
              <Plus size={15} />
              新建 Brand
            </Button>
          </>
        }
      />
      <div className="mb-5">
        <Note>
          Brand 使用独立的 V3
          新业务数据库。未关联正式公司，也可以正常采集并保存数据；此入口仍为模拟演示。
        </Note>
      </div>
      <Panel>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
          <SearchInput
            label="搜索 Brand"
            value={search}
            onChange={setSearch}
            placeholder="搜索品牌、公司或来源 ID…"
          />
          <SelectField
            compact
            label="筛选渠道"
            value={channel}
            onChange={setChannel}
            options={[
              { id: "all", label: "全部渠道" },
              ...CHANNELS.map((c) => ({ id: c, label: c })),
            ]}
          />
          <SelectField
            compact
            label="公司关联"
            value={mapping}
            onChange={setMapping}
            options={[
              { id: "all", label: "全部关联状态" },
              { id: "linked", label: "已关联公司" },
              { id: "unlinked", label: "待关联公司" },
            ]}
          />
          <span className="ml-auto text-xs text-muted">
            {rows.length} 个 Brand
          </span>
        </div>
        <DataTable
          label="Brand 档案"
          rows={rows}
          columns={[
            {
              id: "name",
              title: "Brand / 品牌",
              render: (b) => (
                <div className="flex items-center gap-3">
                  <BrandAvatar brand={b} />
                  <div>
                    <p className="whitespace-nowrap font-semibold">{b.name}</p>
                    <p className="mt-1 font-mono text-[10px] text-muted">
                      {b.externalId || "手工新建"}
                    </p>
                  </div>
                </div>
              ),
            },
            {
              id: "sources",
              title: "抓取来源",
              render: (b) => {
                const ss = state.sources.filter((s) => s.brandId === b.id);
                return (
                  <>
                    <div className="flex flex-wrap gap-1">
                      {[...new Set(ss.map((s) => s.channel))].map((c) => (
                        <ChannelChip key={c} channel={c} />
                      ))}
                      {!ss.length && (
                        <span className="text-muted">待添加来源</span>
                      )}
                    </div>
                    <p className="mt-1.5 text-[10px] text-muted">
                      {ss.length} 个入口 · {ss.filter((s) => s.enabled).length}{" "}
                      个启用
                    </p>
                  </>
                );
              },
            },
            {
              id: "company",
              title: "公司关联",
              render: (b) =>
                b.company ? (
                  <div className="min-w-28">
                    {b.company}
                    <p className="mt-1 text-[10px] text-muted">
                      已确认 · 演示映射
                    </p>
                  </div>
                ) : (
                  <Status value="unmapped" />
                ),
            },
            {
              id: "products",
              title: "已保存产品",
              render: (b) => (
                <span>
                  {
                    state.products.filter(
                      (p) => p.brandId === b.id && p.status !== "review",
                    ).length
                  }{" "}
                  <span className="text-muted">个</span>
                </span>
              ),
            },
            {
              id: "state",
              title: "采集状态",
              render: (b) =>
                state.sources.some(
                  (s) => s.brandId === b.id && busy(state, s.id),
                ) ? (
                  <Status value="running" />
                ) : (
                  <span className="text-muted">当前空闲</span>
                ),
            },
            {
              id: "action",
              title: "操作",
              render: (b) => (
                <TextButton
                  onPress={() => open({ type: "brand-detail", id: b.id })}
                >
                  管理
                </TextButton>
              ),
            },
          ]}
        />
        <div className="flex justify-between gap-3 px-5 py-4 text-[11px] text-muted">
          <span>独立 Brand 身份 · {state.brands.length} 条演示记录</span>
          <span>导入不会自动采集</span>
        </div>
      </Panel>
    </>
  );
}

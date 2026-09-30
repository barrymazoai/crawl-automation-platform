import { useState } from "react";
import { Button, Form, Label, TextArea, TextField } from "@heroui/react";
import { Play, Plus } from "lucide-react";
import {
  CHANNELS,
  importBrands,
  previewImport,
  saveBrand,
  saveSource,
  busy,
  type Channel,
  type ImportRow,
} from "../data/model";
import { useDemo } from "../store";
import {
  BrandAvatar,
  ChannelChip,
  DataTable,
  Empty,
  Field,
  Kv,
  Note,
  SelectField,
  Status,
  Toggle,
} from "../ui";
import { ErrorText, Shell, errorMessage } from "./Shell";

export function BrandDetail({ id }: { id: string }) {
  const { state, open, close, mutate, setBrandScope, navigate } = useDemo();
  const b = state.brands.find((b) => b.id === id)!;
  const sources = state.sources.filter((s) => s.brandId === id);
  return (
    <Shell
      title={b.name}
      description="Brand 档案 · 独立身份，不依赖正式公司 ID"
      footer={
        <Button
          onPress={() => {
            setBrandScope(id);
            close();
            navigate("launch");
          }}
        >
          <Play size={15} />
          为这个 Brand 发起采集
        </Button>
      }
    >
      <div className="flex items-center gap-3">
        <BrandAvatar brand={b} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{b.name}</p>
          <p className="mt-1 break-all font-mono text-[10px] text-muted">
            {b.id}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onPress={() => open({ type: "brand-edit", id })}
        >
          编辑资料
        </Button>
      </div>
      <div>
        <Kv label="正式公司关联">{b.company || <Status value="unmapped" />}</Kv>
        <Kv label="已保存产品">
          {
            state.products.filter(
              (p) => p.brandId === id && p.status !== "review",
            ).length
          }{" "}
          个
        </Kv>
        <Kv label="导入来源 ID">{b.externalId || "手工新建"}</Kv>
        {b.note && <p className="mt-3 text-xs text-muted">{b.note}</p>}
      </div>
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">抓取来源 · {sources.length}</h3>
          <Button
            size="sm"
            variant="outline"
            onPress={() => open({ type: "source-edit", brandId: id })}
          >
            <Plus size={13} />
            添加来源
          </Button>
        </div>
        <div className="space-y-3">
          {sources.map((src) => (
            <div key={src.id} className="rounded-xl border border-border p-4">
              <div className="flex items-center gap-2">
                <ChannelChip channel={src.channel} />
                <span className="flex-1 text-xs text-muted">{src.region}</span>
                <Toggle
                  label={`启用 ${src.channel} 来源 ${src.id}`}
                  value={src.enabled}
                  onChange={(enabled) =>
                    mutate((s) => {
                      s.sources.find((item) => item.id === src.id)!.enabled =
                        enabled;
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    open({ type: "source-edit", id: src.id, brandId: id })
                  }
                >
                  编辑
                </Button>
              </div>
              <p className="mt-2 break-all text-xs text-muted">{src.url}</p>
              {busy(state, src.id) && (
                <p className="mt-2 text-[11px] text-accent">
                  正在采集；修改配置只影响后续运行。
                </p>
              )}
            </div>
          ))}
          {!sources.length && (
            <Empty
              title="还没有抓取来源"
              description="添加渠道店铺或 DTC 官网入口。"
            />
          )}
        </div>
      </section>
      <Note>
        公司关联只修改演示资料，不自动迁移或同步历史产品。没有公司关联也可以采集。
      </Note>
    </Shell>
  );
}
export function BrandEditor({ id }: { id?: string }) {
  const { state, mutate, open, close, notify } = useDemo();
  const b = state.brands.find((b) => b.id === id);
  const [name, setName] = useState(b?.name || ""),
    [company, setCompany] = useState(b?.company || ""),
    [note, setNote] = useState(b?.note || ""),
    [error, setError] = useState("");
  return (
    <Shell
      title={b ? "编辑 Brand" : "新建 Brand"}
      description="建立独立身份；公司关联可以留空。"
      footer={
        <>
          <Button variant="outline" onPress={close}>
            取消
          </Button>
          <Button form="brand-editor" type="submit">
            保存 Brand
          </Button>
        </>
      }
    >
      <Form
        id="brand-editor"
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const brandId = mutate((s) =>
              saveBrand(s, { name, company, note }, id),
            );
            notify("Brand 已保存到本地演示，没有创建正式公司。");
            open({ type: "brand-detail", id: brandId });
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        <ErrorText value={error} />
        <Field
          label="Brand 名称"
          name="brandName"
          value={name}
          onChange={setName}
          required
          placeholder="例如：Thorne"
        />
        <Field
          label="正式公司关联（可选）"
          value={company}
          onChange={setCompany}
          placeholder="留空也可以采集"
          help="Demo 用文本模拟确认过的映射；正式版应选择可信公司 ID。"
        />
        <TextField value={note} onChange={setNote}>
          <Label>备注</Label>
          <TextArea
            maxLength={500}
            placeholder="品牌别名、来源说明…"
            className="min-h-24 text-sm"
          />
        </TextField>
      </Form>
    </Shell>
  );
}
export function SourceEditor({
  brandId,
  id,
}: {
  brandId: string;
  id?: string;
}) {
  const { state, mutate, open, close, notify } = useDemo();
  const source = state.sources.find((s) => s.id === id);
  const [channel, setChannel] = useState<Channel>(source?.channel || "Amazon"),
    [url, setUrl] = useState(source?.url || ""),
    [region, setRegion] = useState(source?.region || "US"),
    [error, setError] = useState("");
  return (
    <Shell
      title={source ? "编辑抓取来源" : "添加抓取来源"}
      description={`${state.brands.find((b) => b.id === brandId)!.name} · 同一渠道允许多个入口`}
      footer={
        <>
          <Button variant="outline" onPress={close}>
            取消
          </Button>
          <Button form="source-editor" type="submit">
            保存来源
          </Button>
        </>
      }
    >
      <Form
        id="source-editor"
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            mutate((s) => saveSource(s, { brandId, channel, url, region }, id));
            notify("来源已保存，没有访问目标网站。");
            open({ type: "brand-detail", id: brandId });
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        <ErrorText value={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="渠道类型"
            value={channel}
            onChange={(value) => setChannel(value as Channel)}
            options={CHANNELS.map((c) => ({ id: c, label: c }))}
          />
          <Field
            label="站点 / 地区"
            value={region}
            onChange={setRegion}
            required
          />
        </div>
        <Field
          label="品牌店铺 / 官网入口 URL"
          type="url"
          value={url}
          onChange={setUrl}
          required
          placeholder="https://…"
          help="明确关联到这个 Brand；不代表入口里的任意商品都属于它。"
        />
        <Note>只保存配置，不访问网站，也不验证链接真实性。</Note>
      </Form>
    </Shell>
  );
}
const importExample = JSON.stringify(
  [
    { externalId: "demo:thorne", name: "Thorne" },
    {
      externalId: "catalog:pure",
      name: "Pure Encapsulations",
      sources: [{ channel: "DTC", url: "https://pure.example/products" }],
    },
  ],
  null,
  2,
);
export function ImportDialog() {
  const { state, mutate, close, navigate, notify } = useDemo();
  const [text, setText] = useState(""),
    [preview, setPreview] = useState<ImportRow[] | null>(null),
    [error, setError] = useState("");
  const change = (value: string) => {
    setText(value);
    setPreview(null);
    setError("");
  };
  return (
    <Shell
      title="导入 Brand"
      description="JSON 导入演示 · 先预览，再确认，不自动采集。"
      footer={
        <>
          <Button
            variant="outline"
            onPress={() => {
              try {
                setPreview(previewImport(state, text));
                setError("");
              } catch (e) {
                setPreview(null);
                setError(errorMessage(e));
              }
            }}
          >
            预览导入
          </Button>
          <Button
            isDisabled={!preview?.some((row) => row.action === "create")}
            onPress={() => {
              if (!preview) return;
              const count = mutate((s) => importBrands(s, preview));
              close();
              navigate("brands");
              notify(`已导入 ${count} 个 Brand，没有覆盖已有资料或启动采集。`);
            }}
          >
            确认导入
          </Button>
        </>
      }
    >
      <ErrorText value={error} />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">最多 200 条 · 使用 externalId 去重</p>
        <Button variant="ghost" size="sm" onPress={() => change(importExample)}>
          填入示例
        </Button>
      </div>
      <TextField value={text} onChange={change}>
        <Label>Brand 数据</Label>
        <TextArea
          className="min-h-56 font-mono text-xs"
          placeholder='[{"externalId":"catalog:001","name":"品牌名称"}]'
        />
      </TextField>
      <p className="text-xs leading-6 text-muted">
        同一 externalId 跳过并保留手工修改。同名不同 ID 标记冲突，不自动合并。
      </p>
      {preview && (
        <div className="overflow-hidden rounded-xl border border-border">
          <DataTable
            label="导入预览"
            rows={preview.map((row) => ({ ...row, id: row.externalId }))}
            columns={[
              { id: "name", title: "Brand", render: (row) => row.name },
              {
                id: "state",
                title: "预览结果",
                render: (row) => (
                  <Status
                    value={
                      row.action === "create"
                        ? "saved"
                        : row.action === "skip"
                          ? "queued"
                          : "review"
                    }
                    label={
                      {
                        create: "将新建",
                        skip: "已存在 · 跳过",
                        conflict: "同名冲突 · 跳过",
                      }[row.action]
                    }
                  />
                ),
              },
            ]}
          />
        </div>
      )}
    </Shell>
  );
}

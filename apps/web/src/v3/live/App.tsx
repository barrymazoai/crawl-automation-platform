import { useCallback, useEffect, useRef, useState } from "react";
import { brandLocation, selectedBrandId } from "./location";
import { CollectionPanel } from "./CollectionPanel";
import { SchedulesPanel } from "./SchedulesPanel";
import {
  Button,
  Chip,
  Form,
  Input,
  Label,
  Modal,
  TextArea,
  TextField,
} from "@heroui/react";
import {
  CalendarClock,
  Database,
  Layers3,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  BrandAvatar,
  ChannelChip,
  DataTable,
  Empty,
  Note,
  PageHead,
  Panel,
  SearchInput,
  SelectField,
} from "../ui";
import {
  ApiFailure,
  makePending,
  pendingStorageKey,
  readPending,
  request,
  sendPending,
  type Pending,
} from "./api";
import {
  Brand as BrandSchema,
  Source as SourceSchema,
  Summary as SummarySchema,
  CreateBrand,
  UpdateBrand,
  CreateSource,
  UpdateSource,
  pageSchema,
  type Brand,
  type Source,
  type Page,
} from "@crawl-automation/v3-contracts";

const channels = [
  { id: "amazon", label: "Amazon" },
  { id: "gnc", label: "GNC" },
  { id: "swanson", label: "Swanson" },
  { id: "dtc", label: "DTC" },
] as const;
const channelLabels = {
  amazon: "Amazon",
  gnc: "GNC",
  swanson: "Swanson",
  dtc: "DTC",
} as const;
type Editor =
  | { kind: "brand"; record?: Brand }
  | { kind: "source"; brandId: string; record?: Source };
type Snapshot = {
  summary: { brands: number; sources: number; enabledSources: number };
  brands: Page<Brand>;
  sources: Page<Source> | null;
};
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "请求失败，请检查服务。";

export function LiveApp() {
  const [selected, setSelected] = useState<Brand | null>(null);
  const [collectionSource, setCollectionSource] = useState<Source | null>(null);
  const [scheduleSource, setScheduleSource] = useState<Source | null>(null);
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [sourceOffset, setSourceOffset] = useState(0);
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [storageError, setStorageError] = useState("");
  const operation = useRef(false);
  const readSequence = useRef(0);
  const pendingRef = useRef<Pending | null>(null);
  const locationSequence = useRef(0);
  useEffect(() => {
    const loadLocation = async () => {
      const current = ++locationSequence.current;
      try {
        const id = selectedBrandId(new URL(window.location.href));
        const brand = id ? await request(`/brands/${id}`, BrandSchema) : null;
        if (current === locationSequence.current) { setSelected(brand); setSourceOffset(0); }
      } catch {
        if (current === locationSequence.current) { setSelected(null); setNotice("链接中的品牌无效或暂时无法读取，请从列表重新选择。"); }
      }
    };
    void loadLocation();
    window.addEventListener("popstate", loadLocation);
    return () => { locationSequence.current++; window.removeEventListener("popstate", loadLocation); };
  }, []);
  useEffect(() => {
    try {
      const saved = readPending(sessionStorage);
      pendingRef.current = saved;
      setPending(saved);
    } catch {
      setStorageError(
        "浏览器请求记录不可读取，已暂停写操作。请保留当前页面，检查浏览器存储；不要直接重复提交。",
      );
    }
  }, []);
  const reload = useCallback(async () => {
    const sequence = ++readSequence.current;
    setLoading(true);
    setError("");
    try {
      const [summary, brands, sources] = await Promise.all([
        request("/summary", SummarySchema),
        request(
          `/brands?limit=25&offset=${offset}&q=${encodeURIComponent(q)}`,
          pageSchema(BrandSchema),
        ),
        selected
          ? request(
              `/brands/${selected.id}/sources?limit=25&offset=${sourceOffset}`,
              pageSchema(SourceSchema),
            )
          : Promise.resolve(null),
      ]);
      if (sequence === readSequence.current)
        setData({ summary, brands, sources });
    } catch (e) {
      if (sequence === readSequence.current) {
        setError(messageOf(e));
        setData(null);
      }
    } finally {
      if (sequence === readSequence.current) setLoading(false);
    }
  }, [q, offset, sourceOffset, selected?.id]);
  useEffect(() => {
    void reload();
    return () => {
      readSequence.current++;
    };
  }, [reload]);
  const clearPending = () => {
    sessionStorage.removeItem(pendingStorageKey);
    pendingRef.current = null;
    setPending(null);
  };
  const execute = async (intent: Pending) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setNotice("");
    try {
      await sendPending(intent);
      clearPending();
      setEditor(null);
      setNotice("已保存到本地 V3 数据库。未触发采集。");
      await reload();
    } catch (e) {
      setNotice(messageOf(e));
      if (e instanceof ApiFailure && !e.uncertain) {
        try {
          clearPending();
        } catch {
          setStorageError("无法清除已确认的请求记录，请检查浏览器存储。");
        }
      }
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };
  const submit = (intent: Pending) => {
    if (pendingRef.current || operation.current || storageError) return;
    try {
      sessionStorage.setItem(pendingStorageKey, JSON.stringify(intent));
    } catch {
      setStorageError(
        "无法保存请求凭证，本次没有发送。请允许浏览器会话存储后刷新。",
      );
      return;
    }
    pendingRef.current = intent;
    setPending(intent);
    void execute(intent);
  };
  const blocked = busy || !!pending || !!storageError;
  const select = (brand: Brand) => {
    locationSequence.current++;
    window.history.pushState(null, "", brandLocation(new URL(window.location.href), brand.id));
    setSelected(brand);
    setSourceOffset(0);
  };
  const openEditor = (value: Editor) => { setNotice(""); setEditor(value); };
  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-[#dfe6d7] bg-[#edf2e8] px-4 py-7 md:flex">
        <div className="flex items-center gap-3 px-2">
          <span className="grid size-9 place-items-center rounded-xl bg-accent text-white">
            <Layers3 size={20} />
          </span>
          <div>
            <p className="text-lg font-bold">
              crawler<span className="text-muted">.</span>
            </p>
            <p className="text-[8px] tracking-widest text-muted">
              COLLECTION WORKSPACE
            </p>
          </div>
        </div>
        <div className="my-8 rounded-xl border border-[#dce5d4] bg-[#f7faf2] p-4">
          <p className="text-xs font-semibold">V3 · 本地开发空间</p>
          <p className="mt-2 text-[10px] text-muted">独立数据库 · 真实配置</p>
        </div>
        <nav aria-label="主要导航" className="space-y-2">
          <p className="mb-3 px-3 text-[9px] tracking-widest text-muted">
            WORKSPACE
          </p>
          <a href="/v3-live.html?view=dashboard" className="flex items-center gap-3 rounded-xl px-3 py-3 text-xs text-muted hover:bg-[#dce8d2]"><Database size={17}/>业务概览</a>
          <div
            aria-current="page"
            className="flex items-center gap-3 rounded-xl bg-[#dce8d2] px-3 py-3 text-xs font-semibold"
          >
            <Layers3 size={17} />
            Brand 管理
          </div>
          <a href="#collection" className="flex items-center gap-3 rounded-xl px-3 py-3 text-xs text-muted hover:bg-[#dce8d2]">
            <Play size={17} />手动提交与交接
          </a>
          <a href="#schedules" className="flex items-center gap-3 rounded-xl px-3 py-3 text-xs text-muted hover:bg-[#dce8d2]"><CalendarClock size={17}/>定时计划</a>
          <a href="/v3-live.html?view=reviews" className="flex items-center gap-3 px-3 py-3 text-xs text-muted"><Database size={17}/>只读 Review</a>
        </nav>
        <div className="mt-auto rounded-xl border border-[#dce5d4] p-3 text-[10px] leading-6 text-muted">
          <p className="flex items-center gap-2 font-semibold text-accent">
            <ShieldCheck size={14} />
            独立的数据边界
          </p>
          只操作独立 V3 数据库。
          <br />
          不读取旧库；采集由明确提交触发。
          <br />原 Demo 保留在 4179 端口。
        </div>
      </aside>
      <div className="min-w-0">
        <header className="flex h-16 items-center justify-between gap-2 border-b border-border bg-[#fafbf7] px-5 lg:px-8">
          <span className="text-xs text-muted">工作空间 / Brand 管理</span>
          <Chip size="sm" variant="soft" color={error ? "warning" : "success"}>
            {loading
              ? "正在连接…"
              : error
                ? "连接异常"
                : "本地 V3 数据库 · 已连接"}
          </Chip>
        </header>
        <main className="mx-auto max-w-[1510px] space-y-5 p-4 sm:p-6 lg:p-8">
          <PageHead
            title="Brand 管理"
            eyebrow="BRANDS"
            description="管理独立 V3 品牌与采集入口，提交请求并回读真实交接状态。"
            actions={
              <>
                <Button
                  variant="outline"
                  onPress={() => void reload()}
                  isDisabled={loading}
                >
                  <RefreshCw size={14} />
                  刷新
                </Button>
                <Button
                  onPress={() => openEditor({ kind: "brand" })}
                  isDisabled={blocked}
                >
                  <Plus size={15} />
                  创建 Brand
                </Button>
              </>
            }
          />
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "品牌总数", value: data?.summary.brands },
              { label: "来源总数", value: data?.summary.sources },
              { label: "已启用来源", value: data?.summary.enabledSources },
            ].map((item) => (
              <Panel key={item.label}>
                <div className="p-4 sm:p-5">
                  <p className="text-[11px] text-muted">{item.label}</p>
                  <p className="mt-3 text-2xl font-semibold">
                    {loading ? "…" : (item.value ?? "—")}
                  </p>
                </div>
              </Panel>
            ))}
          </div>
          <Note>
            品牌使用新系统自己的标识，无需匹配旧库公司。来源默认关闭；启用只是保存配置，不会自动提交采集任务。
          </Note>
          {error && (
            <div role="alert">
              <Note warning>{error}</Note>
            </div>
          )}
          {storageError && (
            <div role="alert">
              <Note warning>{storageError}</Note>
            </div>
          )}
          {notice && (
            <div
              role="status"
              className="rounded-xl border border-border bg-white p-4 text-xs leading-6"
            >
              {notice}
            </div>
          )}
          {pending && (
            <Note warning>
              <p>
                待确认请求：{pending.label} · {pending.key}
              </p>
              <p>
                已保留原始内容。即使刷新页面，也请先确认这次请求，避免重复创建。
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                isDisabled={busy}
                onPress={() => void execute(pending)}
              >
                {busy ? "正在确认…" : "确认原请求结果"}
              </Button>
            </Note>
          )}
          <Panel title="品牌目录" subtitle="每页 25 条 · 数据来自 API">
            <div className="border-b border-border p-4">
              <SearchInput
                value={q}
                onChange={(value) => {
                  setQ(value.slice(0, 100));
                  setOffset(0);
                }}
                placeholder="搜索品牌名称"
              />
            </div>
            {loading ? (
              <div role="status" className="p-8 text-center text-xs text-muted">
                正在读取数据库…
              </div>
            ) : data ? (
              <>
                <DataTable
                  label="真实品牌列表"
                  rows={data.brands.items}
                  columns={[
                    {
                      id: "name",
                      title: "品牌",
                      render: (brand) => (
                        <div className="flex items-center gap-3">
                          <BrandAvatar brand={brand} />
                          <div>
                            <p className="font-semibold">{brand.name}</p>
                            <p className="mt-1 font-mono text-[9px] text-muted">
                              {brand.id}
                            </p>
                          </div>
                        </div>
                      ),
                    },
                    {
                      id: "note",
                      title: "备注",
                      render: (brand) => (
                        <p className="max-w-xs whitespace-pre-wrap break-words">
                          {brand.note || "—"}
                        </p>
                      ),
                    },
                    {
                      id: "version",
                      title: "版本",
                      render: (brand) => `v${brand.revision}`,
                    },
                    {
                      id: "actions",
                      title: "操作",
                      render: (brand) => (
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onPress={() => select(brand)}
                          >
                            查看来源
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            isDisabled={blocked}
                            onPress={() =>
                              openEditor({ kind: "brand", record: brand })
                            }
                          >
                            编辑品牌
                          </Button>
                        </div>
                      ),
                    },
                  ]}
                />
                <Pagination
                  offset={offset}
                  more={data.brands.hasMore}
                  onChange={setOffset}
                />
              </>
            ) : (
              <Empty
                title="暂时无法读取"
                description="请检查本地 API 服务后刷新。"
              />
            )}
          </Panel>
          {selected && (
            <Panel
              title={`${data?.brands.items.find((b) => b.id === selected.id)?.name ?? selected.name} · 来源`}
              subtitle="单个品牌可配置多个渠道入口"
              action={
                <Button
                  size="sm"
                  onPress={() =>
                    openEditor({ kind: "source", brandId: selected.id })
                  }
                  isDisabled={blocked}
                >
                  <Plus size={14} />
                  添加来源
                </Button>
              }
            >
              {loading ? (
                <p className="p-6 text-xs">正在读取来源…</p>
              ) : data?.sources ? (
                <>
                  <DataTable
                    label="真实来源列表"
                    rows={data.sources.items}
                    columns={[
                      {
                        id: "channel",
                        title: "渠道",
                        render: (source) => (
                          <ChannelChip
                            channel={channelLabels[source.channel]}
                          />
                        ),
                      },
                      {
                        id: "url",
                        title: "入口链接",
                        render: (source) => (
                          <p className="max-w-sm break-all">{source.url}</p>
                        ),
                      },
                      {
                        id: "region",
                        title: "地区",
                        render: (source) => source.region,
                      },
                      {
                        id: "enabled",
                        title: "配置状态",
                        render: (source) => (
                          <Chip
                            size="sm"
                            variant="soft"
                            color={source.enabled ? "success" : "default"}
                          >
                            {source.enabled ? "已启用" : "已关闭"}
                          </Chip>
                        ),
                      },
                      {
                        id: "actions",
                        title: "操作",
                        render: (source) => (
                          <div className="flex gap-1">
                            <Button size="sm" variant="outline" onPress={() => {
                              setCollectionSource(source);
                              document.getElementById("collection")?.scrollIntoView({ behavior: "smooth" });
                            }}>选择采集</Button>
                            <Button size="sm" variant="outline" onPress={() => {
                              setScheduleSource(source);
                              document.getElementById("schedules")?.scrollIntoView({behavior:"smooth"});
                            }}>选择计划</Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              isDisabled={blocked}
                              onPress={() =>
                                openEditor({
                                  kind: "source",
                                  brandId: source.brandId,
                                  record: source,
                                })
                              }
                            >
                              编辑来源
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              isDisabled={blocked}
                              onPress={() =>
                                submit(
                                  makePending(
                                    `/brands/${source.brandId}/sources/${source.id}/enabled`,
                                    "PATCH",
                                    {
                                      enabled: !source.enabled,
                                      revision: source.revision,
                                    },
                                    `${source.enabled ? "关闭" : "启用"}来源`,
                                    "source",
                                  ),
                                )
                              }
                            >
                              {source.enabled ? "关闭" : "启用"}
                            </Button>
                          </div>
                        ),
                      },
                    ]}
                  />
                  <Pagination
                    offset={sourceOffset}
                    more={data.sources.hasMore}
                    onChange={setSourceOffset}
                  />
                </>
              ) : (
                <Empty />
              )}
            </Panel>
          )}
          <CollectionPanel source={collectionSource} configurationBlocked={blocked} />
          <SchedulesPanel source={scheduleSource} blocked={blocked} />
          <footer className="text-[10px] leading-6 text-muted">
            独立 V3 配置 · PostgreSQL 持久化 · 提交能力与交接状态以服务端回执为准
          </footer>
        </main>
      </div>
      {editor && (
        <EditorDialog
          editor={editor}
          blocked={blocked}
          notice={notice}
          onClose={() => {
            if (!busy) setEditor(null);
          }}
          onSubmit={submit}
        />
      )}
    </div>
  );
}
function Pagination({
  offset,
  more,
  onChange,
}: {
  offset: number;
  more: boolean;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-3 p-3 text-xs text-muted">
      <Button
        size="sm"
        variant="ghost"
        isDisabled={offset === 0}
        onPress={() => onChange(Math.max(0, offset - 25))}
      >
        上一页
      </Button>
      第 {offset / 25 + 1} 页
      <Button
        size="sm"
        variant="ghost"
        isDisabled={!more}
        onPress={() => onChange(offset + 25)}
      >
        下一页
      </Button>
    </div>
  );
}
function EditorDialog({
  editor,
  blocked,
  notice,
  onClose,
  onSubmit,
}: {
  editor: Editor;
  blocked: boolean;
  notice: string;
  onClose: () => void;
  onSubmit: (intent: Pending) => void;
}) {
  const [name, setName] = useState(
    editor.kind === "brand" ? (editor.record?.name ?? "") : "",
  );
  const [note, setNote] = useState(
    editor.kind === "brand" ? (editor.record?.note ?? "") : "",
  );
  const [url, setUrl] = useState(
    editor.kind === "source" ? (editor.record?.url ?? "") : "",
  );
  const [channel, setChannel] = useState(
    editor.kind === "source" ? (editor.record?.channel ?? "dtc") : "dtc",
  );
  const [region, setRegion] = useState(
    editor.kind === "source" ? (editor.record?.region ?? "US") : "US",
  );
  const title = `${editor.record ? "编辑" : "创建"}${editor.kind === "brand" ? " Brand" : "来源"}`;
  const [formError, setFormError] = useState("");
  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      variant="blur"
    >
      <Modal.Container size="lg" placement="center" scroll="inside">
        <Modal.Dialog className="demo-modal rounded-2xl">
          <Modal.CloseTrigger aria-label="关闭弹窗" />
          <Modal.Header className="border-b border-border px-6 py-5">
            <Modal.Heading>{title}</Modal.Heading>
            <p className="mt-2 text-xs text-muted">
              保存到独立本地 V3 数据库
              {editor.record ? ` · 当前版本 v${editor.record.revision}` : ""}
            </p>
          </Modal.Header>
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              if (blocked) return;
              setFormError("");
              const version = editor.record
                ? { revision: editor.record.revision }
                : {};
              const parsed =
                editor.kind === "brand"
                  ? (editor.record ? UpdateBrand : CreateBrand).safeParse({
                      name,
                      note,
                      ...version,
                    })
                  : (editor.record ? UpdateSource : CreateSource).safeParse({
                      channel,
                      region,
                      url,
                      ...version,
                    });
              if (!parsed.success) {
                setFormError(
                  parsed.error.issues
                    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                    .join("；"),
                );
                return;
              }
              if (editor.kind === "brand") {
                onSubmit(
                  makePending(
                    `/brands${editor.record ? `/${editor.record.id}` : ""}`,
                    editor.record ? "PUT" : "POST",
                    parsed.data,
                    title,
                    "brand",
                  ),
                );
              } else {
                onSubmit(
                  makePending(
                    `/brands/${editor.brandId}/sources${editor.record ? `/${editor.record.id}` : ""}`,
                    editor.record ? "PUT" : "POST",
                    parsed.data,
                    title,
                    "source",
                  ),
                );
              }
            }}
          >
            <Modal.Body className="space-y-4 px-6 py-5">
              <fieldset
                disabled={blocked}
                className="space-y-4 disabled:opacity-70"
              >
                {editor.kind === "brand" ? (
                  <>
                    <TextField value={name} onChange={setName} isRequired>
                      <Label>品牌名称</Label>
                      <Input maxLength={80} />
                    </TextField>
                    <TextField value={note} onChange={setNote}>
                      <Label>备注</Label>
                      <TextArea maxLength={2000} rows={4} />
                    </TextField>
                  </>
                ) : (
                  <>
                    <SelectField
                      label="渠道"
                      value={channel}
                      onChange={(value) =>
                        setChannel(value as Source["channel"])
                      }
                      options={channels}
                    />
                    <TextField
                      value={region}
                      onChange={(value) => setRegion(value.toUpperCase())}
                      isRequired
                    >
                      <Label>地区</Label>
                      <Input maxLength={2} pattern="[A-Z]{2}" />
                    </TextField>
                    <TextField
                      value={url}
                      onChange={setUrl}
                      type="url"
                      isRequired
                    >
                      <Label>来源 URL</Label>
                      <Input
                        maxLength={2000}
                        placeholder="https://example.com/products"
                      />
                    </TextField>
                    <Note>仅保存入口，不访问该网站。新来源默认关闭。</Note>
                  </>
                )}
              </fieldset>
              {formError && (
                <p role="alert" className="text-xs leading-6 text-red-700">
                  {formError}
                </p>
              )}
              {notice && (
                <p role="alert" className="text-xs leading-6 text-amber-800">
                  {notice}
                </p>
              )}
              {blocked && (
                <Note warning>
                  请求确认中，表单暂时锁定。可关闭弹窗，在页面中确认原请求结果。
                </Note>
              )}
            </Modal.Body>
            <Modal.Footer className="border-t border-border px-6 py-4">
              <Button variant="outline" onPress={onClose}>
                关闭
              </Button>
              <Button type="submit" isDisabled={blocked}>
                保存到数据库
              </Button>
            </Modal.Footer>
          </Form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

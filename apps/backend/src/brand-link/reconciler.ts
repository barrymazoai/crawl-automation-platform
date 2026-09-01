import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { PipelineRepository } from "../repository.js";
import { assessEvidence, isCorroborated } from "./evidence.js";
import { BrandCatalogMatcher, type CatalogEntry } from "./matcher.js";

export interface BrandLinkOptions {
  /** 要解析的渠道，目前只有 gnc。 */
  channel: string;
  /** 目录快照超过这个时长就重新抓一次。 */
  catalogMaxAgeMs: number;
  /** 每轮最多为多少家新解析出的公司排抓取任务。 */
  enqueuePerTick: number;
  /**
   * 抓取队列的目标水位：待抓品牌少于这个数才补新的。
   *
   * 解析线一轮能出几千个结论，抓取线一小时只能消化四五个品牌。按固定速率灌，
   * 一天就能堆出上万个排队任务——队列失去可读性，也没法再按优先级调整顺序。
   * 按水位补则是"爬完一个补一个"，队列里永远只留一小截待抓清单。
   */
  queueTarget: number;
  /** subset 档要不要自动入队。默认不入队，留给人工确认。 */
  enqueueAmbiguous: boolean;
}

export interface BrandLinkStatus {
  channel: string;
  catalogEntries: number;
  catalogCapturedAt: string | null;
  catalogStale: boolean;
  resolved: number;
  ambiguous: number;
  absent: number;
  /** 已解析但还没排进抓取队列的——解析线领先抓取线多少。 */
  pendingEnqueue: number;
  enqueued: number;
}

/**
 * 解析线：把"这家公司在渠道上叫什么、链接是什么"从抓取流程里拆出来，常驻后台跑。
 *
 * 它和抓取线完全并行：这边每解析出一个品牌链接就立刻排一个抓取任务，抓取线在忙的
 * 同时这边继续往下查，谁也不等谁。结论写进 channel_brand_link 缓存，同一家公司只在
 * 目录更新后才会重算，所以反复跑几千家公司的代价接近零。
 *
 * 唯一要花渠道请求配额的是目录刷新（一次浏览器访问换整页品牌），它作为一个普通
 * pipeline job 交给持有出口浏览器的抓取池执行，因此不会另开一条绕过风控的通道。
 */
export class BrandLinkReconciler {
  constructor(
    private control: Pool,
    private product: Pool,
    private repository: PipelineRepository,
    private options: BrandLinkOptions,
    private log: (event: Record<string, unknown>) => void = () => {},
  ) {}

  async tick() {
    await this.ingestLatestCatalogJob();
    const snapshot = await this.readSnapshot();
    if (this.isStale(snapshot)) await this.requestCatalogRefresh();
    if (!snapshot || snapshot.entryCount === 0) return { matched: 0, enqueued: 0 };
    const matched = await this.matchCompanies(snapshot.capturedAt);
    await this.demoteContestedSlugs();
    const enqueued = await this.enqueueResolved();
    if (matched || enqueued) this.log({ type: "brand_link_tick", channel: this.options.channel, matched, enqueued });
    return { matched, enqueued };
  }

  /**
   * 目录抓取任务跑完后，结果留在 job.output 里。这里把最新一次成功的结果收进目录表。
   * 用 job_id 比对，保证同一次结果不会被反复写入。
   */
  private async ingestLatestCatalogJob() {
    const { rows } = await this.control.query<{ id: string; output: any }>(
      `select j.id, j.output from pipeline_job j
       where j.stage='resolve_brand_catalog' and j.state='completed'
         and j.output->>'channel' = $1 and (j.output->'entries') is not null
       order by j.completed_at desc limit 1`, [this.options.channel]);
    const job = rows[0];
    if (!job) return;
    const current = await this.control.query<{ job_id: string | null }>(
      "select job_id from channel_catalog_snapshot where channel=$1", [this.options.channel]);
    if (current.rows[0]?.job_id === job.id) return;
    // 不完整的目录一律丢弃：拿半份目录去比对，会把大批公司误判成"渠道上没有"
    if (job.output?.complete === false) {
      this.log({ type: "brand_catalog_incomplete_ignored", channel: this.options.channel, jobId: job.id, ...job.output });
      return;
    }
    await this.ingestCatalog(this.options.channel, job.output.entries ?? [], job.id);
  }

  private async readSnapshot() {
    const { rows } = await this.control.query(
      "select entry_count, captured_at from channel_catalog_snapshot where channel=$1", [this.options.channel]);
    const row = rows[0];
    return row ? { entryCount: Number(row.entry_count), capturedAt: new Date(row.captured_at) } : null;
  }

  private isStale(snapshot: { capturedAt: Date } | null) {
    return !snapshot || Date.now() - snapshot.capturedAt.getTime() > this.options.catalogMaxAgeMs;
  }

  /**
   * 目录刷新排成一个普通抓取任务。已经有一个在排队/在跑就不再排，
   * 否则控制面每 30 秒 tick 一次会堆出成百上千个重复任务。
   */
  private async requestCatalogRefresh() {
    const url = `https://www.${this.options.channel}.com/brands`;
    const existing = await this.control.query(
      `select 1 from pipeline_job j join pipeline_run r on r.id=j.run_id join pipeline_source s on s.id=r.source_id
       where j.stage='resolve_brand_catalog' and j.state in ('queued','running','retry_wait') and s.url=$1 limit 1`, [url]);
    if (existing.rowCount) return;
    const runId = randomUUID();
    await this.control.query("begin");
    try {
      const source = (await this.control.query(
        `insert into pipeline_source(id,url,origin,source_type,adapter,mode)
         values($1,$2,$3,'sales_channel',$4,'one_off')
         on conflict(url,mode) do update set enabled=true,updated_at=now() returning id`,
        [randomUUID(), url, new URL(url).origin, this.options.channel])).rows[0];
      await this.control.query("insert into pipeline_run(id,source_id) values($1,$2)", [runId, source.id]);
      await this.control.query(
        `insert into pipeline_job(id,run_id,stage,required_capability,depends_on,max_attempts,payload)
         values($1,$2,'resolve_brand_catalog',$3,'{}',6,$4)`,
        [randomUUID(), runId, this.options.channel, { url, channel: this.options.channel }]);
      await this.control.query("commit");
      this.log({ type: "brand_catalog_refresh_requested", channel: this.options.channel, url });
    } catch (error) {
      await this.control.query("rollback");
      throw error;
    }
  }

  /**
   * 拿最新目录去比对还没结论、或结论早于当前目录版本的公司。
   * 匹配全在内存里做，几千家公司也就毫秒级，不占渠道配额。
   */
  private async matchCompanies(catalogSeenAt: Date) {
    const entries = (await this.control.query<CatalogEntry>(
      "select slug, label from channel_brand_catalog where channel=$1", [this.options.channel])).rows;
    if (!entries.length) return 0;
    const matcher = new BrandCatalogMatcher(entries);

    // 一并取出佐证字段：名字只负责给出候选，能不能自动去抓由官网域名和公司简介决定。
    const companies = (await this.product.query<{
      id: string; name: string; canonical_name: string | null; website: string | null; profile: string | null;
    }>(`select id::text id, name, canonical_name, coalesce(canonical_website, website) website,
          coalesce(description,'') || ' ' || array_to_string(coalesce(keywords,'{}'),' ') profile
        from company where is_nutrition`)).rows;
    const done = new Set((await this.control.query<{ company_id: string }>(
      "select company_id from channel_brand_link where channel=$1 and catalog_seen_at >= $2",
      [this.options.channel, catalogSeenAt])).rows.map((row) => row.company_id));

    let matched = 0;
    for (const company of companies) {
      if (done.has(company.id)) continue;
      const hit = matcher.match([company.name, company.canonical_name ?? ""]);
      /*
       * 名字之外再要一条独立佐证才放行。
       *
       * 只看名字时，strong / subset 两档实测约七成是误配——Alpha Flow 对上
       * Flow Supplements、Nature's Bounty 对上 Nature's Lab，名字都沾边，公司完全不同。
       * 加上官网域名与公司简介之后，这类误配没有任何佐证，会留在人工队列里；
       * 而 Alani Nutrition LLC（alaninu.com）、Onnit Labs（onnit.com）这种真实对应
       * 则能被佐证救回来，不必浪费人工。
       *
       * exact 档本身已经够强（实测 123 家里 122 家都能拿到佐证），不因缺佐证而降级，
       * 免得把 Tomorrow's Nutrition → tomorrows-nutrition 这类只差单复数的正确匹配挡掉。
       */
      const evidence = hit
        ? assessEvidence({ website: company.website, profile: company.profile }, hit.slug, hit.label)
        : null;
      const status = !hit ? "absent"
        : hit.tier === "exact" || (evidence && isCorroborated(evidence)) ? "resolved"
        : "ambiguous";
      await this.control.query(
        `insert into channel_brand_link(company_id,channel,company_name,status,brand_slug,brand_label,brand_url,tier,evidence,catalog_seen_at,checked_at)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
         on conflict(company_id,channel) do update set
           company_name=excluded.company_name, status=excluded.status, brand_slug=excluded.brand_slug,
           brand_label=excluded.brand_label, brand_url=excluded.brand_url, tier=excluded.tier,
           evidence=excluded.evidence, catalog_seen_at=excluded.catalog_seen_at, checked_at=now()`,
        [
          company.id, this.options.channel, company.name, status,
          hit?.slug ?? null, hit?.label ?? null,
          hit ? `https://www.${this.options.channel}.com/brands/${hit.slug}/` : null,
          hit?.tier ?? null,
          { catalogSize: matcher.size, canonicalName: company.canonical_name, website: company.website, evidence },
          catalogSeenAt,
        ]);
      matched += 1;
    }
    return matched;
  }

  /**
   * 把已解析、还没排过队的公司滴灌进抓取队列——解析出一个就爬一个。
   * enqueued_at 一旦写上就不会重排，所以重启、重跑都不会产生重复抓取任务。
   */
  /**
   * 一个渠道品牌只能归一家公司。两家以上都拿到 exact 时，谁都不自动抓，全部转人工。
   *
   * 只看 exact 之间的冲突：一个 exact 配几个 ambiguous 是常态（Alani Nutrition LLC
   * 对上 alani-nu 是对的，Nu-Health 只是名字里也有 nu），把 exact 也一起降级等于
   * 白白丢掉唯一那条可信结论。
   */
  private async demoteContestedSlugs() {
    const { rowCount } = await this.control.query(
      `update channel_brand_link set status='ambiguous', checked_at=now()
       where channel=$1 and status='resolved' and enqueued_at is null and brand_slug in (
         select brand_slug from channel_brand_link
         where channel=$1 and brand_slug is not null and status='resolved'
         group by brand_slug having count(*) > 1)`, [this.options.channel]);
    if (rowCount) this.log({ type: "brand_link_contested_slugs_demoted", channel: this.options.channel, count: rowCount });
    return rowCount ?? 0;
  }

  private async enqueueResolved() {
    // 反压：抓取队列还满着就不补，等抓取线消化。
    const waiting = Number((await this.control.query(
      `select count(*)::int n from pipeline_job j
       join pipeline_run r on r.id=j.run_id join pipeline_source s on s.id=r.source_id
       where j.stage='capture_catalog' and j.state in ('queued','retry_wait','leased','running') and s.adapter=$1`,
      [this.options.channel])).rows[0]?.n ?? 0);
    const room = Math.min(this.options.enqueuePerTick, this.options.queueTarget - waiting);
    if (room <= 0) return 0;

    const tiers = this.options.enqueueAmbiguous ? ["resolved", "ambiguous"] : ["resolved"];
    const ready = (await this.control.query<{ company_id: string; brand_url: string }>(
      `select company_id, brand_url from channel_brand_link
       where channel=$1 and status = any($2::text[]) and brand_url is not null and enqueued_at is null
       order by checked_at limit $3`,
      [this.options.channel, tiers, room])).rows;
    if (!ready.length) return 0;

    let enqueued = 0;
    for (const row of ready) {
      const { created } = await this.repository.createRuns({
        urls: [row.brand_url], mode: "one_off", scheduleTimezone: "Asia/Shanghai",
      });
      await this.control.query(
        "update channel_brand_link set enqueued_at=now(), run_id=$3 where company_id=$1 and channel=$2",
        [row.company_id, this.options.channel, created[0]?.id ?? null]);
      if (created.length) enqueued += 1;
    }
    return enqueued;
  }

  /** 目录抓取任务完成后，由控制面把结果写进目录表。 */
  async ingestCatalog(channel: string, entries: readonly CatalogEntry[], jobId: string | null) {
    if (!entries.length) throw new Error(`${channel} 品牌目录为空，拒绝写入——空目录会把所有公司误判成 absent`);
    await this.control.query("begin");
    try {
      for (const entry of entries) {
        await this.control.query(
          `insert into channel_brand_catalog(channel,slug,label,url) values($1,$2,$3,$4)
           on conflict(channel,slug) do update set label=excluded.label, url=excluded.url, last_seen_at=now()`,
          [channel, entry.slug, entry.label, `https://www.${channel}.com/brands/${entry.slug}/`]);
      }
      await this.control.query(
        `insert into channel_catalog_snapshot(channel,entry_count,captured_at,job_id,status)
         values($1,$2,now(),$3,'ok')
         on conflict(channel) do update set entry_count=excluded.entry_count, captured_at=now(), job_id=excluded.job_id, status='ok'`,
        [channel, entries.length, jobId]);
      await this.control.query("commit");
    } catch (error) {
      await this.control.query("rollback");
      throw error;
    }
    this.log({ type: "brand_catalog_ingested", channel, entries: entries.length });
  }

  async status(): Promise<BrandLinkStatus> {
    const snapshot = await this.readSnapshot();
    const counts = (await this.control.query(
      `select status, count(*)::int n, count(*) filter (where enqueued_at is not null)::int enqueued
       from channel_brand_link where channel=$1 group by status`, [this.options.channel])).rows;
    const by = (status: string) => counts.find((row) => row.status === status);
    const resolved = by("resolved");
    const ambiguous = by("ambiguous");
    const enqueued = counts.reduce((sum, row) => sum + Number(row.enqueued), 0);
    return {
      channel: this.options.channel,
      catalogEntries: snapshot?.entryCount ?? 0,
      catalogCapturedAt: snapshot?.capturedAt.toISOString() ?? null,
      catalogStale: this.isStale(snapshot),
      resolved: Number(resolved?.n ?? 0),
      ambiguous: Number(ambiguous?.n ?? 0),
      absent: Number(by("absent")?.n ?? 0),
      pendingEnqueue: Number(resolved?.n ?? 0) - Number(resolved?.enqueued ?? 0),
      enqueued,
    };
  }
}

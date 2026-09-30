import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SalesChannelEgressExit, SalesChannelEgressPolicy } from "./types.js";

export interface SalesChannelEgressSelection {
  exit: SalesChannelEgressExit;
  successCount: number;
  cooldownUntil: string | null;
}

export interface SalesChannelEgressTransition {
  previousExit: SalesChannelEgressExit;
  currentExit: SalesChannelEgressExit | null;
  successCount: number;
  rotated: boolean;
  cooldownUntil: string | null;
}

interface ExitRow {
  exit_id: string;
  success_count: number;
  cooldown_until: string | null;
}

export class SalesChannelEgressState {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      pragma journal_mode=WAL;
      pragma busy_timeout=5000;
      create table if not exists sales_channel_egress_exit (
        channel text not null,
        pool text not null,
        exit_id text not null,
        ordinal integer not null,
        success_count integer not null default 0,
        cooldown_until text,
        last_selected_at text,
        last_success_at text,
        last_challenge_at text,
        updated_at text not null,
        primary key(channel,pool,exit_id)
      );
      create table if not exists sales_channel_egress_cursor (
        channel text not null,
        pool text not null,
        current_exit_id text not null,
        updated_at text not null,
        primary key(channel,pool)
      );
      create table if not exists sales_channel_egress_event (
        id integer primary key autoincrement,
        channel text not null,
        pool text not null,
        exit_id text,
        event_type text not null,
        detail_json text not null default '{}',
        created_at text not null
      );
      create index if not exists sales_channel_egress_event_lookup_idx
        on sales_channel_egress_event(channel,pool,created_at);
    `);
  }

  register(policy: SalesChannelEgressPolicy, now = new Date()) {
    if (policy.exits.length === 0) throw new Error(`sales_channel_egress_no_exits:${policy.channel}`);
    const timestamp = now.toISOString();
    const statement = this.db.prepare(`insert into sales_channel_egress_exit(
      channel,pool,exit_id,ordinal,updated_at
    ) values(?,?,?,?,?) on conflict(channel,pool,exit_id) do update set
      ordinal=excluded.ordinal,updated_at=excluded.updated_at`);
    this.db.exec("begin immediate");
    try {
      policy.exits.forEach((exit, index) => statement.run(policy.channel, policy.pool, exit.id, index, timestamp));
      const cursor = this.cursor(policy);
      const current = cursor && policy.exits.some((exit) => exit.id === cursor) ? cursor : policy.exits[0]!.id;
      this.db.prepare(`insert into sales_channel_egress_cursor(channel,pool,current_exit_id,updated_at)
        values(?,?,?,?) on conflict(channel,pool) do update set
        current_exit_id=case when current_exit_id in (${policy.exits.map(() => "?").join(",")})
          then current_exit_id else excluded.current_exit_id end,
        updated_at=excluded.updated_at`).run(
          policy.channel,
          policy.pool,
          current,
          timestamp,
          ...policy.exits.map((exit) => exit.id),
        );
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  current(policy: SalesChannelEgressPolicy, now = new Date()): SalesChannelEgressSelection | null {
    const currentId = this.cursor(policy) ?? policy.exits[0]?.id;
    if (!currentId) return null;
    const selected = this.findAvailable(policy, currentId, now, true);
    if (!selected) return null;
    if (selected.exit.id !== currentId) this.setCursor(policy, selected.exit.id, now, "cooldown_skip", { previousExitId: currentId });
    return selected;
  }

  recordSuccess(policy: SalesChannelEgressPolicy, expectedExitId: string, now = new Date()): SalesChannelEgressTransition {
    const selection = this.current(policy, now);
    if (!selection || selection.exit.id !== expectedExitId) {
      throw new Error(`sales_channel_egress_active_mismatch:${expectedExitId}:${selection?.exit.id ?? "none"}`);
    }
    const nextCount = selection.successCount + 1;
    this.db.prepare(`update sales_channel_egress_exit set success_count=?,last_success_at=?,updated_at=?
      where channel=? and pool=? and exit_id=?`).run(
        nextCount,
        now.toISOString(),
        now.toISOString(),
        policy.channel,
        policy.pool,
        selection.exit.id,
      );
    if (nextCount < policy.batchSize) {
      return { previousExit: selection.exit, currentExit: selection.exit, successCount: nextCount, rotated: false, cooldownUntil: null };
    }
    this.db.prepare(`update sales_channel_egress_exit set success_count=0,updated_at=?
      where channel=? and pool=? and exit_id=?`).run(now.toISOString(), policy.channel, policy.pool, selection.exit.id);
    const next = this.findAvailable(policy, selection.exit.id, now, false) ?? selection;
    const rotated = next.exit.id !== selection.exit.id;
    if (rotated) this.setCursor(policy, next.exit.id, now, "batch_rotation", { previousExitId: selection.exit.id, batchSize: policy.batchSize });
    return { previousExit: selection.exit, currentExit: next.exit, successCount: 0, rotated, cooldownUntil: next.cooldownUntil };
  }

  recordChallenge(policy: SalesChannelEgressPolicy, expectedExitId: string, now = new Date()): SalesChannelEgressTransition {
    return this.recordFailure(policy, expectedExitId, "challenge", now);
  }

  recordFailure(policy: SalesChannelEgressPolicy, expectedExitId: string, reason: "challenge" | "network", now = new Date()): SalesChannelEgressTransition {
    const currentId = this.cursor(policy);
    if (currentId !== expectedExitId) throw new Error(`sales_channel_egress_failure_mismatch:${expectedExitId}:${currentId ?? "none"}`);
    const previousExit = this.exit(policy, expectedExitId);
    if (!previousExit) throw new Error(`sales_channel_egress_unknown_exit:${expectedExitId}`);
    const cooldownMs = reason === "challenge" ? policy.challengeCooldownMs : policy.networkFailureCooldownMs;
    const cooldownUntil = new Date(now.getTime() + cooldownMs).toISOString();
    this.db.prepare(`update sales_channel_egress_exit set success_count=0,cooldown_until=?,last_challenge_at=?,updated_at=?
      where channel=? and pool=? and exit_id=?`).run(
        cooldownUntil,
        now.toISOString(),
        now.toISOString(),
        policy.channel,
        policy.pool,
        expectedExitId,
      );
    const next = this.findAvailable(policy, expectedExitId, now, false);
    if (next) this.setCursor(policy, next.exit.id, now, `${reason}_rotation`, { previousExitId: expectedExitId, cooldownUntil });
    else this.event(policy, expectedExitId, "all_exits_cooling", { reason, cooldownUntil }, now);
    return {
      previousExit,
      currentExit: next?.exit ?? null,
      successCount: 0,
      rotated: Boolean(next && next.exit.id !== expectedExitId),
      cooldownUntil,
    };
  }

  nextAvailableAt(policy: SalesChannelEgressPolicy) {
    const rows = this.rows(policy);
    const values = rows.map((row) => row.cooldown_until).filter((value): value is string => Boolean(value)).sort();
    return values[0] ?? null;
  }

  snapshot(policy: SalesChannelEgressPolicy, now = new Date()) {
    const currentId = this.cursor(policy);
    return {
      channel: policy.channel,
      pool: policy.pool,
      selector: policy.selector,
      currentExitId: currentId,
      exits: this.rows(policy).map((row) => ({
        id: row.exit_id,
        proxyName: this.exit(policy, row.exit_id)?.proxyName ?? row.exit_id,
        successCount: Number(row.success_count),
        cooldownUntil: row.cooldown_until,
        available: !row.cooldown_until || Date.parse(row.cooldown_until) <= now.getTime(),
      })),
    };
  }

  close() { this.db.close(); }

  private cursor(policy: SalesChannelEgressPolicy) {
    const row = this.db.prepare(`select current_exit_id from sales_channel_egress_cursor
      where channel=? and pool=?`).get(policy.channel, policy.pool) as { current_exit_id: string } | undefined;
    return row?.current_exit_id ?? null;
  }

  private rows(policy: SalesChannelEgressPolicy) {
    return this.db.prepare(`select exit_id,success_count,cooldown_until from sales_channel_egress_exit
      where channel=? and pool=? order by ordinal`).all(policy.channel, policy.pool) as unknown as ExitRow[];
  }

  private exit(policy: SalesChannelEgressPolicy, exitId: string) {
    return policy.exits.find((exit) => exit.id === exitId) ?? null;
  }

  private findAvailable(policy: SalesChannelEgressPolicy, afterExitId: string, now: Date, includeCurrent: boolean) {
    const rows = new Map(this.rows(policy).map((row) => [row.exit_id, row]));
    const start = Math.max(0, policy.exits.findIndex((exit) => exit.id === afterExitId));
    const offsets = includeCurrent
      ? Array.from({ length: policy.exits.length }, (_, index) => index)
      : Array.from({ length: policy.exits.length - 1 }, (_, index) => index + 1);
    for (const offset of offsets) {
      const exit = policy.exits[(start + offset) % policy.exits.length]!;
      const row = rows.get(exit.id);
      if (!row) continue;
      if (row.cooldown_until && Date.parse(row.cooldown_until) > now.getTime()) continue;
      return { exit, successCount: Number(row.success_count), cooldownUntil: row.cooldown_until };
    }
    return null;
  }

  private setCursor(policy: SalesChannelEgressPolicy, exitId: string, now: Date, eventType: string, detail: Record<string, unknown>) {
    this.db.prepare(`update sales_channel_egress_cursor set current_exit_id=?,updated_at=?
      where channel=? and pool=?`).run(exitId, now.toISOString(), policy.channel, policy.pool);
    this.db.prepare(`update sales_channel_egress_exit set last_selected_at=?,updated_at=?
      where channel=? and pool=? and exit_id=?`).run(now.toISOString(), now.toISOString(), policy.channel, policy.pool, exitId);
    this.event(policy, exitId, eventType, detail, now);
  }

  private event(policy: SalesChannelEgressPolicy, exitId: string | null, eventType: string, detail: Record<string, unknown>, now: Date) {
    this.db.prepare(`insert into sales_channel_egress_event(channel,pool,exit_id,event_type,detail_json,created_at)
      values(?,?,?,?,?,?)`).run(policy.channel, policy.pool, exitId, eventType, JSON.stringify(detail), now.toISOString());
  }
}

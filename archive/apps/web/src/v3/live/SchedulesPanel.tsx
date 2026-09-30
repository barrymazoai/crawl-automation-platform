import { useEffect, useRef, useState } from "react";
import { Button, Form, Input, Label, TextField } from "@heroui/react";
import { Id, ScheduleReadback, type Source, type ScheduleView } from "@crawl-automation/v3-contracts";
import { Note, Panel } from "../ui";
import { ApiFailure, request } from "./api";
import { prepareScheduleIntent, readScheduleIntent, scheduleStorageKey, sendScheduleIntent, type ScheduleIntent } from "./schedules";

export function SchedulesPanel({ source, blocked }: { source: Source | null; blocked: boolean }) {
  const [pending,setPending]=useState<ScheduleIntent|null>(null), [ready,setReady]=useState(false);
  const [linked,setLinked]=useState<{brandId:string;sourceId:string}|null>(null), [rejected,setRejected]=useState(false);
  const [view,setView]=useState<ScheduleView|null>(null), [enabled,setEnabled]=useState(false);
  const [busy,setBusy]=useState(false), [loading,setLoading]=useState(true);
  const [error,setError]=useState(""), [notice,setNotice]=useState(""), [storageError,setStorageError]=useState("");
  const [refresh,setRefresh]=useState(0), [hour,setHour]=useState("4"), [minute,setMinute]=useState("0"), [zone,setZone]=useState("UTC");
  const lock=useRef(false);
  const brandId=pending?.brandId??source?.brandId??linked?.brandId, sourceId=pending?.sourceId??source?.id??linked?.sourceId;
  useEffect(()=>{try{
    const saved=readScheduleIntent(sessionStorage);setPending(saved);
    if(saved){setHour(String(saved.input.rule.hour));setMinute(String(saved.input.rule.minute));setZone(saved.input.rule.timezone);}
    const url=new URL(window.location.href),id=url.searchParams.get("scheduleSource");
    if(id)setLinked({brandId:Id.parse(url.searchParams.get("brand")),sourceId:Id.parse(id)});
    setReady(true);
  }catch{setStorageError("计划凭证或链接不可读取，已暂停写操作，请勿清空存储。");}},[]);
  useEffect(()=>{
    if(!ready)return;
    let live=true;
    setLoading(true);setView(null);setEnabled(false);
    if(!brandId||!sourceId){setLoading(false);return;}
    void request(`/brands/${brandId}/sources/${sourceId}/schedule`,ScheduleReadback).then(result=>{
      if(!live)return;
      if(result.item&&(result.item.definition.sourceId!==sourceId||result.item.definition.brandId!==brandId))throw Error("计划归属不匹配");
      setView(result.item);setEnabled(result.enabled);setError("");
      if(result.item&&!pending){setHour(String(result.item.definition.rule.hour));setMinute(String(result.item.definition.rule.minute));setZone(result.item.definition.rule.timezone);}
    }).catch(e=>{if(live)setError(e instanceof Error?e.message:"读取失败");}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;};
  },[ready,brandId,sourceId,refresh]);
  const execute=async(intent:ScheduleIntent)=>{
    if(lock.current)return;
    lock.current=true;setBusy(true);setNotice("");setRejected(false);
    try{await sendScheduleIntent(intent);sessionStorage.removeItem(scheduleStorageKey);setPending(null);setNotice("已回读确认 Temporal 中的实际计划配置；这不是采集完成提示。");}
    catch(e){setNotice(`${e instanceof Error?e.message:"请求异常"} 原 key 已保留，不自动重试。`);setRejected(e instanceof ApiFailure&&!e.uncertain&&["SCHEDULE_CONFLICT","SOURCE_DISABLED","SOURCE_NOT_FOUND","REVISION_CONFLICT","INVALID_INPUT"].includes(e.code));}
    finally{lock.current=false;setBusy(false);setRefresh(n=>n+1);}
  };
  const save=(paused:boolean)=>{
    if(!source||pending||locked||!enabled)return;
    try{
      if(!/^\d{1,2}$/.test(hour)||!/^\d{1,2}$/.test(minute))throw Error("请填写完整的小时和分钟。");
      new Intl.DateTimeFormat("en",{timeZone:zone});
      const rule={hour:Number(hour),minute:Number(minute),timezone:zone};
      const input=view?{rule,sourceRevision:source.revision,revision:view.definition.revision,paused}:{rule,sourceRevision:source.revision};
      const intent=prepareScheduleIntent(sessionStorage,source,input,view?"PUT":"POST");setPending(intent);void execute(intent);
    }catch(e){setNotice(e instanceof Error?e.message:"校验或保存凭证失败；本次未发送。");}
  };
  const locked=blocked||busy||loading||!ready||!!pending||!!storageError||!!error;
  return <section id="schedules" className="scroll-mt-6"><Panel title="定时计划" subtitle="每个来源一条每日计划 · Temporal 是唯一计划真源">
    <div className="space-y-4 p-5 text-xs leading-6">
      <Note>新计划默认暂停，不立即触发。启用后由 Temporal 按时启动接收流程，再进入与手动提交相同的持久化入口。这里只配置计划，不自动补跑历史任务。</Note>
      <p className="break-all">来源：{sourceId??"请在来源列表点击「选择计划」"}{pending?" · 正在确认原请求，不随选择切换":""}</p>
      {!enabled&&<p>此来源尚未选择，或当前环境未开放定时计划。</p>}
      {storageError&&<Note warning>{storageError}</Note>}
      {error&&<div role="alert"><Note warning>{error}</Note></div>}
      {notice&&<p role="status" className="break-words">{notice}</p>}
      {pending&&<Note warning><p className="break-all">待确认计划请求：{pending.key} · {pending.method}</p><p>原配置：{pending.input.rule.hour}:{String(pending.input.rule.minute).padStart(2,"0")} · {pending.input.rule.timezone}；刷新不会自动写入 Temporal。</p><Button size="sm" variant="outline" isDisabled={busy||loading||!!storageError} onPress={()=>void execute(pending)}>确认原计划请求</Button>
        {rejected&&<Button size="sm" variant="ghost" isDisabled={busy||loading||!!storageError} onPress={()=>{
          try{const key="crawler-v3-live:schedule-archive:v1",archive=JSON.parse(sessionStorage.getItem(key)??"[]");if(!Array.isArray(archive))throw Error("corrupt");sessionStorage.setItem(key,JSON.stringify([...archive,pending]));sessionStorage.removeItem(scheduleStorageKey);setPending(null);setRejected(false);setRefresh(n=>n+1);setNotice("被拒绝/冲突的原请求已归档，未重放修改。请核对实际计划再编辑。");}catch{setStorageError("凭证归档失败，继续保留原请求。");}
        }}>归档被拒绝的请求</Button>}
      </Note>}
      {view&&<div className="space-y-1 rounded-xl bg-[#f0f4ea] p-4 break-all" aria-label="真实计划配置">
        <p className="font-semibold">{view.paused?"计划已暂停":"计划已启用"} · v{view.definition.revision}</p>
        <p>Schedule ID：{view.scheduleId}</p><p>当前规则：每天 {String(view.definition.rule.hour).padStart(2,"0")}:{String(view.definition.rule.minute).padStart(2,"0")} · {view.definition.rule.timezone}</p>
        <p>来源版本：v{view.definition.sourceRevision} · 重叠策略 SKIP · 补偿窗口 10 秒 · 接收流程失败自动暂停</p>
        <p>Temporal 已触发 {view.actionsTaken} 次；计划重叠跳过 {view.overlapSkipped} 次；错过补偿窗口 {view.missedCatchup} 次。</p>
        <p>以上不是采集成功数；数据库来源占用导致的 SKIPPED 记录在接收 Workflow 结果中，不混入 Temporal overlap 计数。</p>
        <p>{view.paused?"暂停中；以下是规则匹配时间，不会执行：":"接下来的匹配时间（UTC）："}</p>
        <ul>{view.nextTimes.slice(0,3).map(time=><li key={time}>{time}</li>)}</ul>
        <a className="text-accent underline" href={`?brand=${brandId}&scheduleSource=${sourceId}#schedules`} target="_blank" rel="noopener noreferrer">查看此来源的计划链接 ↗</a>
      </div>}
      <Form onSubmit={e=>{e.preventDefault();save(view?.paused??true);}}>
        <fieldset disabled={locked||!enabled} className="grid gap-3 sm:grid-cols-3 disabled:opacity-60">
          <TextField value={hour} onChange={setHour} isRequired><Label>小时（0–23）</Label><Input type="number" min={0} max={23} step={1}/></TextField>
          <TextField value={minute} onChange={setMinute} isRequired><Label>分钟（0–59）</Label><Input type="number" min={0} max={59} step={1}/></TextField>
          <TextField value={zone} onChange={setZone} isRequired><Label>IANA 时区</Label><Input maxLength={100} placeholder="America/New_York"/></TextField>
        </fieldset>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="submit" isDisabled={locked||!enabled||!source}>{view?"保存计划修改":"创建暂停计划"}</Button>
          {view&&<Button variant="outline" isDisabled={locked||!enabled||!source} onPress={()=>save(!view.paused)}>{view.paused?"保存并启用计划":"保存并暂停计划"}</Button>}
          <Button variant="ghost" isDisabled={busy||loading||!ready} onPress={()=>setRefresh(n=>n+1)}>重新读取计划</Button>
        </div>
      </Form>
      {linked&&!source&&<p>通过链接只读查看。需要修改时，请在来源列表选择此来源的计划。</p>}
      <Note warning>夏令时按当地钟表时间匹配：春季不存在的时间跳过，秋季重复时间会匹配两次（由不同 UTC tick 标识）；建议使用 UTC。来源占用则本次跳过，不积压。修改来源后需重新保存对应版本。暂停只影响未来触发，不取消已有采集。</Note>
    </div>
  </Panel></section>;
}

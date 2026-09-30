const list = document.getElementById('requests');
const status = document.getElementById('status');
const labels = {pending:'等待你回复', approved:'已确认，等待领取', rejected:'已拒绝', expired:'已过期', consumed:'回复已领取（不代表操作成功）'};
function element(tag, text, parent) {
  const node = document.createElement(tag); node.textContent = text; parent.append(node); return node;
}
async function refresh() {
  try {
    const response = await fetch('/human/requests');
    if (!response.ok) throw new Error('加载失败，请刷新并登录');
    const {items} = await response.json(); list.replaceChildren();
    const focus = location.hash.slice(1);
    items.sort((a,b) => Number(b.id === focus) - Number(a.id === focus));
    for (const item of items) {
      const card = element('article', '', list);
      element('h2', item.action, card);
      element('span', labels[item.status] ?? item.status, card).className = 'badge';
      element('pre', item.question, card);
      element('p', `目标：${item.url}`, card);
      element('small', `任务 ${item.taskId} · Worker ${item.workerId}\n会话 ${item.threadId}\n上下文 ${item.contextId}\n有效至 ${new Date(item.expiresAt).toLocaleString()}`, card);
      if (item.reply) element('pre', `你的回复：${item.reply}`, card);
      if (item.status !== 'pending') continue;
      const reply = element('textarea', '', card);
      reply.placeholder = '输入你对这次操作的回复（例如：确认，仅执行上述这一次操作）'; reply.maxLength = 2000;
      reply.setAttribute('aria-label', '对当前操作的真实回复');
      const approve = element('button', '确认这次操作', card);
      const reject = element('button', '拒绝', card); reject.className = 'reject';
      for (const [button, decision] of [[approve, 'approved'], [reject, 'rejected']]) {
        button.addEventListener('click', async () => {
          if (!reply.value.trim()) { status.textContent = '请先填写你的回复。'; reply.focus(); return; }
          approve.disabled = reject.disabled = true;
          try {
            const response = await fetch(`/human/requests/${item.id}/decision`, {method:'POST',
              headers:{'Content-Type':'application/json','X-CSRF-Token':item.csrf},
              body:JSON.stringify({hash:item.hash,decision,reply:reply.value})});
            if (!response.ok) throw new Error((await response.json()).error);
            status.textContent = '已保存你的回复。'; await refresh();
          } catch (error) { status.textContent = `未完成：${error.message}。请刷新核对状态。`; }
        });
      }
    }
    if (!items.length) element('p', '目前没有待确认记录。', list);
  } catch (error) { status.textContent = error.message; }
}
document.getElementById('refresh').addEventListener('click', refresh);
refresh();

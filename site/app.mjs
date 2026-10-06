// 浏览器端控制层：连接 IndexedDB 与引擎，渲染录入、批次、断电演练与结果页。
import { Engine, CRASH_POINTS } from './src/engine.mjs';
import { IDBStore } from './src/store.mjs';

const $ = (id) => document.getElementById(id);
const els = {};
for (const id of [
  'recovery-banner', 'init-card', 'init-input', 'init-count', 'btn-init', 'btn-sample',
  'batch-card', 'batch-id', 'edit-table', 'edit-count', 'btn-add-edit', 'crash-point',
  'btn-submit', 'btn-rehearse', 'btn-reopen', 'btn-lookup', 'lookup-key', 'btn-reset',
  'receipt-out', 'r-gen', 'r-pages', 'r-kinds', 'r-keys', 'r-order-badge', 'r-once-badge',
  'r-rootid', 'audit-out', 'leafseq', 'pages-out',
  'rehearse-status', 'rh-pub', 'rh-cand', 'rehearse-steps',
]) els[id] = $(id);

let engine = null;
const DB_NAME = 'track-exchange-v1';

// ---------- 预演状态（仅存在于本页内存；刷新即消失，绝不来自 IndexedDB） ----------
//
// rehearsal = null               尚未预演
// rehearsal = { data, at, stale, staleCode?, staleReason? }
// data 为 engine.rehearse() 的结果，绑定启动时根指针与规范化脚本。
// 刷新页面 / 初始索引变更 / 任一编辑重新录入 / 提交或重开后都会失效：
// 旧候选仍留在屏上但明确标示“已失效、不可提交”，提交门禁会拒绝它。
let rehearsal = null;

function invalidateRehearsal(code, reason) {
  if (!rehearsal) return;
  rehearsal = { ...rehearsal, stale: true, staleCode: code, staleReason: reason };
  renderRehearsal();
}

// ---------- 启动（本身就是一次重开复核） ----------

async function boot() {
  const store = await IDBStore.open(DB_NAME);
  engine = new Engine(store);
  const report = await engine.open();
  showRecovery(report);
  syncEditRows(1);
  if (engine.state?.rootId != null) {
    els['batch-id'].value = 'batch-' + Date.now().toString(36);
  }
  render();
  if (engine.state?.rootId == null) {
    els['init-input'].value = '10,航点十\n20,航点廿\n30,卅\n40,四十\n50,五十\n60,六十\n70,七十';
    recountInit();
  }
}

// ---------- 恢复横幅 ----------

const BANNER_CLASS = {
  FRESH: 'fresh',
  INTACT: 'intact',
  NEW_ROOT_PUBLISHED: 'new',
  OLD_ROOT_RETAINED: 'old',
  PUBLISHED_ROOT_UNHEALTHY: 'unhealthy',
};
const BANNER_TITLE = {
  FRESH: '空库',
  INTACT: '复核通过',
  NEW_ROOT_PUBLISHED: '发布完整新根',
  OLD_ROOT_RETAINED: '保留旧根',
  PUBLISHED_ROOT_UNHEALTHY: '已发布根不健康',
};

function showRecovery(report) {
  if (!report) { els['recovery-banner'].classList.add('hidden'); return; }
  const b = els['recovery-banner'];
  b.className = 'banner ' + (BANNER_CLASS[report.conclusion] ?? 'fresh');
  b.innerHTML = `<span class="banner-title">${BANNER_TITLE[report.conclusion] ?? report.conclusion}</span>` +
    `代次 ${report.gen} · ${escapeHtml(report.detail)}` +
    ` <span style="opacity:.6">（${report.at}）</span>`;
}

// ---------- 初始录入 ----------

function parseInit() {
  const lines = els['init-input'].value.split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.map((line) => {
    const idx = line.indexOf(',');
    const keyRaw = idx < 0 ? line : line.slice(0, idx);
    const value = idx < 0 ? '' : line.slice(idx + 1);
    return [Number(keyRaw.trim()), value.trim()];
  });
}

function recountInit() {
  const entries = parseInit();
  els['init-count'].textContent = entries.length;
  els['init-count'].style.color = entries.length > 24 ? 'var(--bad)' : '';
}

els['init-input'].addEventListener('input', recountInit);
els['btn-sample'].addEventListener('click', () => {
  els['init-input'].value = '10,航点十\n20,航点廿\n30,卅\n40,四十\n50,五十\n60,六十\n70,七十';
  recountInit();
});

els['btn-init'].addEventListener('click', async () => {
  let entries;
  try {
    entries = parseInit();
    for (const [k] of entries) {
      if (!Number.isInteger(k)) throw new Error('存在非整数键，请检查每行应为 “键,载荷”');
    }
    await engine.initialize(entries);
    showReceipt({ status: 'initialized', gen: 1, count: entries.length });
    els['batch-id'].value = 'batch-' + Date.now().toString(36);
    rehearsal = null; // 初始索引变更：任何旧候选都作废
    render();
  } catch (e) {
    showReceipt({ status: 'rejected', code: e.code ?? 'BAD_INPUT', reason: e.message });
  }
});

// ---------- 批次编辑表 ----------

function editRows() {
  return [...els['edit-table'].querySelectorAll('tbody tr')].map((tr) => ({
    op: tr.querySelector('.sel-op').value,
    key: tr.querySelector('.inp-key').value,
    value: tr.querySelector('.inp-value').value,
  }));
}

function setEditRows(rows) {
  const tbody = els['edit-table'].querySelector('tbody');
  tbody.innerHTML = '';
  for (const r of rows) tbody.appendChild(makeRow(r));
  recountEdits();
}

function syncEditRows(want) {
  const have = els['edit-table'].querySelectorAll('tbody tr').length;
  if (!have) setEditRows(Array.from({ length: want }, () => ({ op: 'insert', key: '', value: '' })));
}

function makeRow({ op = 'insert', key = '', value = '' } = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>
      <select class="sel-op">
        <option value="insert" class="op-insert">插入</option>
        <option value="update" class="op-update">更新</option>
        <option value="delete" class="op-delete">删除</option>
      </select>
    </td>
    <td><input class="inp-key" type="number" step="1" placeholder="整数键" /></td>
    <td><input class="inp-value" type="text" maxlength="200" placeholder="短文本（删除可留空）" /></td>
    <td><button class="btn-mini ghost" type="button">✕</button></td>`;
  tr.querySelector('.sel-op').value = op;
  tr.querySelector('.inp-key').value = key;
  tr.querySelector('.inp-value').value = value;
  tr.querySelector('button').addEventListener('click', () => {
    tr.remove(); recountEdits();
    invalidateRehearsal('EDIT_REMOVED', '删除了一项编辑，预演基准脚本已变化，须重新预演');
  });
  tr.querySelector('.sel-op').addEventListener('change', () => {
    tr.querySelector('.inp-value').disabled = tr.querySelector('.sel-op').value === 'delete';
    invalidateRehearsal('SCRIPT_CHANGED', '修改了操作类型，预演基准脚本已变化，须重新预演');
  });
  // 重新录入任一编辑（键或载荷）即令既有预演失效
  tr.querySelector('.inp-key').addEventListener('input', () =>
    invalidateRehearsal('SCRIPT_CHANGED', '修改了编辑键，预演基准脚本已变化，须重新预演'));
  tr.querySelector('.inp-value').addEventListener('input', () =>
    invalidateRehearsal('SCRIPT_CHANGED', '修改了编辑载荷，预演基准脚本已变化，须重新预演'));
  return tr;
}

function recountEdits() {
  const n = els['edit-table'].querySelectorAll('tbody tr').length;
  els['edit-count'].textContent = n;
  els['edit-count'].style.color = n > 12 ? 'var(--bad)' : '';
}

els['btn-add-edit'].addEventListener('click', () => {
  const n = els['edit-table'].querySelectorAll('tbody tr').length;
  if (n >= 12) { flashReceipt('每批至多 12 项'); return; }
  els['edit-table'].querySelector('tbody').appendChild(makeRow());
  recountEdits();
  invalidateRehearsal('EDIT_ADDED', '新增了一项编辑，预演基准脚本已变化，须重新预演');
});

els['batch-id'].addEventListener('input', () =>
  invalidateRehearsal('SCRIPT_CHANGED', '修改了批次标识，预演基准已变化，须重新预演'));

// ---------- 提交 / 重开 / 查询 / 抹库 ----------

function collectEdits() {
  return editRows()
    .filter((r) => r.key !== '' && r.key !== null && Number.isFinite(Number(r.key)))
    .map((r) => {
      const e = { op: r.op, key: Number(r.key) };
      if (r.op !== 'delete') e.value = r.value;
      return e;
    });
}

els['btn-rehearse'].addEventListener('click', async () => {
  const batchId = els['batch-id'].value.trim();
  const edits = collectEdits();
  const data = await engine.rehearse(edits, batchId);
  rehearsal = { data, at: new Date().toISOString(), stale: false };
  showReceipt({
    status: data.ok ? 'rehearsed' : 'rehearsal-rejected',
    inMemoryOnly: true,
    baseGen: data.base.baseGen,
    candidateGen: data.ok ? data.candidateGen : undefined,
    code: data.ok ? undefined : data.code,
    reason: data.ok ? undefined : data.reason,
  });
  render();
});

els['btn-submit'].addEventListener('click', async () => {
  const batchId = els['batch-id'].value.trim();
  const edits = collectEdits();
  // 提交门禁：必须有与当前根指针、规范化脚本一致的预演；基准漂移一律先要求重新预演。
  // 注意：断电演练（crashAt != none）是在刻意制造中断，仍要求先预演同一脚本。
  const assessment = engine.assessRehearsal(rehearsal?.stale ? null : rehearsal?.data, edits, batchId);
  if (!assessment.valid) {
    // 预演新鲜但推演被拒绝时，回执沿用预演给出的真实拒因（与提交拒因一致），
    // 仍标注须重新预演；失效或无预演则使用门禁原因。
    const freshRejected = rehearsal && !rehearsal.stale && rehearsal.data && !rehearsal.data.ok;
    showReceipt({
      status: 'rejected',
      code: freshRejected ? rehearsal.data.code : assessment.reasonCode,
      reason: freshRejected ? rehearsal.data.reason : assessment.reason,
      requiresRehearsal: true,
    });
    return;
  }
  const crashAt = els['crash-point'].value;
  const receipt = await engine.submitBatch(edits, batchId, crashAt);
  showReceipt(receipt);
  if (receipt.status === 'interrupted') {
    // 真实演练：直接模拟“进程死亡”，要求审查员点重开复核（或刷新页面）
    // 此时根尚未切换，但持久化已被触碰，旧预演不得再视为可提交
    invalidateRehearsal('BATCH_INTERRUPTED', '批次在持久化阶段中断，须重开复核并重新预演');
    bannerInterrupt(receipt);
  } else {
    // 提交完成（含提交被规则拒绝、冲突、回放）：根指针可能前进或收到终局回执，预演一律失效
    rehearsal = null;
  }
  render();
});

els['btn-reopen'].addEventListener('click', async () => {
  const report = await engine.recover();
  showRecovery(report);
  showReceipt({ status: 'reopened', ...report });
  // 重开复核可能发布新根或回滚意图，启动时的根指针基准已重估，预演失效
  invalidateRehearsal('RECOVERY_RECHECK', '已执行断电后重开复核，根指针基准已重估，须重新预演');
  render();
});

els['btn-lookup'].addEventListener('click', () => {
  const k = Number(els['lookup-key'].value);
  if (!Number.isInteger(k)) { flashReceipt('请输入整数查询键'); return; }
  try {
    const hit = engine.lookup(k);
    showReceipt(hit
      ? { lookup: k, found: true, value: hit.value, pageId: hit.pageId }
      : { lookup: k, found: false });
  } catch (e) {
    showReceipt({ status: 'rejected', code: e.code, reason: e.message });
  }
});

els['btn-reset'].addEventListener('click', async () => {
  if (!confirm('确定抹除整个 IndexedDB 航迹库并重头开始？')) return;
  await engine.store.close();
  await new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = res; r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('删除被阻塞'));
  });
  location.reload();
});

function bannerInterrupt(receipt) {
  const b = els['recovery-banner'];
  b.className = 'banner old';
  b.innerHTML = `<span class="banner-title">⚡ 已模拟断电中断</span>阶段 ${receipt.stage} · ${escapeHtml(receipt.note)}。` +
    `此刻持久化状态未定，请点击「断电后重开复核」（或刷新页面）查看恢复结论。`;
}

function flashReceipt(msg) { showReceipt({ status: 'note', reason: msg }); }

function showReceipt(obj) {
  els['receipt-out'].textContent = JSON.stringify(obj, null, 2);
}

// ---------- 结果页渲染 ----------

function render() {
  const initialized = engine.state?.rootId != null;
  els['btn-init'].disabled = initialized;
  els['init-input'].disabled = initialized;
  els['btn-submit'].disabled = !initialized;
  els['btn-rehearse'].disabled = !initialized;
  if (!initialized) {
    ['r-gen', 'r-pages', 'r-kinds', 'r-keys'].forEach((k) => (els[k].textContent = '—'));
    els['r-rootid'].textContent = '尚未建立索引';
    els['leafseq'].innerHTML = '<div class="empty-hint">录入初始航点后展示。</div>';
    els['pages-out'].innerHTML = '<div class="empty-hint">尚无页。</div>';
    els['audit-out'].innerHTML = '<div class="empty-hint">尚无审计结果。</div>';
    setBadge('r-order-badge', false, '—');
    setBadge('r-once-badge', false, '—');
    renderRehearsal(null);
    return;
  }
  const snap = engine.snapshot();
  els['r-gen'].textContent = snap.gen;
  els['r-pages'].textContent = snap.reachablePages;
  els['r-kinds'].textContent = `${snap.internalCount} / ${snap.leafCount}`;
  els['r-keys'].textContent = snap.keyCount;
  els['r-rootid'].textContent = snap.rootId;
  setBadge('r-order-badge', snap.ordered, snap.ordered ? '严格递增' : '失序');
  setBadge('r-once-badge', snap.allKeysOnce, snap.allKeysOnce ? '是' : '否');
  renderAudit(snap);
  renderLeafSequence(snap);
  renderPages(snap);
  renderRehearsal(snap);
}

function setBadge(id, ok, text) {
  const b = els[id];
  b.classList.toggle('ok', !!ok && text !== '—');
  b.classList.toggle('fail', !ok && text !== '—');
  b.querySelector('strong').textContent = text;
}

function renderAudit(snap) {
  const a = snap.audit;
  if (!a) { els['audit-out'].innerHTML = ''; return; }
  const chip = (k) => `<span class="chip bad-chip">${escapeHtml(String(k))}</span>`;
  const lines = [];
  lines.push(['pass', a.pass ? '✔' : '✘',
    a.pass
      ? `分裂审计通过：期望 ${a.expectedCount} 键，叶序实得 ${a.actualCount} 键，全部严格有序且每键恰好出现一次。`
      : `审计未通过：期望 ${a.expectedCount} 键，实得 ${a.actualCount} 键。`]);
  if (!a.ordered) lines.push(['fail', '✘', '叶序列并非严格按键递增。']);
  if (a.dupes.length) lines.push(['fail', '✘', `重复出现的键：${a.dupes.map(chip).join('')}`]);
  if (a.missing.length) lines.push(['fail', '✘', `丢失的键：${a.missing.map(chip).join('')}`]);
  if (a.extra.length) lines.push(['fail', '✘', `多余的键：${a.extra.map(chip).join('')}`]);
  if (snap.badReferences.length) {
    lines.push(['fail', '✘', `无法闭合的子页引用：${snap.badReferences.map(chip).join('')}`]);
  }
  els['audit-out'].innerHTML = lines
    .map(([cls, mark, text]) => `<div class="line ${cls}"><span class="mark">${mark}</span><span>${text}</span></div>`)
    .join('');
}

function renderLeafSequence(snap) {
  els['leafseq'].innerHTML = leafSequenceHtml(snap.leafSequence);
}

// 预演候选与已发布视图共用同一套叶序列渲染（交替底色即不同叶页）
function leafSequenceHtml(leafSequence) {
  // 按叶页分组（每项带 pageId），交替底色
  const groups = [];
  for (const item of leafSequence) {
    let g = groups[groups.length - 1];
    if (!g || g.pageId !== item.pageId) { g = { pageId: item.pageId, items: [] }; groups.push(g); }
    g.items.push(item);
  }
  if (!groups.length) return '<div class="empty-hint">空树（无键）。</div>';
  return groups.map((g, i) => {
    const short = g.pageId.slice(0, 10);
    const cells = g.items.map((it) =>
      `<div class="kv"><div class="k">${it.key}</div><div class="v">${escapeHtml(it.value)}</div></div>`).join('');
    const arrow = i < groups.length - 1 ? '<span class="leaf-arrow">→</span>' : '';
    return `<span class="leaf-block ${i % 2 ? 'b' : 'a'}"><span class="leaf-head">叶 ${short}… · ${g.items.length} 键</span>` +
      `<span class="cells">${cells}</span></span>${arrow}`;
  }).join('');
}

// ---------- 预演视图渲染（与已发布视图并列） ----------

const OP_LABEL = { insert: '插入', update: '更新', delete: '删除' };

function editText(e) {
  const base = `${OP_LABEL[e.op] ?? e.op} 键 ${e.key}`;
  return e.op === 'delete' ? base : `${base} = ${JSON.stringify(e.value ?? '')}`;
}

function summaryOf(snap) {
  const leafPageIds = [];
  for (const x of snap.leafSequence) {
    if (leafPageIds[leafPageIds.length - 1] !== x.pageId) leafPageIds.push(x.pageId);
  }
  return {
    rootId: snap.rootId, gen: snap.gen, reachablePages: snap.reachablePages,
    internalCount: snap.internalCount, leafCount: snap.leafCount,
    keyCount: snap.keyCount, ordered: snap.ordered, allKeysOnce: snap.allKeysOnce,
    leafSequence: snap.leafSequence, leafPageIds,
  };
}

function summaryHtml(s, { dim = false } = {}) {
  if (!s) return '<div class="empty-hint">—</div>';
  const ord = s.ordered ? '<span class="reh-ok">严格递增</span>' : '<span class="reh-bad">失序</span>';
  const once = s.allKeysOnce ? '<span class="reh-ok">每键一次</span>' : '<span class="reh-bad">存在重复</span>';
  return `
    <div class="reh-metrics">
      <div><span>根代次</span><b>${s.gen}</b></div>
      <div><span>可达页</span><b>${s.reachablePages}</b></div>
      <div><span>内部/叶</span><b>${s.internalCount} / ${s.leafCount}</b></div>
      <div><span>键总数</span><b>${s.keyCount}</b></div>
      <div><span>叶序</span><b>${ord}</b></div>
      <div><span>恰好一次</span><b>${once}</b></div>
    </div>
    <div class="reh-rootline">根指针 <code>${escapeHtml(s.rootId ?? '—')}</code></div>
    <div class="reh-leaves ${dim ? 'dim' : ''}">${leafSequenceHtml(s.leafSequence)}</div>`;
}

function renderRehearsal(liveSnap) {
  const status = els['rehearse-status'];
  const pubEl = els['rh-pub'];
  const candEl = els['rh-cand'];
  const stepsEl = els['rehearse-steps'];
  const publishedHtml = liveSnap ? summaryHtml(summaryOf(liveSnap)) : '<div class="empty-hint">尚未建立索引。</div>';

  if (!rehearsal) {
    status.className = 'reh-status none';
    status.innerHTML = '<span class="reh-pill none">尚未预演</span>' +
      '录入批次脚本后点击「预演（仅内存）」，可在不触碰 IndexedDB 已发布根的前提下查看分裂、合并与拒绝原因。';
    pubEl.innerHTML = publishedHtml;
    candEl.innerHTML = '<div class="empty-hint">尚无候选根。预演结果只存在于内存，本页刷新后不会保留。</div>';
    stepsEl.innerHTML = '<div class="empty-hint">执行预演后，逐项展示每项编辑应用后的结果。</div>';
    return;
  }

  const { data, at, stale, staleReason } = rehearsal;
  const base = data.base;

  // 状态横幅：有效 / 将幂等回放 / 已拒绝 / 已失效
  if (stale) {
    status.className = 'reh-status stale';
    status.innerHTML = `<span class="reh-pill stale">预演已失效 · 不可提交</span>${escapeHtml(staleReason ?? '基准已变化')}。` +
      `下方候选是绑定代次 ${base.baseGen} 根的旧内存结果，提交前必须重新预演。`;
  } else if (!data.ok) {
    status.className = 'reh-status rejected';
    status.innerHTML = `<span class="reh-pill rejected">预演被拒绝</span>` +
      `<code>${escapeHtml(data.code)}</code> · ${escapeHtml(data.reason)}。` +
      `整批不会被提交、已发布根不变；本次预演同样<b>没有写入任何页、意图或回执</b>。`;
  } else if (data.willReplay) {
    status.className = 'reh-status fresh';
    status.innerHTML = `<span class="reh-pill fresh">预演有效 · 将幂等回放</span>` +
      `批次标识 <b>${escapeHtml(base.batchId)}</b> 已有${data.replayStatus === 'committed' ? '提交' : data.replayStatus === 'rolled-back' ? '回滚' : ''}回执；` +
      `脚本与原编辑归一化后相同，提交将回放原回执，<b>不再次改根、代次不前进</b>。` +
      `<span class="reh-note">预演没有写入页、意图或回执；生成于 ${at}；候选视图即当前已发布视图。</span>`;
  } else {
    status.className = 'reh-status fresh';
    const delta = data.addedKeyCount >= 0 ? `净增 ${data.addedKeyCount}` : `净减 ${-data.addedKeyCount}`;
    status.innerHTML = `<span class="reh-pill fresh">预演有效 · 仅内存</span>` +
      `依据根代次 <b>${base.baseGen}</b>（<code>${escapeHtml(base.baseRootId.slice(0, 12))}…</code>）推演候选代次 <b>${data.candidateGen}</b>：` +
      `预计新增页 <b>${data.addedPages}</b>、不再可达页 <b>${data.unreachablePages}</b>、` +
      `键数 ${data.baseSummary.keyCount} → ${data.candidateSummary.keyCount}（${delta}）。` +
      `<span class="reh-note">没有写入页、意图或回执；生成于 ${at}。基准仍一致时提交将得到相同键序与页结构摘要。</span>`;
  }

  // 已发布列：始终展示当前 IndexedDB 根（与右侧内存候选并列）
  pubEl.innerHTML = publishedHtml;

  // 候选列
  if (!data.ok) {
    candEl.innerHTML = '<div class="empty-hint reh-bad">无候选根：脚本在内存推演中即被拒绝，未产生可提交结构。</div>';
  } else {
    candEl.innerHTML = (stale ? '<div class="reh-stamp">已失效 · 旧候选</div>' : '') +
      summaryHtml(data.candidateSnapshot, { dim: stale });
  }

  // 逐项编辑结果
  const edits = base.normalizedEdits;
  if (!data.ok && data.steps.length === 0) {
    // 整批在进入树推演前即被校验拒绝（标识 / 数量 / 键型 / 已发布根损坏等）
    stepsEl.innerHTML = `<div class="reh-step bad"><span class="reh-step-no">批</span>` +
      `<span class="reh-step-out"><span class="reh-step-bad">✘ 整批拒绝 <code>${escapeHtml(data.code)}</code>：${escapeHtml(data.reason)}</span>` +
      `没有逐项应用结果，也没有任何写入。</span></div>`;
  } else {
    const rows = edits.map((e, i) => {
      const step = data.steps.find((s) => s.index === i);
      let cell;
      if (!step) {
        cell = '<span class="reh-step-skip">— 前序编辑被拒绝，本项未应用</span>';
      } else if (!step.ok) {
        cell = `<span class="reh-step-bad">✘ 拒绝 <code>${escapeHtml(step.code)}</code>：${escapeHtml(step.reason)}</span>`;
      } else if (step.replayed) {
        cell = `<span class="reh-step-good">↺ 回放</span>` +
          `<span class="reh-step-ok">该批次已终局，提交将幂等回放原回执，本项不再作用于已发布根</span>`;
      } else {
        const evs = (data.structural?.[i] ?? []);
        const detail = evs.length
          ? evs.map((t) => `<span class="reh-ev">${escapeHtml(t)}</span>`).join('')
          : '<span class="reh-step-ok">接纳，未引发分裂 / 借位 / 合并</span>';
        cell = `<span class="reh-step-good">✓ 接纳</span>${detail}`;
      }
      return `<div class="reh-step ${step && !step.ok ? 'bad' : ''} ${!step ? 'skip' : ''}">` +
        `<span class="reh-step-no">#${i + 1}</span><span class="reh-step-edit">${escapeHtml(editText(e))}</span>` +
        `<span class="reh-step-out">${cell}</span></div>`;
    }).join('');
    stepsEl.innerHTML = rows || '<div class="empty-hint">无编辑项。</div>';
  }
}

function renderPages(snap) {
  els['pages-out'].innerHTML = snap.pages.map((p) => {
    if (p.type === 'leaf') {
      const cells = p.keys.map((k, i) =>
        `<span class="kv" style="display:inline-block;padding:2px 8px"><b>${k}</b>=${escapeHtml(p.values[i])}</span>`).join('');
      return `<div class="page-box leaf">
        <div class="page-head"><span class="tag">叶页</span><span>代次 ${p.gen} · 深 ${p.depth} · ${p.keys.length} 键</span>
        <span class="pdigest">digest ${p.digest}</span><span class="pid">${p.id}</span></div>
        <div class="page-body">${cells || '<span style="color:var(--muted)">（空叶）</span>'}</div></div>`;
    }
    const layout = [];
    for (let i = 0; i < p.children.length; i++) {
      layout.push(`<span class="child-ref" title="子页引用">${p.children[i].slice(0, 10)}…</span>`);
      if (i < p.keys.length) layout.push(`<span class="arrow">◀</span><span class="sep">[${p.keys[i]}]</span><span class="arrow">▶</span>`);
    }
    return `<div class="page-box internal">
      <div class="page-head"><span class="tag">内部页</span><span>代次 ${p.gen} · 深 ${p.depth} · ${p.children.length} 子 / ${p.keys.length} 分隔键</span>
      <span class="pdigest">digest ${p.digest}</span><span class="pid">${p.id}</span></div>
      <div class="page-body">${layout.join('')}</div></div>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot().catch((e) => {
  els['recovery-banner'].className = 'banner unhealthy';
  els['recovery-banner'].innerHTML = `<span class="banner-title">启动失败</span>${escapeHtml(e.stack || e.message)}`;
});

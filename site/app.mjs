// 浏览器端控制层：连接 IndexedDB 与引擎，渲染录入、批次、断电演练与结果页。
import { Engine, CRASH_POINTS, editDigestOf } from './src/engine.mjs';
import { IDBStore } from './src/store.mjs';

const $ = (id) => document.getElementById(id);
const els = {};
for (const id of [
  'recovery-banner', 'init-card', 'init-input', 'init-count', 'btn-init', 'btn-sample',
  'batch-card', 'batch-id', 'edit-table', 'edit-count', 'btn-add-edit', 'crash-point',
  'btn-preview', 'btn-submit', 'btn-reopen', 'btn-lookup', 'lookup-key', 'btn-reset',
  'receipt-out', 'r-gen', 'r-pages', 'r-kinds', 'r-keys', 'r-order-badge', 'r-once-badge',
  'r-rootid', 'audit-out', 'leafseq', 'pages-out',
  'preview-status', 'preview-body', 'pv-basis', 'pv-compare', 'pv-steps',
  'pv-leafseq', 'pv-pub-leafseq', 'pv-pages',
]) els[id] = $(id);

let engine = null;
const DB_NAME = 'track-exchange-v1';

// 预演状态：只活在内存。结构为
// { batchId, editDigest, basisRootId, basisGen, result, stale, staleReason }。
// stale=true 表示曾为该脚本预演过，但根指针 / 脚本已变化；旧候选不得提交。
let previewState = null;

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
  renderPreviewInitial();
}

function renderPreviewInitial() {
  if (previewState) return;
  els['preview-body'].classList.add('hidden');
  els['preview-status'].className = 'pv-status';
  els['preview-status'].innerHTML =
    '尚未预演：编辑批次脚本后点击「预演结构影响（只读）」。预演只在当前页面内存中计算，'
    + '<strong>不写入页、不留下意图、不产生回执</strong>，刷新页面即消失。';
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
    invalidatePreview('root-changed'); // 初始索引变更使任何旧候选失去基准
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
    tr.remove(); recountEdits(); invalidatePreview('edit-removed');
  });
  tr.querySelector('.sel-op').addEventListener('change', () => {
    tr.querySelector('.inp-value').disabled = tr.querySelector('.sel-op').value === 'delete';
    invalidatePreview('edit-changed');
  });
  // 重新录入任一编辑（键或载荷）即令既有预演失效
  tr.querySelector('.inp-key').addEventListener('input', () => invalidatePreview('edit-changed'));
  tr.querySelector('.inp-value').addEventListener('input', () => invalidatePreview('edit-changed'));
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
  invalidatePreview('edit-added');
});

els['batch-id'].addEventListener('input', () => invalidatePreview('batch-id-changed'));

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

// ---------- 预演：只读、仅内存，根指针或脚本一变即失效 ----------

const INVALID_REASON = {
  'edit-changed': '脚本内容已被重新录入',
  'edit-added': '脚本新增了编辑项',
  'edit-removed': '脚本删除了编辑项',
  'batch-id-changed': '批次标识已变更',
  'root-changed': '已发布根指针已变化（发生过提交 / 恢复 / 初始索引变更）',
  'refresh': '页面已刷新，内存预演不会跨重开保留',
};

function invalidatePreview(reason) {
  if (!previewState || previewState.stale) return;
  previewState.stale = true;
  previewState.staleReason = reason;
  renderPreviewStale(previewState, INVALID_REASON[reason] ?? reason);
}

async function runPreview() {
  if (engine.state?.rootId == null) {
    flashReceipt('请先建立初始索引，再预演批次');
    return;
  }
  const batchId = els['batch-id'].value.trim();
  const edits = collectEdits();
  const result = await engine.previewBatch(edits, batchId);
  // 记录预演所绑定的根指针 + 规范化脚本摘要；不保存任何可提交的候选页
  previewState = {
    batchId,
    editDigest: safeDigest(edits),
    basisRootId: result.basis?.rootId ?? engine.state.rootId,
    basisGen: result.basis?.gen ?? engine.state.gen,
    result,
    stale: false,
    staleReason: null,
  };
  showReceipt(stripCandidate(result));
  renderPreview();
}

// 回执区不显示整棵候选树（候选细节只在结果区、且明确标注仅内存）
function stripCandidate(result) {
  if (result.status !== 'preview') return result;
  const { pages, leafSequence, ...head } = result.candidate;
  return {
    status: result.status, batchId: result.batchId, basis: result.basis,
    candidate: {
      ...head,
      leafKeys: leafSequence.map((x) => x.key),
    },
    steps: result.steps.length,
    note: result.note,
    previewAt: result.previewAt,
  };
}

function safeDigest(edits) {
  try { return editDigestOf(edits); } catch { return null; }
}

els['btn-preview'].addEventListener('click', async () => {
  try { await runPreview(); }
  catch (e) {
    previewState = null;
    renderPreviewStale(null, `预演失败：${e.message}`);
  }
});

// 提交门禁：只有“曾对同一脚本预演、但绑定根已变化”这一情况必须先重新预演。
// 两种例外保持原有提交行为不变：
//   1) 批次已有等价终局回执 -> 引擎回放原回执，根不动（幂等回执）；
//   2) 同批次中断后等价重试 -> 引擎走正常三阶段完成它。
// 从未预演的提交仍按原行为直接进入引擎（拒因由引擎给出）。
async function submitGuard(batchId, edits) {
  const digest = safeDigest(edits);
  const previewedSame = previewState
    && previewState.batchId === batchId
    && previewState.editDigest === digest;
  if (!previewedSame) return true;

  const rootMoved = previewState.basisRootId !== engine.state.rootId
    || previewState.basisGen !== engine.state.gen;
  if (!rootMoved) return true;

  if (batchId) {
    const prior = await engine.store.get('receipt:' + batchId);
    if (prior && prior.editDigest === digest) return true;
    const intent = await engine.store.get('intent');
    if (intent && intent.batchId === batchId) return true;
  }
  invalidatePreview('root-changed');
  flashReceipt('预演所依据的根已变化，请先重新预演，再提交该批次');
  return false;
}

els['btn-submit'].addEventListener('click', async () => {
  const batchId = els['batch-id'].value.trim();
  const edits = collectEdits();
  if (!(await submitGuard(batchId, edits))) return;

  const crashAt = els['crash-point'].value;
  const receipt = await engine.submitBatch(edits, batchId, crashAt);
  showReceipt(receipt);
  if (receipt.status === 'interrupted') {
    // 真实演练：直接模拟“进程死亡”，要求审查员点重开复核（或刷新页面）
    bannerInterrupt(receipt);
    // 根在内存视图尚未切换，但持久化证据已变化；旧预演不再可信
    invalidatePreview('root-changed');
  } else if (receipt.status === 'committed' && !receipt.replayed) {
    // 新根已发布：任何旧预演的基准都已失效
    invalidatePreview('root-changed');
  }
  render();
});

els['btn-reopen'].addEventListener('click', async () => {
  const report = await engine.recover();
  showRecovery(report);
  showReceipt({ status: 'reopened', ...report });
  // 恢复可能发布新根或回滚意图：预演基准须重新核对
  invalidatePreview('root-changed');
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
  els['btn-preview'].disabled = !initialized;
  if (!initialized) {
    ['r-gen', 'r-pages', 'r-kinds', 'r-keys'].forEach((k) => (els[k].textContent = '—'));
    els['r-rootid'].textContent = '尚未建立索引';
    els['leafseq'].innerHTML = '<div class="empty-hint">录入初始航点后展示。</div>';
    els['pages-out'].innerHTML = '<div class="empty-hint">尚无页。</div>';
    els['audit-out'].innerHTML = '<div class="empty-hint">尚无审计结果。</div>';
    setBadge('r-order-badge', false, '—');
    setBadge('r-once-badge', false, '—');
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
  syncPreviewWithPublished();
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

function renderLeafSequence(snap, target = els.leafseq) {
  // 按叶页分组（snap.leafSequence 每项带 pageId），交替底色
  const groups = [];
  for (const item of snap.leafSequence) {
    let g = groups[groups.length - 1];
    if (!g || g.pageId !== item.pageId) { g = { pageId: item.pageId, items: [] }; groups.push(g); }
    g.items.push(item);
  }
  if (!groups.length) {
    target.innerHTML = '<div class="empty-hint">空树（无键）。</div>';
    return;
  }
  target.innerHTML = groups.map((g, i) => {
    const short = g.pageId.slice(0, 10);
    const cells = g.items.map((it) =>
      `<div class="kv"><div class="k">${it.key}</div><div class="v">${escapeHtml(it.value)}</div></div>`).join('');
    const arrow = i < groups.length - 1 ? '<span class="leaf-arrow">→</span>' : '';
    return `<span class="leaf-block ${i % 2 ? 'b' : 'a'}"><span class="leaf-head">叶 ${short}… · ${g.items.length} 键</span>` +
      `<span class="cells">${cells}</span></span>${arrow}`;
  }).join('');
}

function renderPages(snap, target = els['pages-out']) {
  target.innerHTML = snap.pages.map((p) => {
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

// ---------- 预演结果渲染 ----------

const EVENT_LABEL = {
  'leaf-split': '叶分裂',
  'internal-split': '内部分裂',
  'root-promote': '根提升（树加高）',
  'leaf-merge': '叶合并',
  'internal-merge': '内部合并',
  'root-shrink': '根收缩（树降高）',
  borrow: '兄弟借位',
};

const OP_LABEL = { insert: '插入', update: '更新', delete: '删除' };

function renderPreview() {
  const status = els['preview-status'];
  const body = els['preview-body'];
  const r = previewState?.result;
  if (!previewState || !r) {
    body.classList.add('hidden');
    return;
  }
  if (previewState.stale) {
    body.classList.add('hidden');
    status.className = 'pv-status stale';
    const reason = INVALID_REASON[previewState.staleReason] ?? previewState.staleReason ?? '基准变化';
    status.innerHTML = `✘ 旧预演已失效：${escapeHtml(reason)}（旧预演时刻 ${escapeHtml(r.previewAt ?? '—')}）。`
      + '旧候选仅存在于内存且<strong>不可当作可提交结果</strong>，请重新点击「预演结构影响」。';
    return;
  }
  body.classList.remove('hidden');

  // 预演时根可能在他处已被改变（正常不会，失效逻辑先行处理）；这里仍显式标注
  const basisFresh = engine.previewMatchesBasis(r.basis);
  status.className = 'pv-status ' + (basisFresh ? 'ok' : 'stale');
  const readonlyNote = '<strong>预演只在内存中计算，没有写入页、没有留下意图、没有回执；提交后才会真正落盘。</strong>';
  if (!basisFresh) {
    // 防御路径：同步时发现根已变（如他标签页提交）——直接转失效，不展示旧候选
    previewState.stale = true;
    previewState.staleReason = 'root-changed';
    body.classList.add('hidden');
    status.className = 'pv-status stale';
    status.innerHTML = '✘ 预演已失效：绑定的根指针与当前已发布根不一致，请重新预演，旧候选不得提交。';
    return;
  }
  if (r.status === 'rejected') {
    status.innerHTML = '✔ 预演完成：基准一致，但脚本被拒绝，整批不会执行（无候选）。' + readonlyNote;
  } else if (r.status === 'preview-replay') {
    status.innerHTML = '✔ 预演完成：基准一致；该批次已有等价终局回执，提交只会回放。' + readonlyNote;
  } else {
    status.innerHTML = '✔ 预演有效：绑定的根指针与当前已发布根一致，脚本未变动。' + readonlyNote;
  }

  renderPreviewBasis(r);
  if (r.status === 'rejected') { renderPreviewRejected(r); return; }
  if (r.status === 'preview-replay') { renderPreviewReplay(r); return; }
  renderPreviewCandidate(r);
}

function renderPreviewBasis(r) {
  const b = r.basis;
  els['pv-basis'].className = 'pv-basis';
  els['pv-basis'].innerHTML = `
    <div class="pv-basis-row"><span class="pv-k">所依据根代次</span><code>${b.gen}</code></div>
    <div class="pv-basis-row"><span class="pv-k">根指针</span><code>${escapeHtml(b.rootId ?? '—')}</code></div>
    <div class="pv-basis-row"><span class="pv-k">基准键数</span><code>${b.keyCount}</code></div>
    <div class="pv-basis-row"><span class="pv-k">规范化脚本摘要</span><code>${escapeHtml(b.editDigest)}</code></div>
    <div class="pv-basis-row"><span class="pv-k">脚本项数</span><code>${b.edits.length}</code></div>
    <div class="pv-basis-row"><span class="pv-k">预演时刻</span><code>${escapeHtml(b.at)}</code></div>`;
}

function renderPreviewRejected(r) {
  els['pv-compare'].className = 'pv-compare';
  els['pv-compare'].innerHTML = `
    <div class="pv-reject">
      <div class="pv-reject-title">✘ 预演拒绝：整批脚本不会执行（与正式提交同源拒因，提交时会得到相同中文原因）</div>
      <div class="pv-reject-code">${escapeHtml(r.code)}</div>
      <div class="pv-reject-reason">${escapeHtml(r.reason)}</div>
      <div class="pv-reject-meta">${r.failedAt ? `中断于第 ${r.failedAt} 项编辑；` : ''}
        已成功预演 ${r.steps?.length ?? 0} 项（仅内存，无任何写入）</div>
    </div>`;
  // 拒绝时无候选：清空候选细节，仅保留已发布对照
  els['pv-leafseq'].innerHTML = '<div class="empty-hint">无候选：脚本被拒绝。</div>';
  els['pv-pages'].innerHTML = '';
  els['pv-steps'].innerHTML = renderSteps(r.steps ?? [], r.failedAt);
  renderPublishedCompare();
}

function renderPreviewReplay(r) {
  els['pv-compare'].className = 'pv-compare';
  els['pv-compare'].innerHTML = `
    <div class="pv-replay">
      <div class="pv-reject-title">↩ 批次标识已有等价终局回执</div>
      <div>${escapeHtml(r.note)}</div>
      <pre class="receipt">${escapeHtml(JSON.stringify(r.receipt, null, 2))}</pre>
    </div>`;
  els['pv-leafseq'].innerHTML = '<div class="empty-hint">无新候选：提交将回放原回执，键序与页结构不变。</div>';
  els['pv-pages'].innerHTML = '';
  els['pv-steps'].innerHTML = '';
  renderPublishedCompare();
}

function renderPreviewCandidate(r) {
  const c = r.candidate;
  const chipList = (ks, cls) => ks.length
    ? ks.map((k) => `<span class="chip ${cls}">${escapeHtml(String(k))}</span>`).join('')
    : '<span class="empty-hint" style="display:inline">无</span>';

  els['pv-compare'].className = 'pv-compare';
  els['pv-compare'].innerHTML = `
    <div class="pv-stat"><span class="pv-stat-k">候选根代次</span><strong>${c.gen}</strong></div>
    <div class="pv-stat"><span class="pv-stat-k">候选根指针</span><code>${escapeHtml(c.rootId)}</code></div>
    <div class="pv-stat"><span class="pv-stat-k">可达页（内 / 叶）</span><strong>${c.reachablePages}（${c.internalCount} / ${c.leafCount}）</strong></div>
    <div class="pv-stat"><span class="pv-stat-k">候选键总数</span><strong>${c.keyCount}</strong></div>
    <div class="pv-stat delta-add"><span class="pv-stat-k">预计新增页</span><strong>+${c.addedPages}</strong></div>
    <div class="pv-stat delta-del"><span class="pv-stat-k">提交后不再可达页</span><strong>-${c.unreachablePages}</strong></div>
    <div class="pv-stat delta-add"><span class="pv-stat-k">预计新增键</span><strong>${chipList(c.addedKeys, 'add-chip')}</strong></div>
    <div class="pv-stat delta-del"><span class="pv-stat-k">预计不再可达键</span><strong>${chipList(c.removedKeys, 'del-chip')}</strong></div>
    <div class="pv-stat ${c.allKeysOnce ? 'ok-text' : 'bad-text'}">
      <span class="pv-stat-k">候选有序 / 每键一次</span>
      <strong>${c.ordered ? '严格递增' : '失序'} / ${c.allKeysOnce ? '是' : '否'}</strong>
    </div>`;

  const candSnap = { leafSequence: c.leafSequence };
  renderLeafSequence(candSnap, els['pv-leafseq']);
  renderPublishedCompare();
  els['pv-steps'].innerHTML = renderSteps(r.steps);
  renderPages({ pages: c.pages }, els['pv-pages']);
}

function renderPublishedCompare() {
  // 已发布一侧始终取当前真实快照，明确它来自 IndexedDB 根而非候选
  const snap = engine.state?.rootId != null ? engine.snapshot() : null;
  if (!snap) {
    els['pv-pub-leafseq'].innerHTML = '<div class="empty-hint">尚未建立索引。</div>';
    return;
  }
  renderLeafSequence(snap, els['pv-pub-leafseq']);
}

function renderSteps(steps, failedAt = null) {
  if (!steps.length) return '<div class="empty-hint">无已完成步骤。</div>';
  return steps.map((s) => {
    const ev = s.events.length
      ? s.events.map((e) => `<span class="step-event">${EVENT_LABEL[e] ?? e}</span>`).join('')
      : '<span class="step-event none">无结构分裂/合并</span>';
    const payload = s.op.op === 'delete' ? '' : ` = ${escapeHtml(s.op.value ?? '')}`;
    return `<div class="step ${failedAt === s.index ? 'failed' : ''}">
      <div class="step-head"><span class="step-idx">#${s.index}</span>
        <span class="step-op op-${s.op.op}">${OP_LABEL[s.op.op] ?? s.op.op}</span>
        <code class="step-key">${s.op.key}</code><span class="step-val">${payload}</span>${ev}</div>
      <div class="step-before">执行前：${s.before.keys.length} 键 · ${s.before.internalCount} 内 / ${s.before.leafCount} 叶 · 高 ${s.before.height} · 根 <code>${escapeHtml(s.before.rootId.slice(0, 10))}…</code></div>
      <div class="step-after">执行后：${s.after.keys.length} 键 · ${s.after.internalCount} 内 / ${s.after.leafCount} 叶 · 高 ${s.after.height} · 根 <code>${escapeHtml(s.after.rootId.slice(0, 10))}…</code>
        <span class="step-keys">[${s.after.keys.join(', ')}]</span></div>
    </div>`;
  }).join('');
}

// 已发布根变化后，预演面板转失效横幅；脚本变化同理
function renderPreviewStale(prev, reason) {
  const status = els['preview-status'];
  const body = els['preview-body'];
  body.classList.add('hidden');
  status.className = 'pv-status stale';
  const when = prev?.result?.previewAt ? `（旧预演时刻 ${prev.result.previewAt}）` : '';
  status.innerHTML = `✘ 旧预演已失效：${escapeHtml(reason)}${when}。旧候选仅存在于内存且<strong>不可当作可提交结果</strong>，请重新点击「预演结构影响」。`;
}

// 每次已发布视图重渲染后核对：根指针变化（如别的标签页提交、恢复）令预演失效
function syncPreviewWithPublished() {
  if (!previewState || previewState.stale) return;
  if (!engine.previewMatchesBasis(previewState.result.basis)) {
    invalidatePreview('root-changed');
  } else if (previewState.editDigest !== safeDigest(collectEdits())) {
    invalidatePreview('edit-changed');
  } else {
    renderPreview(); // 刷新已发布对照侧
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot().catch((e) => {
  els['recovery-banner'].className = 'banner unhealthy';
  els['recovery-banner'].innerHTML = `<span class="banner-title">启动失败</span>${escapeHtml(e.stack || e.message)}`;
});

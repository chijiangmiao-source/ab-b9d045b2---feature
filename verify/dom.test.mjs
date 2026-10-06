// 页面控制层冒烟：用精简 DOM 垫片实际执行 app.mjs 的启动与事件处理，
// 覆盖初始化、分裂批次、断电中断横幅、重开恢复、结果页渲染、查询等路径。
// 目的：在无浏览器环境捕获 app.mjs 的运行时错误（空引用、ID 拼错等）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from './fake-idb.mjs';

process.on('unhandledRejection', (e) => { console.error('UNHANDLED REJECTION:', e.stack); });

// ---------- 最小 DOM ----------
class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : force;
    this.set[on ? 'add' : 'delete'](c);
    return on;
  }
  contains(c) { return this.set.has(c); }
}

class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.classList = new ClassList();
    this.listeners = {};
    this._value = '';
    this._text = '';
    this._html = '';
    this.disabled = false;
    this.className = '';
    this.style = {};
  }
  addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
  dispatch(ev, evObj) {
    return (this.listeners[ev] ?? []).map((fn) => fn(evObj ?? { target: this }));
  }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  remove() {
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
    }
  }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    // 不做真实 HTML 解析；赋值即清空子节点（TR 的固定模板再登记命名子节点）
    this._html = String(v);
    this.children = [];
    if (this.tagName === 'TR') {
      const sel = new El('select'); sel.cls.add('sel-op');
      const key = new El('input'); key.cls.add('inp-key');
      const val = new El('input'); val.cls.add('inp-value');
      const btn = new El('button');
      this.appendChild(wrap(sel, 'td')); this.appendChild(wrap(key, 'td'));
      this.appendChild(wrap(val, 'td')); this.appendChild(wrap(btn, 'td'));
    }
  }
  get cls() {
    // 类名集合（供 querySelector(.x) 匹配）
    this._cls ??= new Set();
    return this._cls;
  }
  _match(sel) {
    if (sel.startsWith('.')) return this._cls?.has(sel.slice(1)) || this.classList.contains(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  _walk(out) {
    for (const c of this.children) { out.push(c); c._walk(out); }
  }
  querySelector(sel) {
    const parts = sel.split(/\s+/);
    let scope = [this];
    for (const part of parts) {
      const next = [];
      for (const s of scope) {
        const all = [];
        s._walk(all);
        next.push(...all.filter((e) => e._match(part)));
      }
      scope = next;
    }
    return scope[0] ?? null;
  }
  querySelectorAll(sel) {
    const parts = sel.split(/\s+/);
    let scope = [this];
    for (const part of parts) {
      const next = [];
      for (const s of scope) {
        const all = [];
        s._walk(all);
        next.push(...all.filter((e) => e._match(part)));
      }
      scope = next;
    }
    return scope;
  }
}
function wrap(el, tag) { const td = new El(tag); td.appendChild(el); return td; }

const ids = new Map();
function byId(id) {
  if (!ids.has(id)) {
    const e = new El('div');
    e.id = id;
    if (id === 'edit-table') {
      const tb = new El('tbody');
      e.appendChild(tb);
    }
    if (id.startsWith('r-order-badge') || id.startsWith('r-once-badge')) {
      e.appendChild(new El('strong'));
    }
    ids.set(id, e);
  }
  return ids.get(id);
}

globalThis.document = {
  getElementById: byId,
  createElement: (t) => new El(t),
};
globalThis.confirm = () => true;
const reloads = [];
globalThis.location = { reload: () => reloads.push(1) };

installFakeIndexedDB();
const indexeddb = globalThis.indexedDB;

test('页面启动为空库，录入 + 预演 + 分裂批次 + 各事件路径无运行时错误', async () => {
  // app.mjs 在导入时即 boot()
  const { Engine } = await import('../site/src/engine.mjs');
  await import('../site/app.mjs');
  await new Promise((r) => setTimeout(r, 20));

  const banner = byId('recovery-banner');
  assert.match(banner.innerHTML, /空库/);
  assert.equal(byId('btn-submit').disabled, true);

  // 初始录入 7 键
  byId('init-input').value = '10,十\n20,廿\n30,卅\n40,四十\n50,五十\n60,六十\n70,七十';
  byId('init-input').dispatch('input');
  assert.equal(byId('init-count').textContent, '7');
  await Promise.all(byId('btn-init').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(byId('r-gen').textContent, '1');
  assert.match(byId('r-kinds').textContent, /1 \/ 3/, '7 键 -> 1 内部页 3 叶页');
  assert.match(byId('audit-out').innerHTML, /分裂审计通过/);
  assert.equal(byId('btn-submit').disabled, false);
  assert.match(byId('leafseq').innerHTML, /叶 /);

  // 增加一项分裂批次
  byId('btn-add-edit').dispatch('click');
  const tr = byId('edit-table').querySelectorAll('tbody tr')[0];
  tr.querySelector('.inp-key').value = '5';
  tr.querySelector('.inp-value').value = '五';
  byId('batch-id').value = 'ui-batch';

  // 未预演直接提交：门禁拒绝，要求先预演
  await Promise.all(byId('btn-submit').dispatch('click'));
  let rcpt = JSON.parse(byId('receipt-out').textContent);
  assert.equal(rcpt.status, 'rejected');
  assert.equal(rcpt.requiresRehearsal, true);
  assert.match(rcpt.code, /NO_REHEARSAL/);
  assert.equal(byId('r-gen').textContent, '1', '门禁拒绝不改变根');

  // 预演：仅内存，展示基准代次、候选代次、新增/不可达页、逐项接纳
  await Promise.all(byId('btn-rehearse').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  rcpt = JSON.parse(byId('receipt-out').textContent);
  assert.equal(rcpt.status, 'rehearsed');
  assert.equal(rcpt.inMemoryOnly, true);
  assert.equal(rcpt.baseGen, 1);
  assert.equal(rcpt.candidateGen, 2);
  assert.match(byId('rehearse-status').innerHTML, /预演有效 · 仅内存/);
  assert.match(byId('rehearse-status').innerHTML, /没有写入页、意图或回执/);
  assert.match(byId('rh-cand').innerHTML, /根代次/);
  assert.match(byId('rh-pub').innerHTML, /根代次/);
  assert.match(byId('rehearse-steps').innerHTML, /接纳/);
  // 已发布视图仍停在代次 1（预演不写页）
  assert.equal(byId('r-gen').textContent, '1');

  // 预演后改动脚本 -> 预演明确失效；此时提交被门禁拒绝
  tr.querySelector('.inp-key').dispatch('input', { target: tr.querySelector('.inp-key') });
  assert.match(byId('rehearse-status').innerHTML, /预演已失效 · 不可提交/);
  await Promise.all(byId('btn-submit').dispatch('click'));
  rcpt = JSON.parse(byId('receipt-out').textContent);
  assert.equal(rcpt.status, 'rejected');
  assert.match(rcpt.code, /NO_REHEARSAL|SCRIPT_CHANGED/);

  // 基准重新一致（内容未变、仅触发了一次 input）：重新预演后提交 -> 正常落根到代次 2
  await Promise.all(byId('btn-rehearse').dispatch('click'));
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(JSON.parse(byId('receipt-out').textContent).status, /committed/);
  assert.equal(byId('r-gen').textContent, '2');

  // 冲突重传：内容不同。预演在内存中即给出与提交一致的 CONFLICT_BATCH_CONTENT 拒因
  tr.querySelector('.inp-key').value = '99';
  tr.querySelector('.inp-value').value = '九九';
  await Promise.all(byId('btn-rehearse').dispatch('click'));
  assert.match(byId('rehearse-status').innerHTML, /预演被拒绝/);
  assert.match(byId('rehearse-status').innerHTML, /CONFLICT_BATCH_CONTENT/);
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  const rej = JSON.parse(byId('receipt-out').textContent);
  assert.equal(rej.code, 'CONFLICT_BATCH_CONTENT');
  assert.equal(byId('r-gen').textContent, '2');

  // 等价重传：改回原脚本（真实输入会令旧预演失效），未重新预演前提交被门禁拦下
  tr.querySelector('.inp-key').value = '5';
  tr.querySelector('.inp-value').value = '五';
  tr.querySelector('.inp-key').dispatch('input');
  await Promise.all(byId('btn-submit').dispatch('click'));
  assert.match(JSON.parse(byId('receipt-out').textContent).code, /NO_REHEARSAL|SCRIPT_CHANGED/);
  // 重新预演：识别为等价编辑 -> 将幂等回放；提交回放原回执
  await Promise.all(byId('btn-rehearse').dispatch('click'));
  assert.match(byId('rehearse-status').innerHTML, /将幂等回放/);
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(JSON.parse(byId('receipt-out').textContent).replayed, true);
  assert.equal(byId('r-gen').textContent, '2', '回放不前进代次');

  // 查询
  byId('lookup-key').value = '5';
  byId('btn-lookup').dispatch('click');
  assert.equal(JSON.parse(byId('receipt-out').textContent).value, '五');
  byId('lookup-key').value = '404';
  byId('btn-lookup').dispatch('click');
  assert.equal(JSON.parse(byId('receipt-out').textContent).found, false);

  // 断电演练（after-intent）：先预演同一脚本再提交中断
  byId('crash-point').value = 'after-intent';
  tr.querySelector('.inp-key').value = '77';
  tr.querySelector('.inp-value').value = '七十七';
  byId('batch-id').value = 'ui-crash';
  await Promise.all(byId('btn-rehearse').dispatch('click'));
  assert.match(byId('rehearse-status').innerHTML, /预演有效/);
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(banner.innerHTML, /模拟断电中断/);
  assert.equal(JSON.parse(byId('receipt-out').textContent).status, 'interrupted');
  // 中断触碰了持久化，预演须明确失效
  assert.match(byId('rehearse-status').innerHTML, /预演已失效/);

  await Promise.all(byId('btn-reopen').dispatch('click'));
  await new Promise((r) => setTimeout(r, 20));
  assert.match(banner.innerHTML, /发布完整新根/);
  assert.equal(byId('r-gen').textContent, '3');
  // 重开复核后旧预演仍标示失效，旧候选不会被当作可提交结果
  assert.match(byId('rehearse-status').innerHTML, /预演已失效/);

  // 抹库：confirm 已垫片为 true，deleteDatabase 后应触发 reload
  await Promise.all(byId('btn-reset').dispatch('click'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reloads.length, 1);
});

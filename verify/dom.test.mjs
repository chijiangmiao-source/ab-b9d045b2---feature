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
// 第二个用例重导 app.mjs 前清空元素缓存：旧模块的监听器仍挂在旧元素上，
// 但新 boot 绑定的是全新元素，互不串扰。
globalThis.__resetDomIds = () => ids.clear();

globalThis.document = {
  getElementById: byId,
  createElement: (t) => new El(t),
};
globalThis.confirm = () => true;
const reloads = [];
globalThis.location = { reload: () => reloads.push(1) };

installFakeIndexedDB();
const indexeddb = globalThis.indexedDB;

test('页面启动为空库，录入 + 分裂批次 + 各事件路径无运行时错误', async () => {
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
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(byId('r-gen').textContent, '2');
  assert.match(byId('audit-out').innerHTML, /期望 8 键/);
  assert.match(JSON.parse(byId('receipt-out').textContent).status, /committed/);

  // 冲突重传：内容不同
  tr.querySelector('.inp-key').value = '99';
  tr.querySelector('.inp-value').value = '九九';
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  const rej = JSON.parse(byId('receipt-out').textContent);
  assert.equal(rej.code, 'CONFLICT_BATCH_CONTENT');
  assert.equal(byId('r-gen').textContent, '2');

  // 等价重传：回放原回执
  tr.querySelector('.inp-key').value = '5';
  tr.querySelector('.inp-value').value = '五';
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(JSON.parse(byId('receipt-out').textContent).replayed, true);

  // 查询
  byId('lookup-key').value = '5';
  byId('btn-lookup').dispatch('click');
  assert.equal(JSON.parse(byId('receipt-out').textContent).value, '五');
  byId('lookup-key').value = '404';
  byId('btn-lookup').dispatch('click');
  assert.equal(JSON.parse(byId('receipt-out').textContent).found, false);

  // 断电演练（after-intent）+ 重开复核
  byId('crash-point').value = 'after-intent';
  tr.querySelector('.inp-key').value = '77';
  tr.querySelector('.inp-value').value = '七十七';
  byId('batch-id').value = 'ui-crash';
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(banner.innerHTML, /模拟断电中断/);
  assert.equal(JSON.parse(byId('receipt-out').textContent).status, 'interrupted');

  await Promise.all(byId('btn-reopen').dispatch('click'));
  await new Promise((r) => setTimeout(r, 20));
  assert.match(banner.innerHTML, /发布完整新根/);
  assert.equal(byId('r-gen').textContent, '3');

  // 抹库：confirm 已垫片为 true，deleteDatabase 后应触发 reload
  await Promise.all(byId('btn-reset').dispatch('click'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reloads.length, 1);
});

test('预演面板：只读预演、并列对照、逐项结果、编辑/提交后失效、拒因与重放', async () => {
  installFakeIndexedDB();
  globalThis.__resetDomIds();
  // app.mjs 已导入且 boot 过一次；以查询串绕过模块缓存重跑 boot 到新的（已清空的）垫片库
  await import('../site/app.mjs?fresh=' + Date.now());
  await new Promise((r) => setTimeout(r, 20));

  byId('init-input').value = '10,十\n20,廿\n30,卅';
  byId('init-input').dispatch('input');
  await Promise.all(byId('btn-init').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));

  // 未预演时按钮可用，结果区为引导文案
  assert.equal(byId('btn-preview').disabled, false);
  assert.match(byId('preview-status').innerHTML, /尚未预演/);

  // 录入脚本：插入 5（单叶 3 键 -> 第 4 键触发叶分裂与根提升）+ 更新 20
  byId('btn-add-edit').dispatch('click');
  const tr = byId('edit-table').querySelectorAll('tbody tr')[0];
  tr.querySelector('.sel-op').value = 'insert';
  tr.querySelector('.inp-key').value = '5';
  tr.querySelector('.inp-value').value = '五';
  byId('btn-add-edit').dispatch('click');
  const tr2 = byId('edit-table').querySelectorAll('tbody tr')[1];
  tr2.querySelector('.sel-op').value = 'update';
  tr2.querySelector('.inp-key').value = '20';
  tr2.querySelector('.inp-value').value = '廿改';
  byId('batch-id').value = 'ui-pv';

  await Promise.all(byId('btn-preview').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));

  // 预演有效：根代次基准、候选摘要、新增/不可达、并列叶序、逐项结果
  assert.match(byId('preview-status').innerHTML, /预演有效/);
  assert.match(byId('preview-status').innerHTML, /没有写入页|没有留下意图|没有回执|内存/);
  assert.match(byId('pv-basis').innerHTML, /所依据根代次/);
  assert.match(byId('pv-basis').innerHTML, /规范化脚本摘要/);
  assert.match(byId('pv-compare').innerHTML, /候选根代次/);
  assert.match(byId('pv-compare').innerHTML, /预计新增页/);
  assert.match(byId('pv-compare').innerHTML, /提交后不再可达页/);
  assert.match(byId('pv-leafseq').innerHTML, /5/);
  assert.match(byId('pv-pub-leafseq').innerHTML, /10/);
  assert.match(byId('pv-steps').innerHTML, /#1/);
  assert.match(byId('pv-steps').innerHTML, /#2/);
  assert.match(byId('pv-steps').innerHTML, /叶分裂/);
  assert.match(byId('pv-pages').innerHTML, /内部页|叶页/);

  // 预演回执进入最近回执区，但不包含整棵候选树
  const receipt = JSON.parse(byId('receipt-out').textContent);
  assert.equal(receipt.status, 'preview');
  assert.deepEqual(receipt.candidate.leafKeys, [5, 10, 20, 30]);
  assert.match(receipt.note, /内存/);

  // 已发布视图没有变化
  assert.equal(byId('r-gen').textContent, '1');
  assert.equal(byId('r-keys').textContent, '3');

  // 重新录入任一编辑 -> 预演立即失效，且明确不能当作可提交结果
  tr.querySelector('.inp-key').value = '6';
  tr.querySelector('.inp-key').dispatch('input');
  assert.match(byId('preview-status').innerHTML, /旧预演已失效/);
  assert.match(byId('preview-status').innerHTML, /不可当作可提交结果/);
  assert.equal(byId('preview-body').classList.contains('hidden'), true);

  // 重新预演（脚本现为插 6 + 更新 20）后恢复有效
  await Promise.all(byId('btn-preview').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(byId('preview-status').innerHTML, /预演有效/);

  // 基准一致时提交：成功，且提交后预演因根变化失效
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(JSON.parse(byId('receipt-out').textContent).status, 'committed');
  assert.equal(byId('r-gen').textContent, '2');
  assert.match(byId('preview-status').innerHTML, /旧预演已失效/);
  assert.match(byId('preview-status').innerHTML, /根指针已变化/);

  // 拒因预演：重复插入已发布键 -> 中文拒因与提交同源
  tr.querySelector('.inp-key').value = '6';
  tr.querySelector('.sel-op').value = 'insert';
  tr.querySelector('.inp-value').value = '又一个六';
  tr2.querySelector('.sel-op').value = 'delete';
  tr2.querySelector('.inp-key').value = '20';
  byId('batch-id').value = 'ui-pv-reject';
  await Promise.all(byId('btn-preview').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(byId('pv-compare').innerHTML, /预演拒绝/);
  assert.match(byId('pv-compare').innerHTML, /INSERT_EXISTS/);
  assert.match(byId('pv-compare').innerHTML, /键 6 已存在/);
  // 已发布对照仍在
  assert.match(byId('pv-pub-leafseq').innerHTML, /叶 /);
  // 被预演拒绝的脚本没有产生任何写入
  assert.equal(byId('r-gen').textContent, '2');

  // 等价重传预演：批次 ui-pv 已提交，脚本恢复为该批次原内容（插 6(五) + 更新 20）
  tr.querySelector('.inp-key').value = '6';
  tr.querySelector('.inp-value').value = '五';
  tr2.querySelector('.sel-op').value = 'update';
  tr2.querySelector('.inp-key').value = '20';
  tr2.querySelector('.inp-value').value = '廿改';
  byId('batch-id').value = 'ui-pv';
  await Promise.all(byId('btn-preview').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(byId('pv-compare').innerHTML, /等价终局回执/);
  assert.match(JSON.parse(byId('receipt-out').textContent).status, /preview-replay/);
});

test('预演失效门禁：根被别的批次推动后，旧脚本提交必须先重新预演；幂等回放不受影响', async () => {
  installFakeIndexedDB();
  globalThis.__resetDomIds();
  await import('../site/app.mjs?fresh2=' + Date.now());
  await new Promise((r) => setTimeout(r, 20));

  byId('init-input').value = '10,十\n20,廿\n30,卅';
  byId('init-input').dispatch('input');
  await Promise.all(byId('btn-init').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));

  const setRow = (sel, op, key, value) => {
    sel.querySelector('.sel-op').value = op;
    sel.querySelector('.inp-key').value = String(key);
    sel.querySelector('.inp-value').value = value ?? '';
  };

  // 脚本 X：插入 5；先预演但不提交
  byId('btn-add-edit').dispatch('click');
  const tr = byId('edit-table').querySelectorAll('tbody tr')[0];
  setRow(tr, 'insert', 5, '五');
  byId('batch-id').value = 'batch-x';
  await Promise.all(byId('btn-preview').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(byId('preview-status').innerHTML, /预演有效/);

  // 改录脚本 Y（另一批次，从未预演）直接提交：原有行为不变，允许进入引擎
  setRow(tr, 'insert', 99, '九九');
  byId('batch-id').value = 'batch-y';
  await new Promise((r) => setTimeout(r, 0)); // 输入事件已令 X 预演失效
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(JSON.parse(byId('receipt-out').textContent).status, 'committed');
  assert.equal(byId('r-gen').textContent, '2');

  // 录回脚本 X 并提交：此时 X 的预演基准（代次1根）已失效，必须先重新预演
  setRow(tr, 'insert', 5, '五');
  byId('batch-id').value = 'batch-x';
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(byId('receipt-out').textContent, /根已变化/);
  assert.equal(byId('r-gen').textContent, '2', '被拦截，根未前进');
  assert.match(byId('preview-status').innerHTML, /旧预演已失效/);

  // 重新预演后提交成功
  await Promise.all(byId('btn-preview').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(byId('preview-status').innerHTML, /预演有效/);
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  const receipt = JSON.parse(byId('receipt-out').textContent);
  assert.equal(receipt.status, 'committed');
  assert.equal(byId('r-gen').textContent, '3');

  // 幂等回执：同批次等价重传无需再预演，直接回放，根不前进
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  const replay = JSON.parse(byId('receipt-out').textContent);
  assert.equal(replay.status, 'committed');
  assert.equal(replay.replayed, true);
  assert.equal(byId('r-gen').textContent, '3');

  // 未预演的新批次仍可直接提交（保持原有行为；拒因由引擎给）
  setRow(tr, 'insert', 5, '重复');
  byId('batch-id').value = 'batch-z-no-preview';
  await Promise.all(byId('btn-submit').dispatch('click'));
  await new Promise((r) => setTimeout(r, 10));
  const rej = JSON.parse(byId('receipt-out').textContent);
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.code, 'INSERT_EXISTS');
});

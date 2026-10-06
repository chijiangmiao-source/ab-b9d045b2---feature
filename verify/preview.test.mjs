// 预演（只读结构推演）规则测试：
//   - 预演不触碰 IndexedDB：无新页、无意图、根与回执不变
//   - 基准一致时，随后同一批次提交得到与预演相同的键序与页结构摘要
//   - 重复插入 / 缺失更新 / 删除 / 冲突等拒因与正式提交同源（中文原因一致）
//   - 预演绑定根指针：根变化后 basis 失配
//   - 逐项编辑结果与分裂 / 合并 / 借位 / 收缩事件
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, CRASH_POINTS } from '../site/src/engine.mjs';
import { MemoryStore } from '../site/src/store.mjs';

async function freshDb(entries) {
  const store = new MemoryStore();
  const engine = new Engine(store);
  await engine.open();
  await engine.initialize(entries ?? [
    [10, '航点十'], [20, '航点廿'], [30, '卅'], [40, '四十'],
    [50, '五十'], [60, '六十'], [70, '七十'],
  ]);
  return { store, engine };
}

const editsA = [
  { op: 'insert', key: 5, value: '五' },
  { op: 'insert', key: 15, value: '十五' },
  { op: 'insert', key: 25, value: '廿五' },
  { op: 'update', key: 40, value: '四十-改' },
  { op: 'delete', key: 70 },
];

test('预演：只读，不写页、不留意图、不切根、不写回执', async () => {
  const { store, engine } = await freshDb();
  const before = await store.export();

  const pv = await engine.previewBatch(editsA, 'pv-readonly');
  assert.equal(pv.status, 'preview');

  const after = await store.export();
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), '键空间不变');
  for (const k of before.keys()) assert.deepEqual(after.get(k), before.get(k), `记录 ${k} 未被修改`);
  assert.equal(engine.state.gen, 1, '内存代次不前进');
  assert.equal(engine.snapshot().keyCount, 7, '已发布视图不变');
  assert.equal(engine.lookup(5), null);
  assert.equal(engine.lookup(40).value, '四十');
});

test('预演：给出所依据根代次、候选根摘要、页增减、键增减与有序叶序列', async () => {
  const { engine } = await freshDb();
  const pv = await engine.previewBatch(editsA, 'pv-fields');

  assert.equal(pv.basis.gen, 1);
  assert.equal(pv.basis.rootId, engine.state.rootId);
  assert.equal(pv.basis.keyCount, 7);
  assert.equal(typeof pv.basis.editDigest, 'string');
  assert.equal(pv.basis.edits.length, 5, '基准携带规范化脚本');
  assert.deepEqual(pv.basis.edits[3], { op: 'update', key: 40, value: '四十-改' });

  const c = pv.candidate;
  assert.equal(c.gen, 2);
  assert.match(c.rootId, /^p[0-9a-f]{16}$/);
  assert.ok(c.addedPages >= 1);
  assert.ok(c.unreachablePages >= 1);
  assert.deepEqual(c.addedKeys, [5, 15, 25]);
  assert.deepEqual(c.removedKeys, [70]);
  assert.deepEqual(c.leafSequence.map((x) => x.key), [5, 10, 15, 20, 25, 30, 40, 50, 60]);
  assert.equal(c.ordered, true);
  assert.equal(c.allKeysOnce, true);
  assert.equal(c.audit.pass, true);
  assert.equal(c.keyCount, 9);
});

test('预演：逐项记录每项编辑后的键序、根与结构事件', async () => {
  const { engine } = await freshDb();
  const pv = await engine.previewBatch(editsA, 'pv-steps');
  assert.equal(pv.steps.length, 5);
  assert.deepEqual(pv.steps.map((s) => s.index), [1, 2, 3, 4, 5]);
  assert.deepEqual(pv.steps.map((s) => s.op.op), ['insert', 'insert', 'insert', 'update', 'delete']);

  // 初始树 3 叶为 [10,20][30,40][50,60,70]：插入 5 后首叶变 3 键，再插 15 触发叶分裂
  assert.deepEqual(pv.steps[0].events, []);
  assert.ok(pv.steps[1].events.includes('leaf-split'));
  // 第 4 步更新不改键序
  assert.deepEqual(pv.steps[3].before.keys, pv.steps[3].after.keys);
  // 每步 after 键序都严格递增
  for (const s of pv.steps) {
    const ks = s.after.keys;
    for (let i = 1; i < ks.length; i++) assert.ok(ks[i - 1] < ks[i]);
  }
  // 最后一步后键序与候选一致
  assert.deepEqual(pv.steps[4].after.keys, pv.candidate.leafSequence.map((x) => x.key));
});

test('预演：基准一致时，同一批次提交得到完全相同的键序与页结构（候选根 id 相同）', async () => {
  const { engine } = await freshDb();
  const pv = await engine.previewBatch(editsA, 'pv-then-commit');
  assert.ok(engine.previewMatchesBasis(pv.basis), '提交前基准一致');

  const receipt = await engine.submitBatch(editsA, 'pv-then-commit');
  assert.equal(receipt.status, 'committed');
  assert.equal(receipt.rootId, pv.candidate.rootId, '内容寻址 => 候选根即提交根');

  const snap = engine.snapshot();
  assert.equal(snap.gen, 2);
  assert.deepEqual(snap.leafSequence.map((x) => x.key), pv.candidate.leafSequence.map((x) => x.key));
  assert.deepEqual(
    snap.pages.map((p) => p.id).sort(),
    pv.candidate.pages.map((p) => p.id).sort(),
    '可达页集合与预演候选一致',
  );
  assert.equal(snap.reachablePages, pv.candidate.reachablePages);
  assert.equal(snap.internalCount, pv.candidate.internalCount);
  assert.equal(snap.leafCount, pv.candidate.leafCount);
  // 预演判定的“不再可达页”即提交后被回收的旧版本页
  const unreachable = pv.candidate.unreachablePageIds;
  for (const id of unreachable) assert.equal(engine.state.pages.has(id), false, `旧页 ${id} 已不可达`);
});

test('预演：根变化后基准失配，页面必须要求重新预演', async () => {
  const { engine } = await freshDb();
  const pv = await engine.previewBatch(editsA, 'pv-stale');
  const oldRoot = engine.state.rootId;
  await engine.submitBatch([{ op: 'insert', key: 99, value: '九九' }], 'moved-root');
  assert.notEqual(engine.state.rootId, oldRoot);
  assert.equal(engine.previewMatchesBasis(pv.basis), false);

  // 全新预演重新绑定新根
  const pv2 = await engine.previewBatch(editsA, 'pv-fresh');
  assert.equal(pv2.basis.gen, 2);
  assert.equal(engine.previewMatchesBasis(pv2.basis), true);
});

test('预演：重复插入给出与提交一致的中文拒因，且无任何写入', async () => {
  const { store, engine } = await freshDb();
  const before = await store.export();
  const pv = await engine.previewBatch([{ op: 'insert', key: 30, value: 'x' }], 'pv-ins-exists');
  assert.equal(pv.status, 'rejected');
  assert.equal(pv.code, 'INSERT_EXISTS');
  assert.match(pv.reason, /键 30 已存在/);
  assert.equal(pv.failedAt, 1);
  assert.deepEqual(await store.export(), before);

  const commit = await engine.submitBatch([{ op: 'insert', key: 30, value: 'x' }], 'pv-ins-exists');
  assert.equal(commit.code, pv.code);
  assert.equal(commit.reason, pv.reason);
});

test('预演：批次内先插后插同键在执行点被精确拒绝，并保留此前已成功步骤', async () => {
  const { engine } = await freshDb();
  const pv = await engine.previewBatch([
    { op: 'insert', key: 100, value: 'a' },
    { op: 'insert', key: 100, value: 'b' },
  ], 'pv-dup-in-batch');
  assert.equal(pv.status, 'rejected');
  assert.equal(pv.code, 'INSERT_EXISTS');
  assert.equal(pv.failedAt, 2);
  assert.equal(pv.steps.length, 1, '第 1 步成功结果仍展示（仅内存）');
  assert.deepEqual(pv.steps[0].after.keys.at(-1), 100);

  // 顺序脚本：先插入后更新同键，预演与提交都合法
  const ok = await engine.previewBatch([
    { op: 'insert', key: 101, value: 'a' },
    { op: 'update', key: 101, value: 'b' },
    { op: 'delete', key: 101 },
  ], 'pv-seq');
  assert.equal(ok.status, 'preview');
  assert.equal(ok.steps.length, 3);
  assert.equal(ok.candidate.audit.pass, true);
});

test('预演：删除 / 更新不存在键、数量与标识校验与提交同源', async () => {
  const { engine } = await freshDb();
  const cases = [
    { edits: [{ op: 'delete', key: 999 }], id: 'd', code: 'DELETE_MISSING', match: /键 999 不存在/ },
    { edits: [{ op: 'update', key: 999, value: 'x' }], id: 'u', code: 'UPDATE_MISSING', match: /键 999 不存在/ },
    { edits: [], id: 'empty', code: 'BAD_EDIT_COUNT', match: /不能为空/ },
    { edits: [{ op: 'insert', key: 1, value: 'v' }], id: '', code: 'BAD_BATCH_ID', match: /批次标识/ },
    { edits: [{ op: 'insert', key: 1.5, value: 'v' }], id: 'float', code: 'BAD_KEY', match: /整数/ },
  ];
  for (const c of cases) {
    const pv = await engine.previewBatch(c.edits, c.id);
    assert.equal(pv.status, 'rejected', c.id);
    assert.equal(pv.code, c.code);
    assert.match(pv.reason, c.match);
    // 任何被预演拒绝的脚本，原样提交也被同一代码拒绝（空标识原样传入）
    const commit = await engine.submitBatch(c.edits, c.id);
    assert.equal(commit.code, c.code);
  }
});

test('预演：相同批次标识不同内容 -> 冲突拒因；等价编辑 -> 回放提示', async () => {
  const { engine } = await freshDb();
  await engine.submitBatch([{ op: 'insert', key: 88, value: '八十八' }], 'same');
  const conflict = await engine.previewBatch([{ op: 'insert', key: 99, value: '九十九' }], 'same');
  assert.equal(conflict.status, 'rejected');
  assert.equal(conflict.code, 'CONFLICT_BATCH_CONTENT');
  assert.match(conflict.reason, /不同内容/);

  const replay = await engine.previewBatch([{ op: 'insert', key: 88, value: '八十八' }], 'same');
  assert.equal(replay.status, 'preview-replay');
  assert.equal(replay.receipt.replayed, true);
});

test('预演：删除导致借位与合并/根收缩事件均可观察，且与提交同根', async () => {
  const store = new MemoryStore();
  const engine = new Engine(store);
  await engine.open();
  await engine.initialize([[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);

  // [1,2][3,4]：各降到 1 键后清空一叶 -> 合并 + 根收缩
  const pv = await engine.previewBatch(
    [1, 4, 2].map((k) => ({ op: 'delete', key: k })), 'pv-merge');
  const events = pv.steps.map((s) => s.events);
  assert.ok(events[2].includes('leaf-merge'));
  assert.ok(events[2].includes('root-shrink'));
  assert.equal(pv.candidate.leafCount, 1);
  assert.equal(pv.candidate.internalCount, 0);
  const r = await engine.submitBatch(
    [1, 4, 2].map((k) => ({ op: 'delete', key: k })), 'pv-merge');
  assert.equal(r.rootId, pv.candidate.rootId);

  // 三叶草树清空一叶：相邻叶可借位
  const store2 = new MemoryStore();
  const e2 = new Engine(store2);
  await e2.open();
  await e2.initialize([[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd'], [5, 'e'], [6, 'f']]);
  const pv2 = await e2.previewBatch(
    [1, 2].map((k) => ({ op: 'delete', key: k })), 'pv-borrow');
  assert.ok(pv2.steps[1].events.includes('borrow'), '第二步触发兄弟借位');
  assert.equal(pv2.candidate.leafCount, 3, '借位不减少叶数');
});

test('预演：候选页统计“新增页”与“提交后不再可达页”与真实落盘一致', async () => {
  const { store, engine } = await freshDb();
  const pv = await engine.previewBatch(editsA, 'pv-counts');
  const oldStored = new Set((await store.allPageIds()).map((k) => k.slice(5)));

  await engine.submitBatch(editsA, 'pv-counts');
  const nowStored = new Set((await store.allPageIds()).map((k) => k.slice(5)));
  const created = [...nowStored].filter((id) => !oldStored.has(id));
  const dropped = [...oldStored].filter((id) => !nowStored.has(id));

  assert.deepEqual(created.sort(), [...pv.candidate.addedPageIds].sort());
  assert.deepEqual(dropped.sort(), [...pv.candidate.unreachablePageIds].sort());
});

test('预演：中断演练（after-intent）不改变预演的只读语义；重开后须重新预演', async () => {
  const { store, engine } = await freshDb();
  const pv = await engine.previewBatch(
    [{ op: 'insert', key: 77, value: '七十七' }], 'pv-crash');
  await engine.submitBatch(
    [{ op: 'insert', key: 77, value: '七十七' }], 'pv-crash', CRASH_POINTS.AFTER_INTENT);
  // 内存视图仍是旧根，预演基准此刻仍一致
  assert.equal(engine.previewMatchesBasis(pv.basis), true);

  // 重开复核发布新根
  const e2 = new Engine(store);
  await e2.open();
  assert.equal(e2.state.gen, 2);
  // 以新引擎视角看，旧预演绑定的代次 1 根已不是已发布根
  assert.equal(e2.previewMatchesBasis(pv.basis), false);
});

test('预演：已发布根不健康时与提交一致地拒绝', async () => {
  const { store, engine } = await freshDb();
  const root = engine.state.rootId;
  const page = await store.get('page:' + root);
  const tampered = page.type === 'leaf'
    ? { ...page, values: page.values.map(() => '损坏') }
    : { ...page, keys: page.keys.map((k) => k + 100000) };
  await store.put('page:' + root, tampered);
  const e2 = new Engine(store);
  await e2.open();
  const pv = await e2.previewBatch([{ op: 'insert', key: 1, value: 'x' }], 'pv-corrupt');
  assert.equal(pv.status, 'rejected');
  assert.equal(pv.code, 'CORRUPT_DIGEST');
});

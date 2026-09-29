// 冻结 / 版本校验 / 导出门禁 / 跨窗口版本冲突 的端到端验证。
// 不依赖 React：用 zustand vanilla 入口做替身，esbuild 即时打包真实 src/store.ts。
//   node scripts/verify-freeze-flow.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const rootPath = fileURLToPath(new URL('../', import.meta.url));
const work = join(tmpdir(), `yy59-freeze-verify-${process.pid}`);
mkdirSync(work, { recursive: true });
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

// zustand 主入口会引入 React；store 逻辑本身只用 vanilla createStore。
writeFileSync(join(work, 'zustand.mjs'),
  `export { createStore as create } from ${JSON.stringify(join(rootPath, 'node_modules/zustand/esm/vanilla.mjs'))};\n`);
writeFileSync(join(work, 'middleware.mjs'),
  `export { persist } from ${JSON.stringify(join(rootPath, 'node_modules/zustand/esm/middleware.mjs'))};\n`);

const zustandShimPlugin = {
  name: 'zustand-shim',
  setup(api) {
    api.onResolve({ filter: /^zustand$/ }, () => ({ path: join(work, 'zustand.mjs') }));
    api.onResolve({ filter: /^zustand\/middleware$/ }, () => ({ path: join(work, 'middleware.mjs') }));
  }
};
const result = await build({
  entryPoints: [join(rootPath, 'src/store.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  plugins: [zustandShimPlugin],
  logLevel: 'silent'
});
const bundlePath = join(work, 'store.bundle.mjs');
writeFileSync(bundlePath, result.outputFiles[0].text);
const bundleUrl = new URL(`file://${bundlePath}`).href;
const bundleCode = result.outputFiles[0].text;

let pass = 0;
let fail = 0;
const assert = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.error(`  ✗ ${label}`); }
};

// ---------- 场景一：单实例（同窗口内的冻结→失效→冲突） ----------
{
  const storage = new Map();
  const listeners = new Set();
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); for (const fn of listeners) fn({ key, newValue: String(value) }); },
    removeItem: (key) => storage.delete(key)
  };
  globalThis.window = { localStorage: globalThis.localStorage, addEventListener: (_t, fn) => listeners.add(fn) };

  const { useDisclosureStore, checkSnapshot, evaluateBatch } = await import(bundleUrl);
  const s = () => useDisclosureStore.getState();

  console.log('1) 冻结批次：快照保存密级/区域/复核项');
  const docId = 'DOC-00418';
  const before = s().documents.find((d) => d.id === docId);
  const batchId = s().freezeBatch({ documentIds: [docId], name: '测试批次', note: 'n', tags: ['t'] });
  assert(!!batchId, '冻结返回批次 id');
  const batch = s().batches.find((b) => b.id === batchId);
  assert(batch.snapshots.length === 1, '批次含 1 份快照');
  assert(batch.snapshots[0].revision === before.revision, `快照记录 revision=v${before.revision}`);
  assert(batch.snapshots[0].classification === '严格机密', '快照记录密级=严格机密');
  assert(batch.snapshots[0].redactions.length === 2, '只收已确认区域（2 个，草稿 R-02 不入快照）');
  assert(batch.snapshots[0].metadataCleaned === false, '快照记录复核项（元数据未清理）');

  console.log('2) 冻结后尚未校验：不能导出');
  assert(evaluateBatch(batch, s().documents).label === '待版本校验', '状态=待版本校验');
  assert(s().recordExport(batchId) === null, '导出被拦截');

  console.log('3) 版本校验通过：可导出');
  s().validateBatch(batchId);
  const checked = s().batches.find((b) => b.id === batchId);
  assert(checked.lastCheck?.passed === true, '版本校验通过');
  assert(evaluateBatch(checked, s().documents).exportable === true, '状态可导出');
  assert(typeof s().recordExport(batchId) === 'string', '导出成功并记录时间');

  console.log('4) 冻结后文档再保存：原批次失效、导出随即挡住');
  const outcomeB = s().commitClassification(docId, '机密', before.revision);
  assert(outcomeB.ok === true && outcomeB.revision === before.revision + 1, '先保存成功，revision +1');
  const status4 = evaluateBatch(s().batches.find((b) => b.id === batchId), s().documents);
  assert(status4.label.includes('已失效'), `旧批次标记失效（${status4.label}）`);
  assert(status4.exportable === false, '失效批次不可导出');
  assert(s().recordExport(batchId) === null, '导出入口挡住');

  console.log('5) 持旧基准后保存同一文档：版本冲突，不覆盖先保存内容');
  const outcomeA = s().commitClassification(docId, '内部', before.revision);
  assert(outcomeA.ok === false, '落后保存被拒绝');
  assert(!!outcomeA.conflict, '返回版本冲突信息');
  assert(outcomeA.conflict?.currentRevision === before.revision + 1, '冲突指向最新版本');
  const afterConflict = s().documents.find((d) => d.id === docId);
  assert(afterConflict.classification === '机密', '先保存的密级「机密」未被覆盖（不是「内部」）');
  assert(afterConflict.revision === before.revision + 1, 'revision 未被落后写入再递增');

  console.log('6) 确认区域同样走并发校验');
  assert(s().confirmRedaction(docId, 'R-02', before.revision).ok === false, '落后基准确认区域 → 冲突');
  assert(s().confirmRedaction(docId, 'R-02', before.revision + 1).ok === true, '最新基准确认区域 → 成功');

  console.log('7) 复核后建新批次：新批次可导出，旧批次仍可查');
  s().validateBatch(batchId);
  const oldBatch = s().batches.find((b) => b.id === batchId);
  assert(oldBatch.lastCheck?.passed === false, '旧批次重新校验失败（漂移）');
  assert(!!oldBatch.lastCheck?.reasons[docId], '失败原因记录到文档');
  const newId = s().freezeBatch({ documentIds: [docId], name: '复核后新批次', note: 'n', tags: ['t'] });
  s().validateBatch(newId);
  const newBatch = s().batches.find((b) => b.id === newId);
  assert(newBatch.snapshots[0].revision === before.revision + 2, `新批次基于 v${before.revision + 2}`);
  assert(evaluateBatch(newBatch, s().documents).exportable === true, '新批次可导出');
  assert(s().batches.length === 2, '旧批次仍在列表中可查');

  console.log('8) checkSnapshot 逐项识别漂移类型');
  const snap = newBatch.snapshots[0];
  const live = s().documents.find((d) => d.id === docId);
  assert(checkSnapshot(snap, live).reason === '', '一致时无漂移原因');
  const moved = { ...live, revision: live.revision + 1, classification: '内部' };
  const mm = checkSnapshot(snap, moved);
  assert(mm.revisionMismatch && mm.classificationMismatch, '能识别 revision 与密级漂移');
  assert(mm.reason.includes('密级'), '漂移原因含密级说明');
}

// ---------- 场景二：两个真实独立窗口（独立 Realm，共享存储） ----------
{
  // 浏览器语义：storage 事件只投递给“其他”窗口，不回送发送方。
  const shared = new Map();
  const realms = [];
  const broadcast = (sender, key, value) => { for (const r of realms) if (r !== sender) r.receive(key, value); };
  const makeRealm = () => {
    const listeners = new Set();
    const realm = { receive: null };
    const localStorage = {
      getItem: (key) => (shared.has(key) ? shared.get(key) : null),
      setItem: (key, value) => { shared.set(key, String(value)); broadcast(realm, key, String(value)); },
      removeItem: (key) => { shared.delete(key); broadcast(realm, key, null); }
    };
    realm.receive = (key, newValue) => { for (const fn of listeners) fn({ key, newValue }); };
    const sandbox = { console, localStorage, window: { localStorage, addEventListener: (_t, fn) => listeners.add(fn) }, JSON, Date, Map, Set, Object, Array, Promise, Blob, Uint8Array };
    createContext(sandbox);
    const stripped = bundleCode.replace(/export \{[\s\S]*?\};\s*$/, '');
    runInContext(`${stripped}\nglobalThis.__store = { useDisclosureStore, checkSnapshot, evaluateBatch };`, sandbox, { filename: 'store.mjs' });
    realms.push(realm);
    return sandbox.__store;
  };

  console.log('9) 两个窗口并发：实时同步 + 后保存冲突 + 失效联动');
  const w1 = makeRealm();
  const w2 = makeRealm();
  const A = () => w1.useDisclosureStore.getState();
  const B = () => w2.useDisclosureStore.getState();
  const docId = 'DOC-00427';
  const base = A().documents.find((d) => d.id === docId).revision;

  const bid = A().freezeBatch({ documentIds: [docId], name: '跨窗批次', note: '', tags: [] });
  assert(B().batches.some((x) => x.id === bid), '窗口 2 通过 storage 事件实时收到新批次');

  assert(A().commitClassification(docId, '内部', base).ok, '窗口1 先保存成功');
  assert(B().documents.find((d) => d.id === docId).classification === '内部', '窗口2 实时看到先保存的密级');
  assert(B().documents.find((d) => d.id === docId).revision === base + 1, '窗口2 实时看到 revision 推进');

  const conflict = B().commitClassification(docId, '严格机密', base);
  assert(!conflict.ok && !!conflict.conflict, '窗口2 后保存收到版本冲突');
  assert(A().documents.find((d) => d.id === docId).classification === '内部', '窗口1 先保存内容未被覆盖');

  B().rebaseConflict();
  assert(B().commitClassification(docId, '严格机密', base + 1).ok, '窗口2 加载最新版本后保存成功');
  assert(A().documents.find((d) => d.id === docId).classification === '严格机密', '窗口1 同步到窗口2 的新保存');

  assert(!w1.evaluateBatch(A().batches.find((x) => x.id === bid), A().documents).exportable, '窗口1 原批次失效不可导出');
  assert(!w2.evaluateBatch(B().batches.find((x) => x.id === bid), B().documents).exportable, '窗口2 原批次失效不可导出');
  assert(A().recordExport(bid) === null && B().recordExport(bid) === null, '两个窗口导出入口都被挡住');

  const newId = B().freezeBatch({ documentIds: [docId], name: '复核后', note: '', tags: [] });
  B().validateBatch(newId);
  assert(A().batches.some((x) => x.id === newId), '窗口1 实时看到新批次');
  assert(w2.evaluateBatch(B().batches.find((x) => x.id === newId), B().documents).exportable, '新批次可导出');
  assert(A().batches.length === 2 && B().batches.length === 2, '两个窗口都仍保留旧批次可查');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);

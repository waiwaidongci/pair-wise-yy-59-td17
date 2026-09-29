import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Redaction = {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  reason: string;
  privilege: string;
  status: 'draft' | 'confirmed';
};

export type Classification = '内部' | '机密' | '严格机密';

export type DisclosureRecord = {
  id: string;
  title: string;
  bundle: string;
  pages: number;
  classification: Classification;
  owner: string;
  updatedAt: string;
  status: '去密中' | '待质检' | '可发布';
  issue: string;
  size: string;
  redactions: Redaction[];
  /** 每次保存递增；冻结批次按 revision 校验当前草稿是否已漂移 */
  revision: number;
};

/** 冻结时的文档快照：密级、去密区域（仅已确认）与复核项一并定格 */
export type DocumentSnapshot = {
  documentId: string;
  title: string;
  revision: number;
  classification: Classification;
  pages: number;
  redactions: Redaction[];
  reviewChecks: Record<string, boolean>;
  metadataCleaned: boolean;
  frozenAt: string;
};

export type BatchCheckResult = {
  checkedAt: string;
  passed: boolean;
  reasons: Record<string, string>;
};

export type ReleaseBatch = {
  id: string;
  name: string;
  note: string;
  tags: string[];
  frozenAt: string;
  snapshots: DocumentSnapshot[];
  lastCheck: BatchCheckResult | null;
  exportedAt: string | null;
};

export type VersionConflict = {
  documentId: string;
  title: string;
  expectedRevision: number;
  currentRevision: number;
  changeLabel: string;
};

export type SaveOutcome = { ok: boolean; revision?: number; conflict?: VersionConflict };

const defaultDocuments: DisclosureRecord[] = [
  {
    id: 'DOC-00418',
    title: '设备采购补充协议（第三版）',
    bundle: '北岭项目 · 第一批披露',
    pages: 3,
    classification: '严格机密',
    owner: '林清',
    updatedAt: '09:48:00',
    status: '去密中',
    issue: '合同主体与商业条款',
    size: '8.4 MB',
    revision: 1,
    redactions: [
      { id: 'R-01', page: 1, x: 0.12, y: 0.16, width: 0.30, height: 0.04, reason: '商业秘密', privilege: '合同保密', status: 'confirmed' },
      { id: 'R-02', page: 1, x: 0.50, y: 0.43, width: 0.34, height: 0.06, reason: '个人手机号', privilege: '个人信息', status: 'draft' },
      { id: 'R-03', page: 2, x: 0.11, y: 0.25, width: 0.68, height: 0.05, reason: '第三方报价', privilege: '商业敏感', status: 'confirmed' }
    ]
  },
  {
    id: 'DOC-00427',
    title: '现场会议纪要 2026-08-19',
    bundle: '北岭项目 · 第一批披露',
    pages: 3,
    classification: '机密',
    owner: '周叙',
    updatedAt: '09:31:00',
    status: '待质检',
    issue: '事故预防与整改安排',
    size: '3.1 MB',
    revision: 1,
    redactions: [
      { id: 'R-04', page: 1, x: 0.08, y: 0.69, width: 0.74, height: 0.05, reason: '内部调查意见', privilege: '工作成果', status: 'confirmed' }
    ]
  },
  {
    id: 'DOC-00435',
    title: '设备运行数据摘录',
    bundle: '北岭项目 · 第二批披露',
    pages: 3,
    classification: '内部',
    owner: '顾言',
    updatedAt: '08:56:00',
    status: '可发布',
    issue: '运行记录',
    size: '12.7 MB',
    revision: 1,
    redactions: [
      { id: 'R-05', page: 2, x: 0.44, y: 0.56, width: 0.26, height: 0.04, reason: '人员姓名', privilege: '个人信息', status: 'confirmed' }
    ]
  }
];

export const REVIEW_CHECK_ITEMS = [
  { id: 'forbidden-terms', label: '全文禁词与姓名复核' },
  { id: 'page-number', label: '页序与页码连续性' },
  { id: 'image-boundary', label: '图像边界残片' },
  { id: 'metadata', label: '文档元数据清理' }
];

export const DEFAULT_TAGS = ['合同问题', '设备缺陷', '现场安全'];

export const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

const redactionKey = (item: Redaction) => `${item.page}:${item.x.toFixed(3)},${item.y.toFixed(3)},${item.width.toFixed(3)},${item.height.toFixed(3)},${item.reason},${item.privilege}`;

export type SnapshotMismatch = {
  revisionMismatch: boolean;
  classificationMismatch: boolean;
  redactionsMismatch: boolean;
  reason: string;
};

/** 快照与当前草稿逐项比对：revision、密级、已确认去密区域 */
export function checkSnapshot(snapshot: DocumentSnapshot, doc: DisclosureRecord | undefined): SnapshotMismatch {
  if (!doc) return { revisionMismatch: true, classificationMismatch: false, redactionsMismatch: false, reason: '当前草稿中已找不到该文档' };
  const revisionMismatch = doc.revision !== snapshot.revision;
  const classificationMismatch = doc.classification !== snapshot.classification;
  const frozen = snapshot.redactions.map(redactionKey).sort();
  const live = doc.redactions.filter((item) => item.status === 'confirmed').map(redactionKey).sort();
  const redactionsMismatch = frozen.length !== live.length || frozen.some((key, index) => key !== live[index]);
  const reasons: string[] = [];
  if (revisionMismatch) reasons.push(`文档已由 v${snapshot.revision} 保存至 v${doc.revision}`);
  if (classificationMismatch) reasons.push(`密级由「${snapshot.classification}」改为「${doc.classification}」`);
  if (redactionsMismatch) reasons.push('去密区域（已确认）发生变化');
  return {
    revisionMismatch,
    classificationMismatch,
    redactionsMismatch,
    reason: reasons.length ? reasons.join('；') : ''
  };
}

export type BatchStatus = {
  label: string;
  tone: 'green' | 'amber' | 'red' | 'neutral';
  checked: boolean;
  inSync: boolean;
  exportable: boolean;
};

/** 批次状态由快照与当前草稿实时推导，旧批次即使失效也保留可查 */
export function evaluateBatch(batch: ReleaseBatch, documents: DisclosureRecord[]): BatchStatus {
  const mismatches = batch.snapshots.map((snapshot) => checkSnapshot(snapshot, documents.find((doc) => doc.id === snapshot.documentId)));
  const inSync = mismatches.every((item) => !item.revisionMismatch && !item.classificationMismatch && !item.redactionsMismatch);
  const checked = !!batch.lastCheck?.passed;
  const exportable = checked && inSync;
  if (!batch.lastCheck) return { label: '待版本校验', tone: 'neutral', checked: false, inSync, exportable: false };
  if (!batch.lastCheck.passed) return { label: '校验未通过', tone: 'red', checked: false, inSync, exportable: false };
  if (!inSync) return { label: '已失效（文档有改动）', tone: 'red', checked: true, inSync: false, exportable: false };
  return batch.exportedAt
    ? { label: '已导出发布包', tone: 'green', checked: true, inSync: true, exportable: true }
    : { label: '可导出', tone: 'amber', checked: true, inSync: true, exportable: true };
}

const STORAGE_KEY = 'yy59-disclosure-draft';

function readPersisted(): { documents: DisclosureRecord[]; batches: ReleaseBatch[] } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const state = parsed?.state ?? parsed;
    if (!state || !Array.isArray(state.documents)) return null;
    return {
      // 兼容早期草稿（无 revision 字段，按 v1 处理）
      documents: (state.documents as DisclosureRecord[]).map((doc) =>
        typeof doc.revision === 'number' ? doc : { ...doc, revision: 1 }
      ),
      batches: Array.isArray(state.batches) ? state.batches as ReleaseBatch[] : []
    };
  } catch {
    return null;
  }
}

type State = {
  documents: DisclosureRecord[];
  batches: ReleaseBatch[];
  reviewChecks: Record<string, boolean>;
  metadataCleaned: boolean;
  /** 仅本窗口 UI 状态：当前查看批次（不持久化，避免串窗口） */
  activeBatchId: string | null;
  /** 后保存方命中的版本冲突，弹窗展示；不会覆盖先保存内容 */
  conflict: VersionConflict | null;
  /** 冲突处理后的 rebase 信号，供审阅/质检页刷新本地基准版本 */
  rebaseSignal: { documentId: string; revision: number; at: string } | null;
  setActiveBatch: (id: string | null) => void;
  selectDocument: (id: string) => void;
  setPage: (page: number) => void;
  toggleRedactionMode: () => void;
  activeDocumentId: string;
  activePage: number;
  activeRedactionId: string | null;
  redactionMode: boolean;
  addRedaction: (documentId: string, redaction: Omit<Redaction, 'id' | 'status'>) => SaveOutcome;
  confirmRedaction: (documentId: string, id: string, expectedRevision: number) => SaveOutcome;
  selectRedaction: (id: string | null) => void;
  commitClassification: (documentId: string, classification: Classification, expectedRevision: number) => SaveOutcome;
  markReady: (documentId: string, expectedRevision: number) => SaveOutcome;
  toggleReviewCheck: (id: string) => void;
  toggleMetadata: () => void;
  freezeBatch: (input: { documentIds: string[]; name: string; note: string; tags: string[] }) => string | null;
  validateBatch: (batchId: string) => void;
  recordExport: (batchId: string) => string | null;
  dismissConflict: () => void;
  rebaseConflict: () => void;
};

export const useDisclosureStore = create<State>()(
  persist(
    (set, get) => {
      /**
       * 所有文档改动都走乐观并发：保存前从持久层读取另一窗口可能已写入的最新 revision，
       * 若已被先保存则返回冲突，本次改动整体不落地。
       */
      const commitChange = (
        documentId: string,
        expectedRevision: number,
        changeLabel: string,
        mutate: (doc: DisclosureRecord) => DisclosureRecord
      ): SaveOutcome => {
        const persisted = readPersisted();
        const remoteDocs = persisted?.documents ?? get().documents;
        const current = remoteDocs.find((doc) => doc.id === documentId);
        if (!current) return { ok: false };
        if (current.revision !== expectedRevision) {
          const conflict: VersionConflict = {
            documentId,
            title: current.title,
            expectedRevision,
            currentRevision: current.revision,
            changeLabel
          };
          set({ documents: remoteDocs, batches: persisted?.batches ?? get().batches, conflict });
          return { ok: false, conflict };
        }
        const timestamp = stamp();
        const nextDocuments = remoteDocs.map((doc) => doc.id === documentId
          ? { ...mutate(doc), revision: doc.revision + 1, updatedAt: timestamp }
          : doc);
        set({ documents: nextDocuments, batches: persisted?.batches ?? get().batches });
        return { ok: true, revision: current.revision + 1 };
      };

      return {
        documents: defaultDocuments,
        batches: [],
        activeDocumentId: defaultDocuments[0].id,
        activePage: 1,
        activeRedactionId: 'R-02',
        redactionMode: false,
        reviewChecks: {
          'forbidden-terms': true,
          'page-number': true,
          'image-boundary': false,
          'metadata': false
        },
        metadataCleaned: false,
        activeBatchId: null,
        conflict: null,
        rebaseSignal: null,
        setActiveBatch: (id) => set({ activeBatchId: id }),
        selectDocument: (id) => set({ activeDocumentId: id, activePage: 1, activeRedactionId: null, redactionMode: false }),
        setPage: (page) => set({ activePage: page }),
        toggleRedactionMode: () => set((state) => ({ redactionMode: !state.redactionMode })),
        selectRedaction: (id) => set({ activeRedactionId: id }),
        toggleReviewCheck: (id) => set((state) => ({ reviewChecks: { ...state.reviewChecks, [id]: !state.reviewChecks[id] } })),
        toggleMetadata: () => set((state) => ({ metadataCleaned: !state.metadataCleaned })),
        addRedaction: (documentId, redaction) => {
          const doc = (readPersisted()?.documents ?? get().documents).find((item) => item.id === documentId);
          if (!doc) return { ok: false };
          return commitChange(
            documentId,
            doc.revision,
            '新增了去密区域',
            (target) => ({ ...target, redactions: [...target.redactions, { ...redaction, id: `R-${Date.now()}`, status: 'draft' as const }] })
          );
        },
        confirmRedaction: (documentId, id, expectedRevision) =>
          commitChange(
            documentId,
            expectedRevision,
            '确认了去密区域',
            (target) => ({
              ...target,
              redactions: target.redactions.map((item) => item.id === id ? { ...item, status: 'confirmed' as const } : item)
            })
          ),
        commitClassification: (documentId, classification, expectedRevision) =>
          commitChange(documentId, expectedRevision, '修改了密级', (target) => ({ ...target, classification })),
        markReady: (documentId, expectedRevision) =>
          commitChange(documentId, expectedRevision, '更新了质检复核结论', (target) => ({ ...target, status: '可发布' as const })),
        freezeBatch: ({ documentIds, name, note, tags }) => {
          const persisted = readPersisted();
          const documents = persisted?.documents ?? get().documents;
          const picked = documents.filter((doc) => documentIds.includes(doc.id));
          if (!picked.length) return null;
          const { reviewChecks, metadataCleaned } = get();
          const frozenAt = stamp();
          const batch: ReleaseBatch = {
            id: `BATCH-${String(Date.now()).slice(-6)}`,
            name,
            note,
            tags,
            frozenAt,
            snapshots: picked.map((doc) => ({
              documentId: doc.id,
              title: doc.title,
              revision: doc.revision,
              classification: doc.classification,
              pages: doc.pages,
              redactions: doc.redactions.filter((item) => item.status === 'confirmed').map((item) => ({ ...item })),
              reviewChecks: { ...reviewChecks },
              metadataCleaned,
              frozenAt
            })),
            lastCheck: null,
            exportedAt: null
          };
          set({ batches: [batch, ...(persisted?.batches ?? get().batches)], activeBatchId: batch.id });
          return batch.id;
        },
        validateBatch: (batchId) => {
          const persisted = readPersisted();
          const documents = persisted?.documents ?? get().documents;
          const batches = persisted?.batches ?? get().batches;
          const batch = batches.find((item) => item.id === batchId);
          if (!batch) return;
          const reasons: Record<string, string> = {};
          const passed = batch.snapshots.every((snapshot) => {
            const mismatch = checkSnapshot(snapshot, documents.find((doc) => doc.id === snapshot.documentId));
            const ok = !mismatch.revisionMismatch && !mismatch.classificationMismatch && !mismatch.redactionsMismatch;
            if (!ok) reasons[snapshot.documentId] = mismatch.reason;
            return ok;
          });
          set({
            batches: batches.map((item) => item.id === batchId
              ? { ...item, lastCheck: { checkedAt: stamp(), passed, reasons } }
              : item)
          });
        },
        recordExport: (batchId) => {
          const persisted = readPersisted();
          const documents = persisted?.documents ?? get().documents;
          const batches = persisted?.batches ?? get().batches;
          const batch = batches.find((item) => item.id === batchId);
          if (!batch) return null;
          // 导出入口最后一道闸：必须校验通过且快照仍与当前草稿一致
          if (!evaluateBatch(batch, documents).exportable) return null;
          const exportedAt = stamp();
          set({ batches: batches.map((item) => item.id === batchId ? { ...item, exportedAt } : item) });
          return exportedAt;
        },
        dismissConflict: () => set({ conflict: null }),
        rebaseConflict: () => {
          const { conflict } = get();
          if (!conflict) return;
          const persisted = readPersisted();
          set({
            documents: persisted?.documents ?? get().documents,
            batches: persisted?.batches ?? get().batches,
            conflict: null,
            rebaseSignal: { documentId: conflict.documentId, revision: conflict.currentRevision, at: stamp() }
          });
        }
      };
    },
    {
      name: STORAGE_KEY,
      // 仅持久化业务数据；本窗口的会话状态不写入、不串窗口
      partialize: (state) => ({
        documents: state.documents,
        batches: state.batches,
        reviewChecks: state.reviewChecks,
        metadataCleaned: state.metadataCleaned
      }) as unknown as State,
      // 兼容早期草稿（无 revision / batches 字段）
      merge: (persisted, current) => {
        const incoming = (persisted ?? {}) as Partial<State>;
        return {
          ...current,
          ...incoming,
          documents: (incoming.documents ?? current.documents).map((doc) =>
            typeof doc.revision === 'number' ? doc : { ...doc, revision: 1 }
          ),
          batches: Array.isArray(incoming.batches) ? incoming.batches : [],
          conflict: null,
          rebaseSignal: null,
          activeBatchId: current.activeBatchId
        } as State;
      }
    }
  )
);

/**
 * 另一窗口保存后，浏览器 storage 事件把最新业务数据推送到本窗口；
 * 会话/冲突状态保留在本窗口，保存动作再以最新 revision 做并发判断。
 * 仅在内容确实变化时写入，避免 storage→setState→persist 写回→storage 的跨窗口乒乓。
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const parsed = JSON.parse(event.newValue);
      const state = parsed?.state ?? parsed;
      if (!state || !Array.isArray(state.documents)) return;
      const incomingDocs = state.documents as DisclosureRecord[];
      const incomingBatches = Array.isArray(state.batches) ? state.batches as ReleaseBatch[] : useDisclosureStore.getState().batches;
      const current = useDisclosureStore.getState();
      const signature = (docs: DisclosureRecord[], batches: ReleaseBatch[]) =>
        JSON.stringify({ d: docs.map((doc) => [doc.id, doc.revision, doc.classification, doc.redactions, doc.status]), b: batches.map((batch) => [batch.id, batch.lastCheck, batch.exportedAt, batch.snapshots]) });
      if (signature(incomingDocs, incomingBatches) === signature(current.documents, current.batches)) return;
      useDisclosureStore.setState({ documents: incomingDocs, batches: incomingBatches });
    } catch {
      // 忽略无法解析的存储内容
    }
  });
}

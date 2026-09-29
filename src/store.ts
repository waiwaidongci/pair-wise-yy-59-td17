import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  createBatchSnapshot,
  nowLabel,
  verifyBatch as verifyBatchPure,
  type ChangedDocument,
  type ReleaseBatch,
  type VerificationResult
} from './batch';

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

export type DisclosureRecord = {
  id: string;
  title: string;
  bundle: string;
  pages: number;
  classification: '内部' | '机密' | '严格机密';
  owner: string;
  updatedAt: string;
  status: '去密中' | '待质检' | '可发布';
  issue: string;
  size: string;
  /** 乐观并发版本号：每次密级或去密区域改动自增，用于窗口间版本冲突校验。 */
  version: number;
  redactions: Redaction[];
};

const defaultDocuments: DisclosureRecord[] = [
  {
    id: 'DOC-00418',
    title: '设备采购补充协议（第三版）',
    bundle: '北岭项目 · 第一批披露',
    pages: 3,
    classification: '严格机密',
    owner: '林清',
    updatedAt: '09:48',
    status: '去密中',
    issue: '合同主体与商业条款',
    size: '8.4 MB',
    version: 1,
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
    updatedAt: '09:31',
    status: '待质检',
    issue: '事故预防与整改安排',
    size: '3.1 MB',
    version: 1,
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
    updatedAt: '08:56',
    status: '可发布',
    issue: '运行记录',
    size: '12.7 MB',
    version: 1,
    redactions: [
      { id: 'R-05', page: 2, x: 0.44, y: 0.56, width: 0.26, height: 0.04, reason: '人员姓名', privilege: '个人信息', status: 'confirmed' }
    ]
  }
];

/** 保存结果：成功返回新版本号；冲突时返回当前版本，调用方不得覆盖。 */
export type SaveResult =
  | { ok: true; version: number }
  | { ok: false; conflict: true; currentVersion: number };

/** 导出结果：成功返回已发布批次；失效时返回被改动的文档列表。 */
export type ExportResult =
  | { ok: true; batch: ReleaseBatch }
  | { ok: false; changed: ChangedDocument[] };

type State = {
  documents: DisclosureRecord[];
  activeDocumentId: string;
  activePage: number;
  activeRedactionId: string | null;
  redactionMode: boolean;
  reviewChecks: Record<string, boolean>;
  metadataCleaned: boolean;
  /** 已冻结批次（含失效批次，旧批次仍可查）。 */
  batches: ReleaseBatch[];
  selectDocument: (id: string) => void;
  selectRedaction: (id: string) => void;
  setPage: (page: number) => void;
  toggleRedactionMode: () => void;
  addRedaction: (redaction: Omit<Redaction, 'id' | 'status'>, expectedVersion: number) => SaveResult;
  confirmRedaction: (id: string, expectedVersion: number) => SaveResult;
  updateClassification: (classification: DisclosureRecord['classification'], expectedVersion: number) => SaveResult;
  toggleReviewCheck: (id: string) => void;
  toggleMetadata: () => void;
  markReady: () => void;
  createBatch: (name: string, documentIds: string[]) => ReleaseBatch;
  verifyBatch: (batchId: string) => VerificationResult;
  exportBatch: (batchId: string) => ExportResult;
};

export const useDisclosureStore = create<State>()(
  persist(
    (set, get) => ({
      documents: defaultDocuments,
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
      batches: [],
      selectDocument: (id) => set({ activeDocumentId: id, activePage: 1, activeRedactionId: null, redactionMode: false }),
      selectRedaction: (id) => set({ activeRedactionId: id }),
      setPage: (page) => set({ activePage: page }),
      toggleRedactionMode: () => set((state) => ({ redactionMode: !state.redactionMode })),

      addRedaction: (redaction, expectedVersion) => {
        const state = get();
        const doc = state.documents.find((d) => d.id === state.activeDocumentId);
        if (!doc || doc.version !== expectedVersion) {
          return { ok: false, conflict: true, currentVersion: doc?.version ?? expectedVersion };
        }
        const newVersion = doc.version + 1;
        set((s) => ({
          documents: s.documents.map((d) => d.id === s.activeDocumentId
            ? { ...d, version: newVersion, updatedAt: nowLabel().slice(11), redactions: [...d.redactions, { ...redaction, id: `R-${Date.now()}`, status: 'draft' as const }] }
            : d)
        }));
        return { ok: true, version: newVersion };
      },

      confirmRedaction: (id, expectedVersion) => {
        const state = get();
        const doc = state.documents.find((d) => d.id === state.activeDocumentId);
        if (!doc || doc.version !== expectedVersion) {
          return { ok: false, conflict: true, currentVersion: doc?.version ?? expectedVersion };
        }
        const newVersion = doc.version + 1;
        set((s) => ({
          documents: s.documents.map((d) => d.id === s.activeDocumentId
            ? { ...d, version: newVersion, redactions: d.redactions.map((item) => item.id === id ? { ...item, status: 'confirmed' as const } : item) }
            : d)
        }));
        return { ok: true, version: newVersion };
      },

      updateClassification: (classification, expectedVersion) => {
        const state = get();
        const doc = state.documents.find((d) => d.id === state.activeDocumentId);
        if (!doc || doc.version !== expectedVersion) {
          return { ok: false, conflict: true, currentVersion: doc?.version ?? expectedVersion };
        }
        const newVersion = doc.version + 1;
        set((s) => ({
          documents: s.documents.map((d) => d.id === s.activeDocumentId ? { ...d, version: newVersion, classification } : d)
        }));
        return { ok: true, version: newVersion };
      },

      toggleReviewCheck: (id) => set((state) => ({ reviewChecks: { ...state.reviewChecks, [id]: !state.reviewChecks[id] } })),
      toggleMetadata: () => set((state) => ({ metadataCleaned: !state.metadataCleaned })),
      markReady: () => set((state) => ({
        documents: state.documents.map((doc) => doc.id === state.activeDocumentId ? { ...doc, status: '可发布' } : doc)
      })),

      createBatch: (name, documentIds) => {
        const state = get();
        const docs = state.documents.filter((d) => documentIds.includes(d.id));
        const batch = createBatchSnapshot(
          docs,
          { checks: { ...state.reviewChecks }, metadataCleaned: state.metadataCleaned },
          name
        );
        set((s) => ({ batches: [batch, ...s.batches] }));
        return batch;
      },

      verifyBatch: (batchId) => {
        const state = get();
        const batch = state.batches.find((b) => b.id === batchId);
        if (!batch) return { valid: false, changed: [] };
        return verifyBatchPure(batch, state.documents);
      },

      exportBatch: (batchId) => {
        const state = get();
        const batch = state.batches.find((b) => b.id === batchId);
        if (!batch) return { ok: false, changed: [] };
        const verification = verifyBatchPure(batch, state.documents);
        if (!verification.valid) return { ok: false, changed: verification.changed };
        const releasedAt = nowLabel();
        const released: ReleaseBatch = { ...batch, status: 'released', releasedAt };
        set((s) => ({ batches: s.batches.map((b) => b.id === batchId ? released : b) }));
        return { ok: true, batch: released };
      }
    }),
    {
      name: 'yy59-disclosure-draft',
      merge: (persistedState, currentState) => {
        const p = (persistedState ?? {}) as Partial<State>;
        const rawDocs = Array.isArray(p.documents) ? p.documents : currentState.documents;
        const documents = rawDocs.map((d) => ({
          ...d,
          version: typeof d.version === 'number' && d.version >= 1 ? d.version : 1
        }));
        const batches = Array.isArray(p.batches) ? p.batches : [];
        return { ...currentState, ...p, documents, batches };
      }
    }
  )
);

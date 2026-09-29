import type { DisclosureRecord, Redaction } from './store';

/**
 * 批次快照、版本校验与发布包导出。
 *
 * 三者刻意分开：
 * - 快照（createBatchSnapshot）只负责冻结所选文档的密级、确认区域与复核项；
 * - 版本校验（verifyBatch）只比对冻结版本与当前草稿版本，判断批次是否失效；
 * - 导出（buildReleasePackage）只把冻结内容打包成可下载的发布包。
 * 审阅与质检流程不经过这里，照常进行。
 */

export type DocumentSnapshot = {
  documentId: string;
  title: string;
  bundle: string;
  pages: number;
  owner: string;
  classification: DisclosureRecord['classification'];
  redactions: Redaction[];
  confirmedCount: number;
  draftCount: number;
  version: number;
  frozenAt: string;
};

export type ReviewItemSnapshot = {
  checks: Record<string, boolean>;
  metadataCleaned: boolean;
};

export type ReleaseBatch = {
  id: string;
  name: string;
  createdAt: string;
  documentIds: string[];
  snapshots: DocumentSnapshot[];
  reviewItems: ReviewItemSnapshot;
  status: 'frozen' | 'released';
  releasedAt: string | null;
};

export type ChangedDocument = {
  documentId: string;
  title: string;
  fromVersion: number;
  toVersion: number;
};

export type VerificationResult =
  | { valid: true }
  | { valid: false; changed: ChangedDocument[] };

export function nowLabel(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

/** 冻结所选文档：保存密级、确认区域与复核项，生成不可变快照。 */
export function createBatchSnapshot(
  docs: DisclosureRecord[],
  reviewItems: ReviewItemSnapshot,
  name: string
): ReleaseBatch {
  const createdAt = nowLabel();
  const snapshots: DocumentSnapshot[] = docs.map((doc) => {
    const confirmedCount = doc.redactions.filter((r) => r.status === 'confirmed').length;
    const draftCount = doc.redactions.length - confirmedCount;
    return {
      documentId: doc.id,
      title: doc.title,
      bundle: doc.bundle,
      pages: doc.pages,
      owner: doc.owner,
      classification: doc.classification,
      redactions: doc.redactions.map((r) => ({ ...r })),
      confirmedCount,
      draftCount,
      version: doc.version,
      frozenAt: createdAt
    };
  });
  return {
    id: `BATCH-${Date.now()}`,
    name,
    createdAt,
    documentIds: docs.map((d) => d.id),
    snapshots,
    reviewItems: {
      checks: { ...reviewItems.checks },
      metadataCleaned: reviewItems.metadataCleaned
    },
    status: 'frozen',
    releasedAt: null
  };
}

/** 版本校验：冻结后任一文档被改动（版本号增长）即判定批次失效。 */
export function verifyBatch(batch: ReleaseBatch, docs: DisclosureRecord[]): VerificationResult {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const changed: ChangedDocument[] = [];
  for (const snap of batch.snapshots) {
    const current = byId.get(snap.documentId);
    if (!current) {
      changed.push({ documentId: snap.documentId, title: snap.title, fromVersion: snap.version, toVersion: -1 });
      continue;
    }
    if (current.version !== snap.version) {
      changed.push({
        documentId: current.id,
        title: current.title,
        fromVersion: snap.version,
        toVersion: current.version
      });
    }
  }
  return changed.length ? { valid: false, changed } : { valid: true };
}

/** 导出：把冻结快照与复核项打包成发布包（JSON 字符串）。 */
export function buildReleasePackage(batch: ReleaseBatch): string {
  const pkg = {
    package: 'RELEASE-PACKAGE',
    batchId: batch.id,
    name: batch.name,
    createdAt: batch.createdAt,
    releasedAt: batch.releasedAt,
    documents: batch.snapshots.map((s) => ({
      documentId: s.documentId,
      title: s.title,
      bundle: s.bundle,
      pages: s.pages,
      owner: s.owner,
      classification: s.classification,
      frozenVersion: s.version,
      frozenAt: s.frozenAt,
      confirmedRegions: s.confirmedCount,
      draftRegions: s.draftCount,
      redactions: s.redactions.map((r) => ({
        id: r.id,
        page: r.page,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        reason: r.reason,
        privilege: r.privilege,
        status: r.status
      }))
    })),
    reviewItems: {
      checks: batch.reviewItems.checks,
      metadataCleaned: batch.reviewItems.metadataCleaned
    }
  };
  return JSON.stringify(pkg, null, 2);
}

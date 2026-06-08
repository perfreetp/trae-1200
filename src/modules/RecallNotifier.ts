import { RecallNotice, RecallLevel, RecallStatus, DataSourceType } from '../types';

export interface RecallQueryResult {
  notices: RecallNotice[];
  hasActiveRecall: boolean;
  highestLevel?: RecallLevel;
  matchedBy: {
    approvalNumber?: boolean;
    batchNumber?: boolean;
    explicitMapping?: boolean;
  };
  errorMessage?: string;
}

const DEFAULT_RECALL_NOTICES: RecallNotice[] = [
  {
    recallId: 'REC-2024-001',
    recallLevel: RecallLevel.LEVEL_2,
    recallStatus: RecallStatus.ACTIVE,
    recallTitle: '关于某批次降压药的二级召回公告',
    recallReason: '经检验发现该批次药品含量测定项不符合标准规定，存在安全隐患。',
    recallScope: '全国范围内2023年10月至2024年1月期间销售的指定批次产品',
    initiator: '国家药品监督管理局',
    publishDate: '2024-03-15T10:00:00.000Z',
    deadlineDate: '2024-06-15T23:59:59.999Z',
    affectedBatches: ['B20230901', 'B20231001', 'B20231101'],
    measures: [
      '立即停止销售和使用该批次药品',
      '通知下游客户进行产品召回',
      '对已售出产品进行登记回收',
      '向药监部门报告召回进展情况'
    ],
    contactInfo: {
      name: '召回工作小组',
      phone: '400-123-4567',
      email: 'recall@example.com'
    },
    relatedDocuments: [
      {
        title: '检验报告编号：INS-2024-003',
        url: 'https://example.com/reports/ins-2024-003.pdf'
      }
    ]
  }
];

interface RecallMapping {
  approvalNumbers: string[];
  codes: string[];
  recallIds: string[];
}

export class RecallNotifierModule {
  private notices: RecallNotice[];
  private codeBatchMap: Map<string, string[]> = new Map();
  private approvalToRecallMap: Map<string, string[]> = new Map();
  private batchToRecallMap: Map<string, string[]> = new Map();
  private explicitMappings: RecallMapping[] = [];
  private strictMatch: boolean;

  constructor(
    initialNotices?: RecallNotice[],
    strictMatch: boolean = true
  ) {
    this.notices = [...DEFAULT_RECALL_NOTICES, ...(initialNotices || [])];
    this.strictMatch = strictMatch;
    this.buildDefaultIndexes();
  }

  queryRecalls(
    codeOrApproval?: string,
    batchNumber?: string,
    options?: {
      includeInactive?: boolean;
      approvalNumber?: string;
      useStrictMatch?: boolean;
    }
  ): RecallQueryResult {
    try {
      const includeInactive = options?.includeInactive ?? false;
      const strictMode = options?.useStrictMatch ?? this.strictMatch;
      const approvalNumber = options?.approvalNumber || codeOrApproval;

      const matchedBy: RecallQueryResult['matchedBy'] = {
        approvalNumber: false,
        batchNumber: false,
        explicitMapping: false
      };

      let matchedIds = new Set<string>();

      if (batchNumber) {
        const byBatch = this.batchToRecallMap.get(batchNumber.trim());
        if (byBatch && byBatch.length > 0) {
          byBatch.forEach(id => matchedIds.add(id));
          matchedBy.batchNumber = true;
        }
      }

      if (approvalNumber) {
        const byApproval = this.approvalToRecallMap.get(approvalNumber.trim());
        if (byApproval && byApproval.length > 0) {
          byApproval.forEach(id => matchedIds.add(id));
          matchedBy.approvalNumber = true;
        }
      }

      if (codeOrApproval) {
        const byCodeBatches = this.codeBatchMap.get(codeOrApproval.trim());
        if (byCodeBatches && byCodeBatches.length > 0) {
          for (const batch of byCodeBatches) {
            const byBatch = this.batchToRecallMap.get(batch);
            if (byBatch) {
              byBatch.forEach(id => matchedIds.add(id));
              matchedBy.explicitMapping = true;
            }
          }
        }

        for (const mapping of this.explicitMappings) {
          const codeMatch = mapping.codes.includes(codeOrApproval.trim());
          const approvalMatch = approvalNumber && mapping.approvalNumbers.includes(approvalNumber.trim());
          if (codeMatch || approvalMatch) {
            mapping.recallIds.forEach(id => matchedIds.add(id));
            matchedBy.explicitMapping = true;
          }
        }
      }

      if (strictMode && matchedIds.size === 0) {
        return {
          notices: [],
          hasActiveRecall: false,
          matchedBy,
          errorMessage: batchNumber || approvalNumber || codeOrApproval
            ? '严格匹配模式下未找到关联的召回公告'
            : undefined
        };
      }

      let filtered = this.notices.filter(n => {
        const idMatched = matchedIds.size > 0 ? matchedIds.has(n.recallId) : true;
        const statusOk = includeInactive ? true : n.recallStatus === RecallStatus.ACTIVE;
        return idMatched && statusOk;
      });

      if (!strictMode) {
        filtered = filtered.filter(n => {
          if (n.recallStatus !== RecallStatus.ACTIVE && !includeInactive) {
            return false;
          }
          return true;
        });
      }

      filtered.sort((a, b) => {
        const levelOrder = {
          [RecallLevel.LEVEL_1]: 0,
          [RecallLevel.LEVEL_2]: 1,
          [RecallLevel.LEVEL_3]: 2
        };
        return levelOrder[a.recallLevel] - levelOrder[b.recallLevel];
      });

      const hasActiveRecall = filtered.some(n => n.recallStatus === RecallStatus.ACTIVE);
      const highestLevel = filtered.length > 0 ? filtered[0].recallLevel : undefined;

      return {
        notices: filtered,
        hasActiveRecall,
        highestLevel,
        matchedBy
      };
    } catch (error) {
      return {
        notices: [],
        hasActiveRecall: false,
        matchedBy: {},
        errorMessage: `召回查询失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  queryByLevel(level: RecallLevel, includeInactive?: boolean): RecallQueryResult {
    try {
      let filtered = this.notices.filter(n => n.recallLevel === level);
      if (!includeInactive) {
        filtered = filtered.filter(n => n.recallStatus === RecallStatus.ACTIVE);
      }
      return {
        notices: filtered,
        hasActiveRecall: filtered.some(n => n.recallStatus === RecallStatus.ACTIVE),
        highestLevel: level,
        matchedBy: {}
      };
    } catch (error) {
      return {
        notices: [],
        hasActiveRecall: false,
        matchedBy: {},
        errorMessage: `召回查询失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  getRecallById(recallId: string): RecallNotice | null {
    return this.notices.find(n => n.recallId === recallId) || null;
  }

  getActiveRecalls(): RecallNotice[] {
    return this.notices.filter(n => n.recallStatus === RecallStatus.ACTIVE);
  }

  getRecallSummary(
    codeOrApproval?: string,
    batchNumber?: string
  ): {
    total: number;
    active: number;
    level1: number;
    level2: number;
    level3: number;
    latestPublishDate?: string;
    strictMatched: boolean;
  } {
    const result = this.queryRecalls(codeOrApproval, batchNumber, { includeInactive: true });
    const notices = result.notices;
    const strictMatched =
      result.matchedBy.approvalNumber ||
      result.matchedBy.batchNumber ||
      result.matchedBy.explicitMapping;

    return {
      total: notices.length,
      active: notices.filter(n => n.recallStatus === RecallStatus.ACTIVE).length,
      level1: notices.filter(n => n.recallLevel === RecallLevel.LEVEL_1).length,
      level2: notices.filter(n => n.recallLevel === RecallLevel.LEVEL_2).length,
      level3: notices.filter(n => n.recallLevel === RecallLevel.LEVEL_3).length,
      latestPublishDate: notices.length > 0
        ? notices.reduce((latest, n) =>
          new Date(n.publishDate) > new Date(latest.publishDate) ? n : latest
        ).publishDate
        : undefined,
      strictMatched
    };
  }

  addRecallNotice(notice: RecallNotice): boolean {
    try {
      if (this.notices.some(n => n.recallId === notice.recallId)) {
        return false;
      }
      this.notices.push(notice);
      this.indexNotice(notice);
      return true;
    } catch {
      return false;
    }
  }

  updateRecallStatus(recallId: string, status: RecallStatus): boolean {
    const notice = this.notices.find(n => n.recallId === recallId);
    if (!notice) return false;
    notice.recallStatus = status;
    return true;
  }

  removeRecallNotice(recallId: string): boolean {
    const index = this.notices.findIndex(n => n.recallId === recallId);
    if (index < 0) return false;
    const removed = this.notices.splice(index, 1)[0];
    this.unindexNotice(removed);
    return true;
  }

  addCodeBatchMapping(code: string, batches: string[]): void {
    const key = code.trim();
    const existing = this.codeBatchMap.get(key) || [];
    this.codeBatchMap.set(key, [...new Set([...existing, ...batches])]);
  }

  addApprovalBatchMapping(approvalNumber: string, batches: string[]): void {
    const key = approvalNumber.trim();
    batches.forEach(batch => {
      const existing = this.batchToRecallMap.get(batch) || [];
      const relatedRecalls = this.notices.filter(n => n.affectedBatches.includes(batch)).map(n => n.recallId);
      if (relatedRecalls.length > 0) {
        this.batchToRecallMap.set(batch, [...new Set([...existing, ...relatedRecalls])]);
      }
    });

    const existingApproval = this.approvalToRecallMap.get(key) || [];
    const related = batches
      .flatMap(b => this.batchToRecallMap.get(b) || [])
      .filter(Boolean);
    if (related.length > 0) {
      this.approvalToRecallMap.set(key, [...new Set([...existingApproval, ...related])]);
    }
  }

  addExplicitMapping(mapping: {
    approvalNumbers?: string[];
    codes?: string[];
    recallIds: string[];
  }): void {
    const validRecallIds = mapping.recallIds.filter(id =>
      this.notices.some(n => n.recallId === id)
    );

    this.explicitMappings.push({
      approvalNumbers: mapping.approvalNumbers?.map(s => s.trim()) || [],
      codes: mapping.codes?.map(s => s.trim()) || [],
      recallIds: validRecallIds
    });

    if (mapping.approvalNumbers) {
      for (const approval of mapping.approvalNumbers) {
        const existing = this.approvalToRecallMap.get(approval.trim()) || [];
        this.approvalToRecallMap.set(approval.trim(), [...new Set([...existing, ...validRecallIds])]);
      }
    }
  }

  removeCodeBatchMapping(code: string): boolean {
    return this.codeBatchMap.delete(code.trim());
  }

  setStrictMatch(strict: boolean): void {
    this.strictMatch = strict;
  }

  isStrictMatch(): boolean {
    return this.strictMatch;
  }

  clearAll(): void {
    this.notices = [...DEFAULT_RECALL_NOTICES];
    this.explicitMappings = [];
    this.buildDefaultIndexes();
  }

  getAllNotices(): RecallNotice[] {
    return JSON.parse(JSON.stringify(this.notices));
  }

  formatRecallLevel(level: RecallLevel): string {
    const levelMap: Record<RecallLevel, string> = {
      [RecallLevel.LEVEL_1]: '一级召回（最严重）',
      [RecallLevel.LEVEL_2]: '二级召回（较严重）',
      [RecallLevel.LEVEL_3]: '三级召回（一般）'
    };
    return levelMap[level] || '未知等级';
  }

  formatRecallStatus(status: RecallStatus): string {
    const statusMap: Record<RecallStatus, string> = {
      [RecallStatus.ACTIVE]: '召回进行中',
      [RecallStatus.COMPLETED]: '召回已完成',
      [RecallStatus.CANCELLED]: '召回已取消'
    };
    return statusMap[status] || '未知状态';
  }

  getMappingsFor(approvalNumber?: string, code?: string): {
    relatedBatches: string[];
    relatedRecallIds: string[];
  } {
    const relatedBatches = new Set<string>();
    const relatedRecallIds = new Set<string>();

    if (code) {
      const batches = this.codeBatchMap.get(code.trim());
      if (batches) batches.forEach(b => relatedBatches.add(b));

      for (const mapping of this.explicitMappings) {
        if (mapping.codes.includes(code.trim())) {
          mapping.recallIds.forEach(id => relatedRecallIds.add(id));
        }
      }
    }

    if (approvalNumber) {
      const approvals = this.approvalToRecallMap.get(approvalNumber.trim());
      if (approvals) approvals.forEach(id => relatedRecallIds.add(id));

      for (const mapping of this.explicitMappings) {
        if (mapping.approvalNumbers.includes(approvalNumber.trim())) {
          mapping.recallIds.forEach(id => relatedRecallIds.add(id));
        }
      }
    }

    for (const batch of relatedBatches) {
      const recalls = this.batchToRecallMap.get(batch);
      if (recalls) recalls.forEach(id => relatedRecallIds.add(id));
    }

    return {
      relatedBatches: Array.from(relatedBatches),
      relatedRecallIds: Array.from(relatedRecallIds)
    };
  }

  private buildDefaultIndexes(): void {
    const defaultMappings = new Map<string, string[]>([
      ['1234567890123', ['B20230901', 'B20231001', 'B20231101']],
      ['国药准字H13021234', ['B20230901', 'B20231001', 'B20231101']]
    ]);

    this.codeBatchMap = new Map();
    this.approvalToRecallMap = new Map();
    this.batchToRecallMap = new Map();

    defaultMappings.forEach((batches, code) => {
      if (/^\d+$/.test(code)) {
        this.codeBatchMap.set(code, batches);
      } else {
        batches.forEach(batch => {
          for (const notice of DEFAULT_RECALL_NOTICES) {
            if (notice.affectedBatches.includes(batch)) {
              const existingApproval = this.approvalToRecallMap.get(code) || [];
              this.approvalToRecallMap.set(code, [...new Set([...existingApproval, notice.recallId])]);

              const existingBatch = this.batchToRecallMap.get(batch) || [];
              this.batchToRecallMap.set(batch, [...new Set([...existingBatch, notice.recallId])]);
            }
          }
        });
      }
    });

    for (const notice of DEFAULT_RECALL_NOTICES) {
      for (const batch of notice.affectedBatches) {
        const existing = this.batchToRecallMap.get(batch) || [];
        this.batchToRecallMap.set(batch, [...new Set([...existing, notice.recallId])]);
      }
    }
  }

  private indexNotice(notice: RecallNotice): void {
    for (const batch of notice.affectedBatches) {
      const existing = this.batchToRecallMap.get(batch) || [];
      this.batchToRecallMap.set(batch, [...new Set([...existing, notice.recallId])]);
    }
  }

  private unindexNotice(notice: RecallNotice): void {
    for (const batch of notice.affectedBatches) {
      const existing = this.batchToRecallMap.get(batch);
      if (existing) {
        const filtered = existing.filter(id => id !== notice.recallId);
        if (filtered.length === 0) {
          this.batchToRecallMap.delete(batch);
        } else {
          this.batchToRecallMap.set(batch, filtered);
        }
      }
    }
  }
}

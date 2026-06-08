import { RecallNotice, RecallLevel, RecallStatus } from '../types';

export interface RecallQueryResult {
  notices: RecallNotice[];
  hasActiveRecall: boolean;
  highestLevel?: RecallLevel;
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

export class RecallNotifierModule {
  private notices: RecallNotice[];
  private codeBatchMap: Map<string, string[]> = new Map();

  constructor(initialNotices?: RecallNotice[]) {
    this.notices = [...DEFAULT_RECALL_NOTICES, ...(initialNotices || [])];
    this.buildCodeBatchMap();
  }

  queryRecalls(
    codeOrApproval?: string,
    batchNumber?: string,
    options?: { includeInactive?: boolean }
  ): RecallQueryResult {
    try {
      const includeInactive = options?.includeInactive ?? false;
      let filtered = [...this.notices];

      if (!includeInactive) {
        filtered = filtered.filter(n => n.recallStatus === RecallStatus.ACTIVE);
      }

      if (batchNumber) {
        filtered = filtered.filter(n =>
          n.affectedBatches.includes(batchNumber.trim())
        );
      }

      if (codeOrApproval) {
        const key = codeOrApproval.trim();
        const mappedBatches = this.codeBatchMap.get(key);
        if (mappedBatches) {
          filtered = filtered.filter(n =>
            n.affectedBatches.some(b => mappedBatches.includes(b))
          );
        }
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
        highestLevel
      };
    } catch (error) {
      return {
        notices: [],
        hasActiveRecall: false,
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
        highestLevel: level
      };
    } catch (error) {
      return {
        notices: [],
        hasActiveRecall: false,
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
  } {
    const result = this.queryRecalls(codeOrApproval, batchNumber, { includeInactive: true });
    const notices = result.notices;

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
        : undefined
    };
  }

  addRecallNotice(notice: RecallNotice): boolean {
    try {
      if (this.notices.some(n => n.recallId === notice.recallId)) {
        return false;
      }
      this.notices.push(notice);
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
    this.notices.splice(index, 1);
    return true;
  }

  addCodeBatchMapping(code: string, batches: string[]): void {
    const key = code.trim();
    const existing = this.codeBatchMap.get(key) || [];
    this.codeBatchMap.set(key, [...new Set([...existing, ...batches])]);
  }

  removeCodeBatchMapping(code: string): boolean {
    return this.codeBatchMap.delete(code.trim());
  }

  clearAll(): void {
    this.notices = [...DEFAULT_RECALL_NOTICES];
    this.codeBatchMap.clear();
    this.buildCodeBatchMap();
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

  private buildCodeBatchMap(): void {
    const defaultMap = new Map<string, string[]>([
      ['1234567890123', ['B20230901', 'B20231001', 'B20231101']]
    ]);
    this.codeBatchMap = new Map(defaultMap);
  }
}

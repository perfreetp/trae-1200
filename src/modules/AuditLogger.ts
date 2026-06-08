import {
  QueryAuditRecord,
  AuditFilter,
  QuerySource,
  VerificationStatus,
  TraceQueryResult,
  DataSourceCategory,
  DataSourceType
} from '../types';
import { generateId, getStorageAdapter } from '../utils';

const STORAGE_KEY = 'drug_trace_audit_logs';

export type ExportFormat = 'json' | 'csv';

export class AuditLogger {
  private records: Map<string, QueryAuditRecord> = new Map();
  private enablePersistence: boolean;
  private storage: ReturnType<typeof getStorageAdapter>;
  private eventEmitter?: (eventType: string, data: unknown) => void;

  constructor(
    enablePersistence: boolean = false,
    eventEmitter?: (eventType: string, data: unknown) => void
  ) {
    this.enablePersistence = enablePersistence;
    this.storage = getStorageAdapter();
    this.eventEmitter = eventEmitter;

    if (enablePersistence) {
      this.loadFromStorage();
    }
  }

  logQuery(
    result: TraceQueryResult,
    sourceIdentifier: string,
    dataSources?: Partial<Record<DataSourceCategory, DataSourceType>>,
    extra?: Record<string, unknown>
  ): QueryAuditRecord {
    const record: QueryAuditRecord = {
      auditId: generateId(),
      source: result.querySource,
      sourceIdentifier,
      queryTime: result.queryTime,
      code: result.code,
      codeType: result.codeType,
      resultStatus: result.verificationStatus,
      isSuspectedFake: result.verificationStatus === VerificationStatus.SUSPECTED_FAKE,
      hasRecall: result.hasRecall,
      voucherId: result.queryVoucher?.voucherId || '',
      drugName: result.drugInfo?.drugName,
      batchNumber: result.batchInfo?.batchNumber,
      queryCount: result.queryCount,
      fromCache: result.fromCache,
      dataSources,
      extra
    };

    this.records.set(record.auditId, record);

    if (this.enablePersistence) {
      this.persist();
    }

    this.eventEmitter?.('audit_logged', { auditId: record.auditId, record });

    return record;
  }

  query(filter: AuditFilter = {}): QueryAuditRecord[] {
    let results = Array.from(this.records.values());

    if (filter.sources && filter.sources.length > 0) {
      results = results.filter(r => filter.sources!.includes(r.source));
    }

    if (filter.sourceIdentifiers && filter.sourceIdentifiers.length > 0) {
      results = results.filter(r => filter.sourceIdentifiers!.includes(r.sourceIdentifier));
    }

    if (filter.startTime) {
      const start = new Date(filter.startTime).getTime();
      results = results.filter(r => new Date(r.queryTime).getTime() >= start);
    }

    if (filter.endTime) {
      const end = new Date(filter.endTime).getTime();
      results = results.filter(r => new Date(r.queryTime).getTime() <= end);
    }

    if (filter.isSuspectedFake !== undefined) {
      results = results.filter(r => r.isSuspectedFake === filter.isSuspectedFake);
    }

    if (filter.hasRecall !== undefined) {
      results = results.filter(r => r.hasRecall === filter.hasRecall);
    }

    if (filter.resultStatuses && filter.resultStatuses.length > 0) {
      results = results.filter(r => filter.resultStatuses!.includes(r.resultStatus));
    }

    if (filter.codes && filter.codes.length > 0) {
      results = results.filter(r => filter.codes!.includes(r.code));
    }

    if (filter.voucherIds && filter.voucherIds.length > 0) {
      results = results.filter(r => filter.voucherIds!.includes(r.voucherId));
    }

    return results.sort((a, b) =>
      new Date(b.queryTime).getTime() - new Date(a.queryTime).getTime()
    );
  }

  getById(auditId: string): QueryAuditRecord | null {
    return this.records.get(auditId) || null;
  }

  getByVoucherId(voucherId: string): QueryAuditRecord | null {
    for (const record of this.records.values()) {
      if (record.voucherId === voucherId) {
        return record;
      }
    }
    return null;
  }

  getByCode(code: string): QueryAuditRecord[] {
    return this.query({ codes: [code] });
  }

  getBySource(source: QuerySource, sourceIdentifier?: string): QueryAuditRecord[] {
    return this.query({
      sources: [source],
      sourceIdentifiers: sourceIdentifier ? [sourceIdentifier] : undefined
    });
  }

  export(
    filter: AuditFilter = {},
    format: ExportFormat = 'json'
  ): string {
    const records = this.query(filter);

    if (format === 'json') {
      const result = JSON.stringify({
        exportedAt: new Date().toISOString(),
        total: records.length,
        filter,
        records
      }, null, 2);

      this.eventEmitter?.('audit_exported', { total: records.length, format, filter });

      return result;
    }

    return this.exportCSV(records);
  }

  downloadExport(
    filename: string,
    filter: AuditFilter = {},
    format: ExportFormat = 'json'
  ): { filename: string; content: string; mimeType: string } {
    const content = this.export(filter, format);
    const mimeType = format === 'json' ? 'application/json' : 'text/csv;charset=utf-8';
    const ext = format === 'json' ? 'json' : 'csv';
    const finalFilename = `${filename}.${ext}`;

    if (typeof document !== 'undefined') {
      try {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = finalFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (_e) {
        // 浏览器环境下下载失败忽略
      }
    }

    return { filename: finalFilename, content, mimeType };
  }

  getStatistics(filter: AuditFilter = {}): {
    total: number;
    bySource: Record<QuerySource, number>;
    byStatus: Record<VerificationStatus, number>;
    suspectedFakeCount: number;
    recallCount: number;
    cacheHitCount: number;
    uniqueCodes: number;
    timeRange?: { earliest: string; latest: string };
  } {
    const records = this.query(filter);

    const bySource = {} as Record<QuerySource, number>;
    const byStatus = {} as Record<VerificationStatus, number>;
    let suspectedFakeCount = 0;
    let recallCount = 0;
    let cacheHitCount = 0;
    const codeSet = new Set<string>();
    let earliest = records.length > 0 ? records[records.length - 1].queryTime : undefined;
    let latest = records.length > 0 ? records[0].queryTime : undefined;

    for (const record of records) {
      bySource[record.source] = (bySource[record.source] || 0) + 1;
      byStatus[record.resultStatus] = (byStatus[record.resultStatus] || 0) + 1;
      if (record.isSuspectedFake) suspectedFakeCount++;
      if (record.hasRecall) recallCount++;
      if (record.fromCache) cacheHitCount++;
      codeSet.add(record.code);

      const t = new Date(record.queryTime).getTime();
      if (earliest && t < new Date(earliest).getTime()) earliest = record.queryTime;
      if (latest && t > new Date(latest).getTime()) latest = record.queryTime;
    }

    return {
      total: records.length,
      bySource,
      byStatus,
      suspectedFakeCount,
      recallCount,
      cacheHitCount,
      uniqueCodes: codeSet.size,
      timeRange: earliest && latest ? { earliest, latest } : undefined
    };
  }

  clear(filter?: AuditFilter): number {
    if (!filter) {
      const count = this.records.size;
      this.records.clear();
      if (this.enablePersistence) {
        this.persist();
      }
      return count;
    }

    const toRemove = this.query(filter).map(r => r.auditId);
    for (const id of toRemove) {
      this.records.delete(id);
    }

    if (this.enablePersistence) {
      this.persist();
    }

    return toRemove.length;
  }

  count(filter: AuditFilter = {}): number {
    return this.query(filter).length;
  }

  getAllIds(): string[] {
    return Array.from(this.records.keys());
  }

  private exportCSV(records: QueryAuditRecord[]): string {
    const headers = [
      '审计ID', '查询来源', '来源编号', '查询时间', '条码', '码类型',
      '结果状态', '是否假码', '是否召回', '凭证ID', '药品名', '批号',
      '查询次数', '是否缓存命中'
    ];

    const sourceNames: Record<QuerySource, string> = {
      [QuerySource.HOSPITAL_KIOSK]: '医院自助机',
      [QuerySource.E_COMMERCE]: '电商售药页',
      [QuerySource.CUSTOMER_SERVICE]: '企业客服系统',
      [QuerySource.MOBILE_APP]: '移动APP',
      [QuerySource.WEBSITE]: '网站',
      [QuerySource.OTHER]: '其他'
    };

    const statusNames: Record<VerificationStatus, string> = {
      [VerificationStatus.VERIFIED]: '验证通过',
      [VerificationStatus.SUSPECTED_FAKE]: '疑似假码',
      [VerificationStatus.INVALID]: '无效条码',
      [VerificationStatus.EXPIRED]: '药品过期',
      [VerificationStatus.DUPLICATE]: '重复查询',
      [VerificationStatus.NETWORK_ERROR]: '网络错误',
      [VerificationStatus.PENDING]: '待验证'
    };

    const rows = records.map(r => [
      r.auditId,
      sourceNames[r.source] || r.source,
      r.sourceIdentifier,
      r.queryTime,
      r.code,
      r.codeType,
      statusNames[r.resultStatus] || r.resultStatus,
      r.isSuspectedFake ? '是' : '否',
      r.hasRecall ? '是' : '否',
      r.voucherId,
      r.drugName || '',
      r.batchNumber || '',
      r.queryCount.toString(),
      r.fromCache ? '是' : '否'
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

    return [
      headers.map(h => `"${h}"`).join(','),
      ...rows
    ].join('\n');
  }

  private persist(): void {
    try {
      const records = Array.from(this.records.values());
      this.storage.setItem(STORAGE_KEY, JSON.stringify(records));
    } catch (_e) {
      // 持久化失败忽略
    }
  }

  private loadFromStorage(): void {
    try {
      const data = this.storage.getItem(STORAGE_KEY);
      if (data) {
        const records: QueryAuditRecord[] = JSON.parse(data);
        for (const record of records) {
          this.records.set(record.auditId, record);
        }
      }
    } catch (_e) {
      // 加载失败忽略
    }
  }
}

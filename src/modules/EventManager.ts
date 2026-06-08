import {
  EventType,
  EventCallback,
  EventCallbackData,
  CustomMessages,
  VerificationStatus,
  QuerySource,
  QueryVoucher,
  VoucherSummary,
  TraceQueryResult,
  DrugBasicInfo,
  BatchInfo
} from '../types';
import { generateVoucher, validateVoucher, generateId, generateHash } from '../utils';

type ListenerMap = Map<EventType, Set<EventCallback>>;

const DEFAULT_MESSAGES: Required<CustomMessages> = {
  verified: '验证通过，药品信息真实有效',
  suspectedFake: '警告：该条码疑似假码，请谨慎使用并联系供应商核实',
  invalid: '条码格式无效，请检查输入或联系客服',
  expired: '该药品已超过有效期，请勿使用',
  duplicate: '该条码已被多次查询，请核实药品来源',
  networkError: '网络连接异常，请稍后重试或检查网络设置',
  pending: '正在验证中，请稍候...',
  recallDetected: '注意：该药品涉及召回，请查看召回详情'
};

const SOURCE_NAMES: Record<QuerySource, string> = {
  [QuerySource.HOSPITAL_KIOSK]: '医院自助机',
  [QuerySource.E_COMMERCE]: '电商售药页',
  [QuerySource.CUSTOMER_SERVICE]: '企业客服系统',
  [QuerySource.MOBILE_APP]: '移动APP',
  [QuerySource.WEBSITE]: '官方网站',
  [QuerySource.OTHER]: '其他渠道'
};

const STATUS_NAMES: Record<VerificationStatus, string> = {
  [VerificationStatus.VERIFIED]: '✅ 验证通过',
  [VerificationStatus.SUSPECTED_FAKE]: '⚠️ 疑似假码',
  [VerificationStatus.INVALID]: '❌ 无效条码',
  [VerificationStatus.EXPIRED]: '⏰ 药品过期',
  [VerificationStatus.DUPLICATE]: '📋 重复查询',
  [VerificationStatus.NETWORK_ERROR]: '🌐 网络异常',
  [VerificationStatus.PENDING]: '⏳ 待验证'
};

export class EventManager {
  private listeners: ListenerMap = new Map();
  private customMessages: Required<CustomMessages>;
  private querySource: QuerySource;
  private voucherHistory: Map<string, QueryVoucher> = new Map();
  private voucherToResultMap: Map<string, TraceQueryResult> = new Map();
  private voucherIdToResultMap: Map<string, TraceQueryResult> = new Map();

  constructor(
    customMessages?: CustomMessages,
    querySource: QuerySource = QuerySource.OTHER
  ) {
    this.customMessages = { ...DEFAULT_MESSAGES, ...(customMessages || {}) };
    this.querySource = querySource;
  }

  on(eventType: EventType, callback: EventCallback): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(callback);

    return () => {
      this.off(eventType, callback);
    };
  }

  off(eventType: EventType, callback: EventCallback): boolean {
    const listeners = this.listeners.get(eventType);
    if (!listeners) return false;
    return listeners.delete(callback);
  }

  once(eventType: EventType, callback: EventCallback): () => void {
    const wrapper: EventCallback = (data) => {
      this.off(eventType, wrapper);
      callback(data);
    };
    return this.on(eventType, wrapper);
  }

  emit(eventType: EventType, data?: Partial<EventCallbackData>): void {
    const listeners = this.listeners.get(eventType);
    if (!listeners || listeners.size === 0) return;

    const eventData: EventCallbackData = {
      eventType,
      timestamp: new Date().toISOString(),
      source: this.querySource,
      ...data
    };

    for (const callback of listeners) {
      try {
        callback(eventData);
      } catch (error) {
        console.error(`Event listener error for ${eventType}:`, error);
      }
    }
  }

  removeAllListeners(eventType?: EventType): void {
    if (eventType) {
      this.listeners.delete(eventType);
    } else {
      this.listeners.clear();
    }
  }

  getListenerCount(eventType?: EventType): number {
    if (eventType) {
      return this.listeners.get(eventType)?.size ?? 0;
    }
    let count = 0;
    for (const listeners of this.listeners.values()) {
      count += listeners.size;
    }
    return count;
  }

  setCustomMessage(key: keyof CustomMessages, message: string): void {
    this.customMessages[key] = message;
  }

  setCustomMessages(messages: CustomMessages): void {
    this.customMessages = { ...this.customMessages, ...messages };
  }

  getCustomMessage(key: keyof CustomMessages): string {
    return this.customMessages[key];
  }

  getCustomMessages(): Required<CustomMessages> {
    return { ...this.customMessages };
  }

  getMessageByStatus(status: VerificationStatus, isDuplicate?: boolean, hasRecall?: boolean): string {
    if (hasRecall) {
      return this.customMessages.recallDetected;
    }

    if (isDuplicate) {
      return this.customMessages.duplicate;
    }

    switch (status) {
      case VerificationStatus.VERIFIED:
        return this.customMessages.verified;
      case VerificationStatus.SUSPECTED_FAKE:
        return this.customMessages.suspectedFake;
      case VerificationStatus.INVALID:
        return this.customMessages.invalid;
      case VerificationStatus.EXPIRED:
        return this.customMessages.expired;
      case VerificationStatus.NETWORK_ERROR:
        return this.customMessages.networkError;
      case VerificationStatus.PENDING:
      default:
        return this.customMessages.pending;
    }
  }

  generateQueryVoucher(
    code: string,
    querySource?: QuerySource,
    ttl?: number,
    queryResult?: TraceQueryResult
  ): QueryVoucher {
    const actualSource = querySource || this.querySource;
    const voucher = generateVoucher(code, actualSource, ttl);
    this.voucherHistory.set(voucher.voucherId, voucher);
    this.voucherHistory.set(code, voucher);

    if (queryResult) {
      this.voucherToResultMap.set(voucher.voucherId, queryResult);
      this.voucherIdToResultMap.set(voucher.voucherId, queryResult);
    }

    this.emit(EventType.VOUCHER_GENERATED, {
      code,
      data: voucher
    });

    return voucher;
  }

  validateQueryVoucher(voucher: QueryVoucher | string, secret?: string): {
    valid: boolean;
    voucher?: QueryVoucher;
    error?: string;
  } {
    try {
      let resolvedVoucher: QueryVoucher;

      if (typeof voucher === 'string') {
        resolvedVoucher = this.voucherHistory.get(voucher) as QueryVoucher;
        if (!resolvedVoucher) {
          return { valid: false, error: '凭证不存在' };
        }
      } else {
        resolvedVoucher = voucher;
      }

      const isValid = validateVoucher(resolvedVoucher, secret);
      if (!isValid) {
        return { valid: false, error: '凭证无效或已过期', voucher: resolvedVoucher };
      }

      return { valid: true, voucher: resolvedVoucher };
    } catch (error) {
      return {
        valid: false,
        error: `验证失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  getVoucherById(voucherId: string): QueryVoucher | null {
    return this.voucherHistory.get(voucherId) || null;
  }

  getQueryResultByVoucher(voucherOrId: QueryVoucher | string): TraceQueryResult | null {
    const voucherId = typeof voucherOrId === 'string'
      ? voucherOrId
      : voucherOrId.voucherId;
    return this.voucherIdToResultMap.get(voucherId) || null;
  }

  generateVoucherSummary(
    voucherOrId: QueryVoucher | string,
    resultOverride?: TraceQueryResult
  ): {
    summary: VoucherSummary | null;
    error?: string;
  } {
    try {
      let voucher: QueryVoucher;
      if (typeof voucherOrId === 'string') {
        const found = this.voucherHistory.get(voucherOrId);
        if (!found) {
          return { summary: null, error: '凭证不存在' };
        }
        voucher = found;
      } else {
        voucher = voucherOrId;
      }

      const validation = this.validateQueryVoucher(voucher);
      if (!validation.valid) {
        return { summary: null, error: validation.error };
      }

      const queryResult = resultOverride || this.getQueryResultByVoucher(voucher);
      if (!queryResult) {
        return { summary: null, error: '未找到对应查询结果' };
      }

      const drugInfo: DrugBasicInfo | null = queryResult.drugInfo;
      const batchInfo: BatchInfo | null = queryResult.batchInfo;

      const displayItems = [
        `【药品追溯查询凭证】`,
        `─────────────────────`,
        `编号: ${voucher.voucherId}`,
        `药品: ${drugInfo?.drugName || '未知'}`,
        `规格: ${drugInfo?.specification || '-'}`,
        `批号: ${batchInfo?.batchNumber || '-'}`,
        `企业: ${drugInfo?.manufacturer || '-'}`,
        `来源: ${SOURCE_NAMES[voucher.querySource] || voucher.querySource}`,
        `时间: ${new Date(voucher.queryTime).toLocaleString('zh-CN')}`,
        `状态: ${STATUS_NAMES[queryResult.verificationStatus] || queryResult.verificationStatus}`,
        batchInfo ? `有效期: ${batchInfo.daysToExpire > 0 ? `剩余${batchInfo.daysToExpire}天` : '已过期'}` : '',
        `─────────────────────`,
        `校验码: ${this.buildShortIntegrityCode(voucher)}`,
        `完整性: ${validation.valid ? '✅ 有效' : '❌ 无效'}`
      ].filter(Boolean).join('\n');

      const summary: VoucherSummary = {
        voucherId: voucher.voucherId,
        drugName: drugInfo?.drugName || '未知药品',
        batchNumber: batchInfo?.batchNumber || '无',
        specification: drugInfo?.specification || '-',
        manufacturer: drugInfo?.manufacturer || '-',
        querySource: voucher.querySource,
        querySourceName: SOURCE_NAMES[voucher.querySource] || voucher.querySource,
        queryTime: voucher.queryTime,
        verificationStatus: queryResult.verificationStatus,
        verificationStatusName: STATUS_NAMES[queryResult.verificationStatus] || queryResult.verificationStatus,
        daysToExpire: batchInfo?.daysToExpire,
        isExpired: batchInfo?.isExpired ?? false,
        integrityVerified: validation.valid,
        integrityHash: this.buildShortIntegrityCode(voucher),
        displayText: displayItems
      };

      return { summary };
    } catch (error) {
      return {
        summary: null,
        error: `生成摘要失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  associateResultWithVoucher(voucherId: string, result: TraceQueryResult): void {
    this.voucherIdToResultMap.set(voucherId, result);
  }

  getAllVouchers(): QueryVoucher[] {
    return Array.from(this.voucherHistory.values()).filter(
      v => typeof v === 'object' && 'voucherId' in v
    );
  }

  clearExpiredVouchers(): number {
    const now = new Date();
    let cleared = 0;

    for (const [key, voucher] of this.voucherHistory) {
      if (typeof voucher === 'object' && 'expireTime' in voucher && new Date(voucher.expireTime) <= now) {
        this.voucherHistory.delete(key);
        if ('voucherId' in voucher) {
          this.voucherIdToResultMap.delete(voucher.voucherId);
        }
        cleared++;
      }
    }

    return cleared;
  }

  setQuerySource(source: QuerySource): void {
    this.querySource = source;
  }

  getQuerySource(): QuerySource {
    return this.querySource;
  }

  recordQuerySource(
    code: string,
    source: QuerySource,
    extra?: Record<string, unknown>
  ): {
    recordId: string;
    code: string;
    source: QuerySource;
    sourceName: string;
    timestamp: string;
    extra?: Record<string, unknown>;
  } {
    const record = {
      recordId: generateId(),
      code,
      source: source || this.querySource,
      sourceName: SOURCE_NAMES[source || this.querySource],
      timestamp: new Date().toISOString(),
      extra
    };

    this.emit(EventType.QUERY_SUCCESS, {
      code,
      data: record
    });

    return record;
  }

  notifyError(code: string | undefined, error: Error, context?: Record<string, unknown>): void {
    this.emit(EventType.QUERY_ERROR, {
      code,
      error,
      data: context
    });
  }

  notifyFakeCode(code: string, reasons: string[], context?: Record<string, unknown>): void {
    this.emit(EventType.FAKE_CODE_DETECTED, {
      code,
      data: { reasons, context }
    });
  }

  notifyDuplicateQuery(code: string, queryCount: number, context?: Record<string, unknown>): void {
    this.emit(EventType.DUPLICATE_QUERY, {
      code,
      data: { queryCount, context }
    });
  }

  notifyRecall(code: string, notices: Array<{ recallId: string; title: string; level: string }>): void {
    this.emit(EventType.RECALL_DETECTED, {
      code,
      data: { notices }
    });
  }

  notifyCacheHit(code: string, data?: unknown): void {
    this.emit(EventType.CACHE_HIT, {
      code,
      data
    });
  }

  notifyCacheMiss(code: string): void {
    this.emit(EventType.CACHE_MISS, {
      code
    });
  }

  notifyCacheCleaned(cleanedCount: number): void {
    this.emit(EventType.EXPIRED_CACHE_CLEANED, {
      data: { cleanedCount }
    });
  }

  notifyDataSourceError(category: string, source: string, error: string): void {
    this.emit(EventType.DATA_SOURCE_ERROR, {
      data: { category, source, error }
    });
  }

  notifyDataSourceFallback(category: string, from: string, to: string, error: string): void {
    this.emit(EventType.DATA_SOURCE_FALLBACK, {
      data: { category, from, to, error }
    });
  }

  private buildShortIntegrityCode(voucher: QueryVoucher): string {
    const data = `${voucher.voucherId}${voucher.code}${voucher.queryTime}${voucher.signature}`;
    const hash = generateHash(data, 'voucher-integrity');
    return hash.substring(0, 8).toUpperCase();
  }
}

import {
  EventType,
  EventCallback,
  EventCallbackData,
  CustomMessages,
  VerificationStatus,
  QuerySource
} from '../types';
import { generateVoucher, validateVoucher, generateId } from '../utils';
import type { QueryVoucher } from '../types';

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

export class EventManager {
  private listeners: ListenerMap = new Map();
  private customMessages: Required<CustomMessages>;
  private querySource: QuerySource;
  private voucherHistory: Map<string, QueryVoucher> = new Map();

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
    ttl?: number
  ): QueryVoucher {
    const voucher = generateVoucher(code, querySource || this.querySource, ttl);
    this.voucherHistory.set(voucher.voucherId, voucher);

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
        resolvedVoucher = this.voucherHistory.get(voucher)!;
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

  getAllVouchers(): QueryVoucher[] {
    return Array.from(this.voucherHistory.values());
  }

  clearExpiredVouchers(): number {
    const now = new Date();
    let cleared = 0;

    for (const [id, voucher] of this.voucherHistory) {
      if (new Date(voucher.expireTime) <= now) {
        this.voucherHistory.delete(id);
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

  recordQuerySource(code: string, source: QuerySource, extra?: Record<string, unknown>): {
    recordId: string;
    code: string;
    source: QuerySource;
    timestamp: string;
    extra?: Record<string, unknown>;
  } {
    const record = {
      recordId: generateId(),
      code,
      source: source || this.querySource,
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
}

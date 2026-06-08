import {
  SDKConfig,
  TraceQueryResult,
  DrugBasicInfo,
  QuerySource,
  CodeType,
  VerificationStatus,
  EventType,
  EventCallback,
  EventCallbackData,
  CustomMessages,
  QueryVoucher,
  FlowNodeType,
  RecallLevel,
  RecallStatus,
  InspectionStatus,
  BatchInfo,
  FlowNode,
  RecallNotice
} from './types';
import { CodeScanner, ParseResult } from './modules/CodeScanner';
import { VerificationModule, VerificationResult } from './modules/Verification';
import { BatchArchiveModule, BatchRegistry } from './modules/BatchArchive';
import { FlowTrackerModule, FlowRegistry } from './modules/FlowTracker';
import { RecallNotifierModule } from './modules/RecallNotifier';
import { CacheManager, CacheCategory } from './modules/CacheManager';
import { EventManager } from './modules/EventManager';
import { retryWithBackoff, generateId } from './utils';

const DEFAULT_CONFIG: Required<SDKConfig> = {
  apiBaseUrl: '',
  apiKey: '',
  enableCache: true,
  cacheTTL: 3600000,
  cacheMaxSize: 100,
  enableOffline: true,
  customMessages: {},
  querySource: QuerySource.OTHER,
  sourceIdentifier: '',
  autoCleanExpiredCache: true,
  cleanInterval: 300000,
  timeout: 30000,
  retryAttempts: 3,
  retryDelay: 1000
};

export class DrugTraceSDK {
  private config: Required<SDKConfig>;
  private scanner: CodeScanner;
  private verification: VerificationModule;
  private batchArchive: BatchArchiveModule;
  private flowTracker: FlowTrackerModule;
  private recallNotifier: RecallNotifierModule;
  private cache: CacheManager;
  private eventManager: EventManager;
  private initialized = false;

  constructor(config?: SDKConfig) {
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) };
    this.scanner = new CodeScanner();
    this.verification = new VerificationModule(this.scanner);
    this.batchArchive = new BatchArchiveModule();
    this.flowTracker = new FlowTrackerModule();
    this.recallNotifier = new RecallNotifierModule();
    this.cache = new CacheManager({
      ttl: this.config.cacheTTL,
      maxSize: this.config.cacheMaxSize,
      enablePersistence: this.config.enableOffline,
      autoClean: this.config.autoCleanExpiredCache,
      cleanInterval: this.config.cleanInterval
    });
    this.eventManager = new EventManager(
      this.config.customMessages,
      this.config.querySource
    );
    this.initialized = true;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get scannerModule(): CodeScanner {
    return this.scanner;
  }

  get verificationModule(): VerificationModule {
    return this.verification;
  }

  get batchModule(): BatchArchiveModule {
    return this.batchArchive;
  }

  get flowModule(): FlowTrackerModule {
    return this.flowTracker;
  }

  get recallModule(): RecallNotifierModule {
    return this.recallNotifier;
  }

  get cacheModule(): CacheManager {
    return this.cache;
  }

  get eventModule(): EventManager {
    return this.eventManager;
  }

  scanAndParse(code: string): ParseResult {
    this.ensureInitialized();
    return this.scanner.parse(code);
  }

  scanBatch(codes: string[]): ParseResult[] {
    this.ensureInitialized();
    return this.scanner.parseBatch(codes);
  }

  async query(code: string, options?: {
    batchNumber?: string;
    skipCache?: boolean;
    cacheTTL?: number;
    querySource?: QuerySource;
  }): Promise<TraceQueryResult> {
    this.ensureInitialized();

    const trimmedCode = code.trim();
    const querySource = options?.querySource || this.config.querySource;
    const useCache = this.config.enableCache && !options?.skipCache;

    if (useCache) {
      const cached = this.cache.getQueryResult(trimmedCode);
      if (cached) {
        this.eventManager.notifyCacheHit(trimmedCode, cached);
        return {
          ...cached,
          fromCache: true,
          queryTime: new Date().toISOString()
        };
      }
      this.eventManager.notifyCacheMiss(trimmedCode);
    }

    const executeQuery = async (): Promise<TraceQueryResult> => {
      const parseResult = this.scanner.parse(trimmedCode);
      const approvalNumber = parseResult.drugInfo?.approvalNumber || trimmedCode;
      const batchNumberFromParse = (parseResult.drugInfo as Record<string, unknown>)?.batchNumber as string | undefined;
      const finalBatchNumber = options?.batchNumber || batchNumberFromParse;

      const verificationResult = this.verification.verify(
        trimmedCode,
        parseResult.codeType,
        querySource,
        this.config.sourceIdentifier
      );

      if (verificationResult.isDuplicate) {
        this.eventManager.notifyDuplicateQuery(
          trimmedCode,
          verificationResult.queryCount
        );
      }

      if (verificationResult.isSuspectedFake) {
        this.eventManager.notifyFakeCode(trimmedCode, verificationResult.fakeReasons);
      }

      const batchResult = this.batchArchive.queryBatch(approvalNumber, finalBatchNumber);
      const flowResult = this.flowTracker.queryFlow(approvalNumber, finalBatchNumber);
      const recallResult = this.recallNotifier.queryRecalls(approvalNumber, finalBatchNumber);

      if (recallResult.hasActiveRecall) {
        this.eventManager.notifyRecall(
          trimmedCode,
          recallResult.notices.map(n => ({
            recallId: n.recallId,
            title: n.recallTitle,
            level: this.recallNotifier.formatRecallLevel(n.recallLevel)
          }))
        );
      }

      const voucher = this.eventManager.generateQueryVoucher(trimmedCode, querySource);

      this.eventManager.recordQuerySource(trimmedCode, querySource, {
        codeType: parseResult.codeType,
        verificationId: verificationResult.verificationId
      });

      let finalStatus = verificationResult.status;
      if (batchResult.batchInfo?.isExpired && finalStatus === VerificationStatus.VERIFIED) {
        finalStatus = VerificationStatus.EXPIRED;
      }

      const customMessage = this.eventManager.getMessageByStatus(
        finalStatus,
        verificationResult.isDuplicate,
        recallResult.hasActiveRecall
      );

      const result: TraceQueryResult = {
        success: parseResult.isValidFormat,
        code: trimmedCode,
        codeType: parseResult.codeType,
        drugInfo: this.mergeDrugInfo(parseResult, approvalNumber),
        batchInfo: batchResult.batchInfo,
        verificationStatus: finalStatus,
        isDuplicate: verificationResult.isDuplicate,
        queryCount: verificationResult.queryCount,
        firstQueryTime: verificationResult.firstQueryTime,
        lastQueryTime: verificationResult.lastQueryTime,
        flowNodes: flowResult.nodes,
        recallNotices: recallResult.notices,
        hasRecall: recallResult.hasActiveRecall,
        queryVoucher: voucher,
        queryTime: new Date().toISOString(),
        querySource,
        fromCache: false,
        customMessage,
        errorMessage: !parseResult.isValidFormat ? parseResult.parseErrors.join('; ') : undefined
      };

      if (useCache && parseResult.isValidFormat) {
        this.cache.setQueryResult(trimmedCode, result, options?.cacheTTL);
      }

      return result;
    };

    try {
      const result = await retryWithBackoff(
        executeQuery,
        this.config.retryAttempts,
        this.config.retryDelay,
        (error, attempt) => {
          this.eventManager.notifyError(trimmedCode, error, { attempt });
        }
      );
      return result;
    } catch (error) {
      const networkError: TraceQueryResult = {
        success: false,
        code: trimmedCode,
        codeType: CodeType.UNKNOWN,
        drugInfo: null,
        batchInfo: null,
        verificationStatus: VerificationStatus.NETWORK_ERROR,
        isDuplicate: false,
        queryCount: 0,
        flowNodes: [],
        recallNotices: [],
        hasRecall: false,
        queryVoucher: null,
        queryTime: new Date().toISOString(),
        querySource,
        fromCache: false,
        customMessage: this.eventManager.getMessageByStatus(VerificationStatus.NETWORK_ERROR),
        errorMessage: error instanceof Error ? error.message : '查询失败'
      };

      this.eventManager.notifyError(trimmedCode, error as Error);
      return networkError;
    }
  }

  on(event: EventType, callback: EventCallback): () => void {
    return this.eventManager.on(event, callback);
  }

  off(event: EventType, callback: EventCallback): boolean {
    return this.eventManager.off(event, callback);
  }

  setCustomMessages(messages: CustomMessages): void {
    this.eventManager.setCustomMessages(messages);
  }

  setCustomMessage(key: keyof CustomMessages, message: string): void {
    this.eventManager.setCustomMessage(key, message);
  }

  generateVoucher(code: string, querySource?: QuerySource, ttl?: number): QueryVoucher {
    return this.eventManager.generateQueryVoucher(code, querySource, ttl);
  }

  validateVoucher(voucher: QueryVoucher | string, secret?: string): {
    valid: boolean;
    voucher?: QueryVoucher;
    error?: string;
  } {
    return this.eventManager.validateQueryVoucher(voucher, secret);
  }

  clearCache(category?: CacheCategory): number {
    const cleared = this.cache.clear(category);
    if (cleared > 0) {
      this.eventManager.notifyCacheCleaned(cleared);
    }
    return cleared;
  }

  cleanExpiredCache(): number {
    const cleaned = this.cache.cleanExpired();
    if (cleaned > 0) {
      this.eventManager.notifyCacheCleaned(cleaned);
    }
    return cleaned;
  }

  registerBatchData(approvalNumber: string, batches: BatchRegistry[string]): boolean {
    return this.batchArchive.registerBatches(approvalNumber, batches);
  }

  registerFlowData(code: string, nodes: FlowNode[]): boolean {
    return this.flowTracker.addFlowNodes(code, nodes);
  }

  registerRecallNotice(notice: RecallNotice): boolean {
    return this.recallNotifier.addRecallNotice(notice);
  }

  destroy(): void {
    this.cache.stopAutoClean();
    this.eventManager.removeAllListeners();
    this.initialized = false;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('SDK 未初始化，请先创建实例');
    }
  }

  private mergeDrugInfo(
    parseResult: ParseResult,
    approvalNumber: string
  ): DrugBasicInfo | null {
    if (!parseResult.drugInfo) {
      return null;
    }

    const info = parseResult.drugInfo;
    return {
      code: info.code || parseResult.code,
      codeType: info.codeType || parseResult.codeType,
      drugName: info.drugName || '未知药品',
      genericName: info.genericName || '',
      specification: info.specification || '',
      manufacturer: info.manufacturer || '未知生产企业',
      manufacturerLicense: info.manufacturerLicense || '',
      approvalNumber: info.approvalNumber || approvalNumber,
      packagingSpecification: info.packagingSpecification,
      dosageForm: info.dosageForm,
      ingredient: info.ingredient,
      usage: info.usage,
      description: info.description,
      imageUrl: info.imageUrl
    };
  }
}

export {
  CodeType,
  VerificationStatus,
  InspectionStatus,
  FlowNodeType,
  RecallLevel,
  RecallStatus,
  QuerySource,
  EventType,
  generateId
};

export type {
  DrugBasicInfo,
  BatchInfo,
  FlowNode,
  RecallNotice,
  QueryVoucher,
  CustomMessages,
  TraceQueryResult,
  SDKConfig,
  EventCallbackData,
  EventCallback
};

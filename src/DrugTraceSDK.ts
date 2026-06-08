import {
  SDKConfig,
  TraceQueryResult,
  DrugBasicInfo,
  QuerySource,
  CodeType,
  VerificationStatus,
  EventType,
  EventCallback,
  CustomMessages,
  QueryVoucher,
  FlowNodeType,
  RecallLevel,
  RecallStatus,
  InspectionStatus,
  BatchInfo,
  FlowNode,
  RecallNotice,
  DataSourceType,
  DataSourceCategory,
  VoucherSummary,
  QueryAuditRecord,
  AuditFilter,
  DataSourceConfig,
  EventCallbackData
} from './types';
import { CodeScanner, ParseResult } from './modules/CodeScanner';
import { VerificationModule, VerificationResult } from './modules/Verification';
import { BatchArchiveModule, BatchRegistry } from './modules/BatchArchive';
import { FlowTrackerModule, FlowRegistry } from './modules/FlowTracker';
import { RecallNotifierModule } from './modules/RecallNotifier';
import { CacheManager, CacheCategory } from './modules/CacheManager';
import { EventManager } from './modules/EventManager';
import {
  LocalDataSource,
  DataSourceRouter,
  IDataSourceAdapter
} from './modules/DataSource';
import { AuditLogger, ExportFormat } from './modules/AuditLogger';
import { retryWithBackoff, generateId, calculateDaysToExpire } from './utils';

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
  retryDelay: 1000,
  dataSource: {
    drug: DataSourceType.LOCAL,
    batch: DataSourceType.LOCAL,
    flow: DataSourceType.LOCAL,
    recall: DataSourceType.LOCAL,
    fallbackToLocal: true
  },
  enableAuditLog: true,
  auditLogPersistence: false,
  recallStrictMatch: true
};

export class DrugTraceSDK {
  private config: Required<SDKConfig>;
  private scanner!: CodeScanner;
  private verification!: VerificationModule;
  private batchArchive!: BatchArchiveModule;
  private flowTracker!: FlowTrackerModule;
  private recallNotifier!: RecallNotifierModule;
  private cache!: CacheManager;
  private eventManager!: EventManager;
  private localDataSource!: LocalDataSource;
  private dataSourceRouter!: DataSourceRouter;
  private auditLogger!: AuditLogger;
  private initialized = false;
  private recallDefaultNotices: RecallNotice[] = [];

  constructor(config?: SDKConfig) {
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) };
    this.recallDefaultNotices = this.buildDefaultRecallNotices();
    this.initialize();
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

  get auditModule(): AuditLogger {
    return this.auditLogger;
  }

  get dataSource(): DataSourceRouter {
    return this.dataSourceRouter;
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
    approvalNumber?: string;
  }): Promise<TraceQueryResult> {
    this.ensureInitialized();

    const trimmedCode = code.trim();
    const querySource = options?.querySource || this.config.querySource;
    const useCache = this.config.enableCache && !options?.skipCache;

    if (useCache) {
      const cached = this.cache.getQueryResult(trimmedCode);
      if (cached) {
        return this.handleCacheHit(cached, querySource, options?.batchNumber);
      }
    }
    this.eventManager.notifyCacheMiss(trimmedCode);

    const executeQuery = async (): Promise<TraceQueryResult> => {
      const parseResult = this.scanner.parse(trimmedCode);
      const approvalNumber = options?.approvalNumber
        || parseResult.drugInfo?.approvalNumber
        || trimmedCode;
      const batchNumberFromParse = (parseResult.drugInfo as Record<string, unknown>)?.batchNumber as string | undefined;
      const finalBatchNumber = options?.batchNumber || batchNumberFromParse;

      const verificationResult = this.verification.verify(
        trimmedCode,
        parseResult.codeType,
        querySource,
        this.config.sourceIdentifier
      );

      this.handleVerificationEvents(trimmedCode, verificationResult);

      const dataSourceSummary: Record<DataSourceCategory, DataSourceType> = {
        [DataSourceCategory.DRUG]: DataSourceType.LOCAL,
        [DataSourceCategory.BATCH]: DataSourceType.LOCAL,
        [DataSourceCategory.FLOW]: DataSourceType.LOCAL,
        [DataSourceCategory.RECALL]: DataSourceType.LOCAL
      };

      const drugResponse = await this.dataSourceRouter.queryDrug(
        trimmedCode,
        approvalNumber,
        parseResult.codeType
      );
      dataSourceSummary[DataSourceCategory.DRUG] = drugResponse.sourceType;

      const batchResponse = await this.dataSourceRouter.queryBatch(
        approvalNumber,
        finalBatchNumber
      );
      dataSourceSummary[DataSourceCategory.BATCH] = batchResponse.sourceType;

      const flowResponse = await this.dataSourceRouter.queryFlow(
        trimmedCode,
        approvalNumber,
        finalBatchNumber
      );
      dataSourceSummary[DataSourceCategory.FLOW] = flowResponse.sourceType;

      const recallResult = this.recallNotifier.queryRecalls(
        trimmedCode,
        finalBatchNumber,
        {
          approvalNumber,
          useStrictMatch: this.config.recallStrictMatch
        }
      );
      dataSourceSummary[DataSourceCategory.RECALL] = DataSourceType.LOCAL;

      this.handleRecallEvents(trimmedCode, recallResult);

      const mergedDrugInfo = this.mergeDrugInfo(parseResult, drugResponse.data, approvalNumber);
      const finalBatchInfo = this.mergeBatchInfo(batchResponse.data);

      const voucher = this.eventManager.generateQueryVoucher(trimmedCode, querySource, undefined, undefined);

      let finalStatus = verificationResult.status;
      if (finalBatchInfo?.isExpired && finalStatus === VerificationStatus.VERIFIED) {
        finalStatus = VerificationStatus.EXPIRED;
      }
      if (verificationResult.isSuspectedFake && finalStatus !== VerificationStatus.NETWORK_ERROR) {
        finalStatus = VerificationStatus.SUSPECTED_FAKE;
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
        drugInfo: mergedDrugInfo,
        batchInfo: finalBatchInfo,
        verificationStatus: finalStatus,
        isDuplicate: verificationResult.isDuplicate,
        queryCount: verificationResult.queryCount,
        firstQueryTime: verificationResult.firstQueryTime,
        lastQueryTime: verificationResult.lastQueryTime,
        flowNodes: flowResponse.data || [],
        recallNotices: recallResult.notices,
        hasRecall: recallResult.hasActiveRecall,
        queryVoucher: voucher,
        queryTime: new Date().toISOString(),
        querySource,
        fromCache: false,
        customMessage,
        errorMessage: !parseResult.isValidFormat ? parseResult.parseErrors.join('; ') : undefined,
        dataSourceSummary
      };

      if (voucher) {
        this.eventManager.associateResultWithVoucher(voucher.voucherId, result);
      }

      if (this.config.enableAuditLog) {
        this.auditLogger.logQuery(
          result,
          this.config.sourceIdentifier,
          dataSourceSummary
        );
      }

      if (useCache && parseResult.isValidFormat) {
        this.cache.setQueryResult(trimmedCode, result, options?.cacheTTL);
      }

      return result;
    };

    try {
      return await retryWithBackoff(
        executeQuery,
        this.config.retryAttempts,
        this.config.retryDelay,
        (error, attempt) => {
          this.eventManager.notifyError(trimmedCode, error, { attempt });
        }
      );
    } catch (error) {
      return this.buildErrorResult(trimmedCode, querySource, error as Error);
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

  generateVoucher(
    code: string,
    querySource?: QuerySource,
    ttl?: number,
    result?: TraceQueryResult
  ): QueryVoucher {
    return this.eventManager.generateQueryVoucher(code, querySource, ttl, result);
  }

  validateVoucher(voucher: QueryVoucher | string, secret?: string): {
    valid: boolean;
    voucher?: QueryVoucher;
    error?: string;
  } {
    return this.eventManager.validateQueryVoucher(voucher, secret);
  }

  generateVoucherSummary(
    voucherOrId: QueryVoucher | string,
    resultOverride?: TraceQueryResult
  ): {
    summary: VoucherSummary | null;
    error?: string;
  } {
    return this.eventManager.generateVoucherSummary(voucherOrId, resultOverride);
  }

  getQueryResultByVoucher(voucherOrId: QueryVoucher | string): TraceQueryResult | null {
    return this.eventManager.getQueryResultByVoucher(voucherOrId);
  }

  queryAudit(filter: AuditFilter = {}): QueryAuditRecord[] {
    return this.auditLogger.query(filter);
  }

  exportAudit(
    filter: AuditFilter = {},
    format: ExportFormat = 'json'
  ): string {
    return this.auditLogger.export(filter, format);
  }

  downloadAuditExport(
    filename: string,
    filter: AuditFilter = {},
    format: ExportFormat = 'json'
  ): { filename: string; content: string; mimeType: string } {
    return this.auditLogger.downloadExport(filename, filter, format);
  }

  getAuditStatistics(filter: AuditFilter = {}) {
    return this.auditLogger.getStatistics(filter);
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
    const result = this.batchArchive.registerBatches(approvalNumber, batches);
    if (result) {
      this.syncRegistryToLocalDataSource();
    }
    return result;
  }

  registerFlowData(code: string, nodes: FlowNode[]): boolean {
    const result = this.flowTracker.addFlowNodes(code, nodes);
    if (result) {
      this.syncRegistryToLocalDataSource();
    }
    return result;
  }

  registerRecallNotice(notice: RecallNotice): boolean {
    return this.recallNotifier.addRecallNotice(notice);
  }

  setRecallStrictMatch(strict: boolean): void {
    this.recallNotifier.setStrictMatch(strict);
    this.config.recallStrictMatch = strict;
  }

  configureDataSource(config: Partial<DataSourceConfig>): void {
    const currentConfig = this.dataSourceRouter.getConfig();
    const newConfig = { ...currentConfig, ...config };
    this.config.dataSource = newConfig;
    this.rebuildDataSourceRouter(newConfig);
  }

  destroy(): void {
    this.cache.stopAutoClean();
    this.eventManager.removeAllListeners();
    this.initialized = false;
  }

  private initialize(): void {
    this.scanner = new CodeScanner();
    this.verification = new VerificationModule(this.scanner);
    this.batchArchive = new BatchArchiveModule();
    this.flowTracker = new FlowTrackerModule();
    this.recallNotifier = new RecallNotifierModule(this.recallDefaultNotices, this.config.recallStrictMatch);
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
    this.auditLogger = new AuditLogger(
      this.config.auditLogPersistence,
      (type, data) => {
        if (type === 'audit_logged') {
          this.eventManager.emit(EventType.AUDIT_LOGGED, {
            data
          });
        } else if (type === 'audit_exported') {
          this.eventManager.emit(EventType.AUDIT_EXPORTED, {
            data
          });
        }
      }
    );

    this.localDataSource = new LocalDataSource(
      {},
      (this.batchArchive as unknown as { batchRegistry: BatchRegistry }).batchRegistry,
      (this.flowTracker as unknown as { flowRegistry: FlowRegistry }).flowRegistry,
      this.recallDefaultNotices
    );
    this.dataSourceRouter = new DataSourceRouter(
      this.config.dataSource,
      this.localDataSource,
      (type, data) => {
        if (type === 'fallback') {
          const fallback = data as { category: string; from: string; to: string; error: string };
          this.eventManager.notifyDataSourceFallback(
            fallback.category,
            fallback.from,
            fallback.to,
            fallback.error
          );
        } else if (type === 'error') {
          const err = data as { category: string; source: string; error: string };
          this.eventManager.notifyDataSourceError(
            err.category,
            err.source,
            err.error
          );
        }
      }
    );
  }

  private rebuildDataSourceRouter(config: DataSourceConfig): void {
    this.syncRegistryToLocalDataSource();
    this.dataSourceRouter = new DataSourceRouter(
      config,
      this.localDataSource,
      (type, data) => {
        if (type === 'fallback') {
          const fallback = data as { category: string; from: string; to: string; error: string };
          this.eventManager.notifyDataSourceFallback(
            fallback.category,
            fallback.from,
            fallback.to,
            fallback.error
          );
        } else if (type === 'error') {
          const err = data as { category: string; source: string; error: string };
          this.eventManager.notifyDataSourceError(
            err.category,
            err.source,
            err.error
          );
        }
      }
    );
  }

  private syncRegistryToLocalDataSource(): void {
    const batchRegistry = (this.batchArchive as unknown as { batchRegistry: BatchRegistry }).batchRegistry;
    const flowRegistry = (this.flowTracker as unknown as { flowRegistry: FlowRegistry }).flowRegistry;
    this.localDataSource = new LocalDataSource(
      {},
      batchRegistry,
      flowRegistry,
      this.recallDefaultNotices
    );
  }

  private handleCacheHit(
    cached: TraceQueryResult,
    querySource: QuerySource,
    batchNumber?: string
  ): TraceQueryResult {
    const trimmedCode = cached.code;

    this.verification.addQueryRecord(
      trimmedCode,
      querySource,
      this.config.sourceIdentifier
    );

    const history = this.verification.getQueryHistory(trimmedCode);
    const newQueryCount = history.length;
    const isDuplicate = newQueryCount > 1;
    const lastQueryTime = history.length > 0
      ? history[history.length - 1].queryTime
      : cached.lastQueryTime;

    if (isDuplicate) {
      this.eventManager.notifyDuplicateQuery(trimmedCode, newQueryCount);
    }

    this.eventManager.notifyCacheHit(trimmedCode, cached);

    const newVoucher = this.eventManager.generateQueryVoucher(trimmedCode, querySource, undefined, undefined);

    const updated: TraceQueryResult = {
      ...cached,
      queryCount: newQueryCount,
      isDuplicate: true,
      queryTime: new Date().toISOString(),
      querySource,
      fromCache: true,
      lastQueryTime,
      queryVoucher: newVoucher,
      firstQueryTime: cached.firstQueryTime || history[0]?.queryTime
    };

    const finalStatus = this.recalculateStatus(updated);
    updated.verificationStatus = finalStatus;
    updated.customMessage = this.eventManager.getMessageByStatus(
      finalStatus,
      true,
      updated.hasRecall
    );

    if (newVoucher) {
      this.eventManager.associateResultWithVoucher(newVoucher.voucherId, updated);
    }

    if (this.config.enableAuditLog) {
      this.auditLogger.logQuery(
        updated,
        this.config.sourceIdentifier,
        cached.dataSourceSummary
      );
    }

    return updated;
  }

  private recalculateStatus(result: TraceQueryResult): VerificationStatus {
    if (result.verificationStatus === VerificationStatus.NETWORK_ERROR) {
      return result.verificationStatus;
    }
    if (result.batchInfo?.isExpired && result.verificationStatus === VerificationStatus.VERIFIED) {
      return VerificationStatus.EXPIRED;
    }
    if (this.verification.verify(
      result.code,
      result.codeType,
      result.querySource,
      this.config.sourceIdentifier
    ).isSuspectedFake) {
      return VerificationStatus.SUSPECTED_FAKE;
    }
    if (result.isDuplicate && result.verificationStatus === VerificationStatus.VERIFIED) {
      return VerificationStatus.VERIFIED;
    }
    return result.verificationStatus;
  }

  private handleVerificationEvents(code: string, result: VerificationResult): void {
    if (result.isDuplicate) {
      this.eventManager.notifyDuplicateQuery(code, result.queryCount);
    }
    if (result.isSuspectedFake) {
      this.eventManager.notifyFakeCode(code, result.fakeReasons);
    }
  }

  private handleRecallEvents(
    code: string,
    result: ReturnType<RecallNotifierModule['queryRecalls']>
  ): void {
    if (result.hasActiveRecall && result.notices.length > 0) {
      this.eventManager.notifyRecall(
        code,
        result.notices.map(n => ({
          recallId: n.recallId,
          title: n.recallTitle,
          level: this.recallNotifier.formatRecallLevel(n.recallLevel)
        }))
      );
    }
  }

  private mergeDrugInfo(
    parseResult: ParseResult,
    fromDataSource: DrugBasicInfo | null,
    approvalNumber: string
  ): DrugBasicInfo | null {
    const sourceInfo = parseResult.drugInfo;
    const dataSourceInfo = fromDataSource;

    if (!sourceInfo && !dataSourceInfo) {
      return null;
    }

    const baseInfo: Partial<DrugBasicInfo> = dataSourceInfo || sourceInfo || {};
    const parseInfo = sourceInfo || {};

    return {
      code: baseInfo.code || parseInfo.code || parseResult.code,
      codeType: baseInfo.codeType || parseInfo.codeType || parseResult.codeType,
      drugName: baseInfo.drugName || parseInfo.drugName || '未知药品',
      genericName: baseInfo.genericName || parseInfo.genericName || '',
      specification: baseInfo.specification || parseInfo.specification || '',
      manufacturer: baseInfo.manufacturer || parseInfo.manufacturer || '未知生产企业',
      manufacturerLicense: baseInfo.manufacturerLicense || parseInfo.manufacturerLicense || '',
      approvalNumber: baseInfo.approvalNumber || parseInfo.approvalNumber || approvalNumber,
      packagingSpecification: baseInfo.packagingSpecification || parseInfo.packagingSpecification,
      dosageForm: baseInfo.dosageForm || parseInfo.dosageForm,
      ingredient: baseInfo.ingredient || parseInfo.ingredient,
      usage: baseInfo.usage || parseInfo.usage,
      description: baseInfo.description || parseInfo.description,
      imageUrl: baseInfo.imageUrl || parseInfo.imageUrl
    };
  }

  private mergeBatchInfo(fromDataSource: BatchInfo | null): BatchInfo | null {
    if (!fromDataSource) {
      return null;
    }
    const daysToExpire = fromDataSource.daysToExpire ?? calculateDaysToExpire(fromDataSource.expirationDate);
    return {
      ...fromDataSource,
      daysToExpire,
      isExpired: daysToExpire <= 0
    };
  }

  private buildErrorResult(
    code: string,
    querySource: QuerySource,
    error: Error
  ): TraceQueryResult {
    this.eventManager.notifyError(code, error);

    const networkError: TraceQueryResult = {
      success: false,
      code,
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
      errorMessage: error.message || '查询失败'
    };

    if (this.config.enableAuditLog) {
      this.auditLogger.logQuery(
        networkError,
        this.config.sourceIdentifier,
        undefined,
        { errorDetail: error.message }
      );
    }

    return networkError;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('SDK 未初始化，请先创建实例');
    }
  }

  private buildDefaultRecallNotices(): RecallNotice[] {
    return [
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
  DataSourceType,
  DataSourceCategory,
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
  EventCallback,
  VoucherSummary,
  QueryAuditRecord,
  AuditFilter,
  DataSourceConfig
};

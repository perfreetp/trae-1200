import {
  DataSourceType,
  DataSourceCategory,
  DataSourceResponse,
  DataSourceConfig,
  DrugBasicInfo,
  BatchInfo,
  FlowNode,
  RecallNotice,
  CodeType
} from '../types';
import type { BatchRegistry } from './BatchArchive';
import type { FlowRegistry } from './FlowTracker';
import { retryWithBackoff } from '../utils';

export interface IDataSourceAdapter {
  getType(): DataSourceType;
  fetchDrugInfo(code: string, approvalNumber?: string, codeType?: CodeType): Promise<DataSourceResponse<DrugBasicInfo>>;
  fetchBatchInfo(approvalNumber: string, batchNumber?: string): Promise<DataSourceResponse<BatchInfo>>;
  fetchFlowNodes(code: string, approvalNumber?: string, batchNumber?: string): Promise<DataSourceResponse<FlowNode[]>>;
  fetchRecallNotices(code: string, approvalNumber?: string, batchNumber?: string): Promise<DataSourceResponse<RecallNotice[]>>;
}

const DEFAULT_LOCAL_DRUGS: Record<string, DrugBasicInfo> = {
  '1234567890123': {
    code: '1234567890123',
    codeType: CodeType.BARCODE_1D,
    drugName: '阿莫西林胶囊',
    genericName: '阿莫西林',
    specification: '0.5g*24粒',
    manufacturer: '华北制药集团有限责任公司',
    manufacturerLicense: '京HZ20200001',
    approvalNumber: '国药准字H13021234',
    packagingSpecification: '每盒24粒，每板12粒×2板',
    dosageForm: '胶囊剂',
    ingredient: '阿莫西林',
    usage: '口服。成人一次0.5g，每6～8小时1次',
    description: '青霉素类抗生素'
  }
};

export class LocalDataSource implements IDataSourceAdapter {
  private drugs: Record<string, DrugBasicInfo>;
  private batchRegistry: BatchRegistry;
  private flowRegistry: FlowRegistry;
  private recallNotices: RecallNotice[];
  private codeApprovalMap: Map<string, string>;
  private recallAffectedMap: Map<string, string[]>;

  constructor(
    drugs?: Record<string, DrugBasicInfo>,
    batchRegistry?: BatchRegistry,
    flowRegistry?: FlowRegistry,
    recallNotices?: RecallNotice[]
  ) {
    this.drugs = { ...DEFAULT_LOCAL_DRUGS, ...(drugs || {}) };
    this.batchRegistry = batchRegistry || {};
    this.flowRegistry = flowRegistry || {};
    this.recallNotices = recallNotices || [];
    this.codeApprovalMap = new Map<string, string>();
    Object.keys(DEFAULT_LOCAL_DRUGS).forEach(k => {
      this.codeApprovalMap.set(k, DEFAULT_LOCAL_DRUGS[k].approvalNumber);
    });
    this.recallAffectedMap = new Map<string, string[]>([
      ['1234567890123', ['B20230901', 'B20231001', 'B20231101']]
    ]);
  }

  getType(): DataSourceType {
    return DataSourceType.LOCAL;
  }

  async fetchDrugInfo(
    code: string,
    approvalNumber?: string,
    _codeType?: CodeType
  ): Promise<DataSourceResponse<DrugBasicInfo>> {
    const startTime = Date.now();
    const key = approvalNumber && this.drugs[approvalNumber]
      ? approvalNumber
      : code;
    const drug = this.drugs[key] || Object.values(this.drugs).find(
      d => d.code === code || d.approvalNumber === approvalNumber
    );

    return {
      success: !!drug,
      data: drug || null,
      sourceType: DataSourceType.LOCAL,
      latency: Date.now() - startTime,
      fallbackUsed: false,
      errorMessage: drug ? undefined : '本地数据源未找到药品信息'
    };
  }

  async fetchBatchInfo(
    approvalNumber: string,
    batchNumber?: string
  ): Promise<DataSourceResponse<BatchInfo>> {
    const startTime = Date.now();
    const batches = this.batchRegistry[approvalNumber];
    let matched: BatchRegistry[string][number] | undefined;

    if (batches && batches.length > 0) {
      matched = batchNumber
        ? batches.find(b => b.batchNumber === batchNumber)
        : batches[batches.length - 1];
    }

    if (!matched) {
      return {
        success: false,
        data: null,
        sourceType: DataSourceType.LOCAL,
        latency: Date.now() - startTime,
        fallbackUsed: false,
        errorMessage: '本地数据源未找到批次信息'
      };
    }

    const now = Date.now();
    const expiration = new Date(matched.expirationDate).getTime();
    const daysToExpire = Math.ceil((expiration - now) / (1000 * 60 * 60 * 24));

    const batchInfo: BatchInfo = {
      batchNumber: matched.batchNumber,
      productionDate: matched.productionDate,
      expirationDate: matched.expirationDate,
      inspectionStatus: matched.inspectionStatus,
      inspectionReportNumber: matched.inspectionReportNumber,
      inspectionReportUrl: matched.inspectionReportUrl,
      inspector: matched.inspector,
      inspectionDate: matched.inspectionDate,
      isExpired: daysToExpire <= 0,
      daysToExpire,
      productionQuantity: matched.productionQuantity,
      productionLine: matched.productionLine,
      remark: matched.remark
    };

    return {
      success: true,
      data: batchInfo,
      sourceType: DataSourceType.LOCAL,
      latency: Date.now() - startTime,
      fallbackUsed: false
    };
  }

  async fetchFlowNodes(
    code: string,
    approvalNumber?: string,
    batchNumber?: string
  ): Promise<DataSourceResponse<FlowNode[]>> {
    const startTime = Date.now();
    const key = approvalNumber || code;
    let nodes = this.flowRegistry[key] || this.flowRegistry[code];

    if (nodes && batchNumber) {
      nodes = nodes.filter(n => n.batchNumber === batchNumber);
    }

    return {
      success: !!nodes && nodes.length > 0,
      data: nodes || [],
      sourceType: DataSourceType.LOCAL,
      latency: Date.now() - startTime,
      fallbackUsed: false,
      errorMessage: nodes && nodes.length > 0 ? undefined : '本地数据源未找到流向信息'
    };
  }

  async fetchRecallNotices(
    _code: string,
    approvalNumber?: string,
    batchNumber?: string
  ): Promise<DataSourceResponse<RecallNotice[]>> {
    const startTime = Date.now();
    const affectedBatches = approvalNumber
      ? this.recallAffectedMap.get(approvalNumber) || []
      : [];
    const matched = this.recallNotices.filter(notice => {
      if (batchNumber && notice.affectedBatches.includes(batchNumber)) {
        return true;
      }
      if (affectedBatches.some(b => notice.affectedBatches.includes(b))) {
        return true;
      }
      return false;
    });

    return {
      success: true,
      data: matched,
      sourceType: DataSourceType.LOCAL,
      latency: Date.now() - startTime,
      fallbackUsed: false
    };
  }

  registerDrug(code: string, info: DrugBasicInfo): void {
    this.drugs[code] = info;
    if (info.approvalNumber) {
      this.drugs[info.approvalNumber] = info;
    }
  }

  addRecallMapping(approvalNumber: string, affectedBatches: string[]): void {
    const existing = this.recallAffectedMap.get(approvalNumber) || [];
    this.recallAffectedMap.set(approvalNumber, [...new Set([...existing, ...affectedBatches])]);
  }

  setRecallNotices(notices: RecallNotice[]): void {
    this.recallNotices = notices;
  }
}

export class HttpDataSource implements IDataSourceAdapter {
  private config: NonNullable<DataSourceConfig['httpConfig']>;
  private defaultTimeout: number;
  private defaultRetry: number;

  constructor(config: NonNullable<DataSourceConfig['httpConfig']>) {
    this.config = config;
    this.defaultTimeout = config.timeout || 10000;
    this.defaultRetry = config.retryAttempts || 2;
  }

  getType(): DataSourceType {
    return DataSourceType.HTTP;
  }

  private async request<T>(
    endpoint: string | undefined,
    params: Record<string, string>
  ): Promise<{ success: boolean; data?: T; errorMessage?: string; latency: number }> {
    const startTime = Date.now();

    if (!endpoint) {
      return {
        success: false,
        errorMessage: '未配置接口地址',
        latency: Date.now() - startTime
      };
    }

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        resolve({
          success: false,
          errorMessage: `HTTP 请求超时 (${this.defaultTimeout}ms)`,
          latency: Date.now() - startTime
        });
      }, this.defaultTimeout);

      retryWithBackoff(
        async () => {
          const url = new URL(endpoint, this.config.baseUrl);
          Object.entries(params).forEach(([k, v]) => {
            url.searchParams.set(k, v);
          });

          const headers: Record<string, string> = {
            'Content-Type': 'application/json'
          };
          if (this.config.apiKey) {
            headers['X-API-Key'] = this.config.apiKey;
          }

          const response = await fetch(url.toString(), {
            method: 'GET',
            headers
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const json = await response.json();
          return json;
        },
        this.defaultRetry,
        500
      ).then(
        (data) => {
          resolve({
            success: true,
            data,
            latency: Date.now() - startTime
          });
        }
      ).catch((error) => {
        clearTimeout(timeoutId);
        resolve({
          success: false,
          errorMessage: error instanceof Error ? error.message : '未知错误',
          latency: Date.now() - startTime
        });
      });
    });
  }

  async fetchDrugInfo(
    code: string,
    approvalNumber?: string,
    _codeType?: CodeType
  ): Promise<DataSourceResponse<DrugBasicInfo>> {
    const startTime = Date.now();
    const result = await this.request<DrugBasicInfo>(
      this.config.endpoints?.drug,
      { code, approvalNumber: approvalNumber || '' }
    );

    return {
      success: result.success,
      data: result.success ? result.data || null : null,
      errorMessage: result.errorMessage,
      sourceType: DataSourceType.HTTP,
      latency: result.success ? result.latency : Date.now() - startTime,
      fallbackUsed: false
    };
  }

  async fetchBatchInfo(
    approvalNumber: string,
    batchNumber?: string
  ): Promise<DataSourceResponse<BatchInfo>> {
    const startTime = Date.now();
    const result = await this.request<BatchInfo>(
      this.config.endpoints?.batch,
      { approvalNumber, batchNumber: batchNumber || '' }
    );

    return {
      success: result.success,
      data: result.success ? result.data || null : null,
      errorMessage: result.errorMessage,
      sourceType: DataSourceType.HTTP,
      latency: result.success ? result.latency : Date.now() - startTime,
      fallbackUsed: false
    };
  }

  async fetchFlowNodes(
    code: string,
    approvalNumber?: string,
    batchNumber?: string
  ): Promise<DataSourceResponse<FlowNode[]>> {
    const startTime = Date.now();
    const result = await this.request<FlowNode[]>(
      this.config.endpoints?.flow,
      { code, approvalNumber: approvalNumber || '', batchNumber: batchNumber || '' }
    );

    return {
      success: result.success,
      data: result.success ? result.data || [] : [],
      errorMessage: result.errorMessage,
      sourceType: DataSourceType.HTTP,
      latency: result.success ? result.latency : Date.now() - startTime,
      fallbackUsed: false
    };
  }

  async fetchRecallNotices(
    code: string,
    approvalNumber?: string,
    batchNumber?: string
  ): Promise<DataSourceResponse<RecallNotice[]>> {
    const startTime = Date.now();
    const result = await this.request<RecallNotice[]>(
      this.config.endpoints?.recall,
      { code, approvalNumber: approvalNumber || '', batchNumber: batchNumber || '' }
    );

    return {
      success: result.success,
      data: result.success ? result.data || [] : [],
      errorMessage: result.errorMessage,
      sourceType: DataSourceType.HTTP,
      latency: result.success ? result.latency : Date.now() - startTime,
      fallbackUsed: false
    };
  }
}

export class CustomDataSource implements IDataSourceAdapter {
  private handlers: NonNullable<DataSourceConfig['customHandlers']>;

  constructor(handlers: NonNullable<DataSourceConfig['customHandlers']>) {
    this.handlers = handlers;
  }

  getType(): DataSourceType {
    return DataSourceType.CUSTOM;
  }

  async fetchDrugInfo(
    code: string,
    approvalNumber?: string,
    _codeType?: CodeType
  ): Promise<DataSourceResponse<DrugBasicInfo>> {
    const startTime = Date.now();
    const handler = this.handlers.drug;
    if (!handler) {
      return {
        success: false,
        data: null,
        errorMessage: '未配置药品查询处理器',
        sourceType: DataSourceType.CUSTOM,
        latency: Date.now() - startTime,
        fallbackUsed: false
      };
    }

    try {
      const data = await handler(code, approvalNumber);
      return {
        success: !!data,
        data: data || null,
        errorMessage: data ? undefined : '自定义数据源未找到药品信息',
        sourceType: DataSourceType.CUSTOM,
        latency: Date.now() - startTime,
        fallbackUsed: false
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        errorMessage: error instanceof Error ? error.message : '自定义查询异常',
        sourceType: DataSourceType.CUSTOM,
        latency: Date.now() - startTime,
        fallbackUsed: false
      };
    }
  }

  async fetchBatchInfo(
    approvalNumber: string,
    batchNumber?: string
  ): Promise<DataSourceResponse<BatchInfo>> {
    const startTime = Date.now();
    const handler = this.handlers.batch;
    if (!handler) {
      return {
        success: false,
        data: null,
        errorMessage: '未配置批次查询处理器',
        sourceType: DataSourceType.CUSTOM,
        latency: Date.now() - startTime,
        fallbackUsed: false
      };
    }

    try {
      const data = await handler(approvalNumber, batchNumber);
      return {
        success: !!data,
        data: data || null,
        errorMessage: data ? undefined : '自定义数据源未找到批次信息',
        sourceType: DataSourceType.CUSTOM,
        latency: Date.now() - startTime,
        fallbackUsed: false
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        errorMessage: error instanceof Error ? error.message : '自定义查询异常',
        sourceType: DataSourceType.CUSTOM,
        latency: Date.now() - startTime,
        fallbackUsed: false
      };
    }
  }

  async fetchFlowNodes(
    code: string,
    approvalNumber?: string,
    batchNumber?: string
  ): Promise<DataSourceResponse<FlowNode[]>> {
    const startTime = Date.now();
    const handler = this.handlers.flow;
    if (!handler) {
      return {
        success: false,
        data: [],
        errorMessage: '未配置流向查询处理器',
        sourceType: DataSourceType.CUSTOM,
        latency: Date.now() - startTime,
        fallbackUsed: false
      };
    }

    try {
      const data = await handler(code, approvalNumber, batchNumber);
      return {
        success: true,
        data: data || [],
        sourceType: DataSourceType.CUSTOM,
        latency: Date.now() - startTime,
        fallbackUsed: false
      };
    } catch (error) {
      return {
        success: false,
        data: [],
        errorMessage: error instanceof Error ? error.message : '自定义查询异常',
        sourceType: DataSourceType.CUSTOM,
        latency: Date.now() - startTime,
        fallbackUsed: false
      };
    }
  }

  async fetchRecallNotices(
    code: string,
    approvalNumber?: string,
    batchNumber?: string
  ): Promise<DataSourceResponse<RecallNotice[]>> {
    const startTime = Date.now();
    const handler = this.handlers.recall;
    if (!handler) {
      return {
        success: false,
        data: [],
        errorMessage: '未配置召回查询处理器',
        sourceType: DataSourceType.CUSTOM,
        latency: Date.now() - startTime,
        fallbackUsed: false
      };
    }

    try {
      const data = await handler(code, approvalNumber, batchNumber);
      return {
        success: true,
        data: data || [],
        sourceType: DataSourceType.CUSTOM,
        latency: Date.now() - startTime,
        fallbackUsed: false
      };
    } catch (error) {
      return {
        success: false,
        data: [],
        errorMessage: error instanceof Error ? error.message : '自定义查询异常',
        sourceType: DataSourceType.CUSTOM,
        latency: Date.now() - startTime,
        fallbackUsed: false
      };
    }
  }
}

export class DataSourceRouter {
  private config: DataSourceConfig;
  private localSource: LocalDataSource;
  private httpSource?: HttpDataSource;
  private customSource?: CustomDataSource;
  private eventEmitter?: (eventType: string, data: unknown) => void;

  constructor(
    config: DataSourceConfig,
    localSource: LocalDataSource,
    eventEmitter?: (eventType: string, data: unknown) => void
  ) {
    const defaults: DataSourceConfig = {
      drug: DataSourceType.LOCAL,
      batch: DataSourceType.LOCAL,
      flow: DataSourceType.LOCAL,
      recall: DataSourceType.LOCAL,
      fallbackToLocal: true
    };
    this.config = { ...defaults, ...config };
    this.localSource = localSource;
    this.eventEmitter = eventEmitter;

    if (config.httpConfig) {
      this.httpSource = new HttpDataSource(config.httpConfig);
    }
    if (config.customHandlers) {
      this.customSource = new CustomDataSource(config.customHandlers);
    }
  }

  private getAdapter(category: DataSourceCategory): IDataSourceAdapter {
    const type = this.config[category] || DataSourceType.LOCAL;
    switch (type) {
      case DataSourceType.HTTP:
        return this.httpSource || this.localSource;
      case DataSourceType.CUSTOM:
        return this.customSource || this.localSource;
      case DataSourceType.LOCAL:
      default:
        return this.localSource;
    }
  }

  private emit(eventType: string, data: unknown): void {
    this.eventEmitter?.(eventType, data);
  }

  private async withFallback<T>(
    category: DataSourceCategory,
    primaryFn: (adapter: IDataSourceAdapter) => Promise<DataSourceResponse<T>>,
    fallbackFn: () => Promise<DataSourceResponse<T>>
  ): Promise<DataSourceResponse<T>> {
    const adapter = this.getAdapter(category);
    const primary = adapter.getType();
    let result = await primaryFn(adapter);

    if (!result.success && this.config.fallbackToLocal && primary !== DataSourceType.LOCAL) {
      this.emit(
        'fallback', {
        category,
        from: primary,
        to: DataSourceType.LOCAL,
        error: result.errorMessage
      });
      const fallback = await fallbackFn();
      return {
        ...fallback,
        fallbackUsed: true
      };
    }

    if (!result.success) {
      this.emit('error', {
        category,
        source: primary,
        error: result.errorMessage
      });
    }

    return result;
  }

  async queryDrug(
    code: string,
    approvalNumber?: string,
    codeType?: CodeType
  ): Promise<DataSourceResponse<DrugBasicInfo>> {
    return this.withFallback(
      DataSourceCategory.DRUG,
      (adapter) => adapter.fetchDrugInfo(code, approvalNumber, codeType),
      () => this.localSource.fetchDrugInfo(code, approvalNumber, codeType)
    );
  }

  async queryBatch(
    approvalNumber: string,
    batchNumber?: string
  ): Promise<DataSourceResponse<BatchInfo>> {
    return this.withFallback(
      DataSourceCategory.BATCH,
      (adapter) => adapter.fetchBatchInfo(approvalNumber, batchNumber),
      () => this.localSource.fetchBatchInfo(approvalNumber, batchNumber)
    );
  }

  async queryFlow(
    code: string,
    approvalNumber?: string,
    batchNumber?: string
  ): Promise<DataSourceResponse<FlowNode[]>> {
    return this.withFallback(
      DataSourceCategory.FLOW,
      (adapter) => adapter.fetchFlowNodes(code, approvalNumber, batchNumber),
      () => this.localSource.fetchFlowNodes(code, approvalNumber, batchNumber)
    );
  }

  async queryRecall(
    code: string,
    approvalNumber?: string,
    batchNumber?: string
  ): Promise<DataSourceResponse<RecallNotice[]>> {
    return this.withFallback(
      DataSourceCategory.RECALL,
      (adapter) => adapter.fetchRecallNotices(code, approvalNumber, batchNumber),
      () => this.localSource.fetchRecallNotices(code, approvalNumber, batchNumber)
    );
  }

  getConfig(): DataSourceConfig {
    return { ...this.config };
  }

  getLocalSource(): LocalDataSource {
    return this.localSource;
  }
}

export enum CodeType {
  UNKNOWN = 'unknown',
  BARCODE_1D = 'barcode_1d',
  QR_CODE = 'qr_code',
  DM_CODE = 'dm_code',
  GS1 = 'gs1'
}

export enum VerificationStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  SUSPECTED_FAKE = 'suspected_fake',
  INVALID = 'invalid',
  EXPIRED = 'expired',
  DUPLICATE = 'duplicate',
  NETWORK_ERROR = 'network_error'
}

export enum InspectionStatus {
  NOT_INSPECTED = 'not_inspected',
  IN_PROGRESS = 'in_progress',
  PASSED = 'passed',
  FAILED = 'failed',
  EXEMPT = 'exempt'
}

export enum FlowNodeType {
  MANUFACTURER = 'manufacturer',
  WHOLESALER = 'wholesaler',
  DISTRIBUTOR = 'distributor',
  HOSPITAL = 'hospital',
  PHARMACY = 'pharmacy',
  RETAILER = 'retailer',
  CONSUMER = 'consumer',
  RECALL = 'recall'
}

export enum RecallLevel {
  LEVEL_1 = 'level_1',
  LEVEL_2 = 'level_2',
  LEVEL_3 = 'level_3'
}

export enum RecallStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled'
}

export enum QuerySource {
  HOSPITAL_KIOSK = 'hospital_kiosk',
  E_COMMERCE = 'e_commerce',
  CUSTOMER_SERVICE = 'customer_service',
  MOBILE_APP = 'mobile_app',
  WEBSITE = 'website',
  OTHER = 'other'
}

export enum EventType {
  QUERY_SUCCESS = 'query_success',
  QUERY_ERROR = 'query_error',
  FAKE_CODE_DETECTED = 'fake_code_detected',
  DUPLICATE_QUERY = 'duplicate_query',
  RECALL_DETECTED = 'recall_detected',
  CACHE_HIT = 'cache_hit',
  CACHE_MISS = 'cache_miss',
  EXPIRED_CACHE_CLEANED = 'expired_cache_cleaned',
  VOUCHER_GENERATED = 'voucher_generated',
  DATA_SOURCE_ERROR = 'data_source_error',
  DATA_SOURCE_FALLBACK = 'data_source_fallback',
  AUDIT_LOGGED = 'audit_logged',
  AUDIT_EXPORTED = 'audit_exported'
}

export enum DataSourceType {
  LOCAL = 'local',
  HTTP = 'http',
  CUSTOM = 'custom'
}

export enum DataSourceCategory {
  DRUG = 'drug',
  BATCH = 'batch',
  FLOW = 'flow',
  RECALL = 'recall'
}

export interface DataSourceResponse<T> {
  success: boolean;
  data: T | null;
  errorMessage?: string;
  sourceType: DataSourceType;
  latency: number;
  fallbackUsed: boolean;
}

export interface DrugBasicInfo {
  code: string;
  codeType: CodeType;
  drugName: string;
  genericName: string;
  specification: string;
  manufacturer: string;
  manufacturerLicense: string;
  approvalNumber: string;
  packagingSpecification?: string;
  dosageForm?: string;
  ingredient?: string;
  usage?: string;
  description?: string;
  imageUrl?: string;
}

export interface BatchInfo {
  batchNumber: string;
  productionDate: string;
  expirationDate: string;
  inspectionStatus: InspectionStatus;
  inspectionReportNumber?: string;
  inspectionReportUrl?: string;
  inspector?: string;
  inspectionDate?: string;
  isExpired: boolean;
  daysToExpire: number;
  productionQuantity?: number;
  productionLine?: string;
  remark?: string;
}

export interface FlowNode {
  nodeId: string;
  nodeType: FlowNodeType;
  nodeName: string;
  nodeLicense: string;
  operator?: string;
  operationTime: string;
  operationType: string;
  fromLocation?: string;
  toLocation?: string;
  quantity?: number;
  batchNumber: string;
  contactPhone?: string;
  contactAddress?: string;
  remark?: string;
}

export interface RecallNotice {
  recallId: string;
  recallLevel: RecallLevel;
  recallStatus: RecallStatus;
  recallTitle: string;
  recallReason: string;
  recallScope: string;
  initiator: string;
  publishDate: string;
  deadlineDate?: string;
  affectedBatches: string[];
  measures: string[];
  contactInfo?: {
    name: string;
    phone: string;
    email?: string;
  };
  relatedDocuments?: Array<{
    title: string;
    url: string;
  }>;
}

export interface QueryVoucher {
  voucherId: string;
  code: string;
  queryTime: string;
  querySource: QuerySource;
  queryHash: string;
  expireTime: string;
  signature: string;
}

export interface CustomMessages {
  verified?: string;
  suspectedFake?: string;
  invalid?: string;
  expired?: string;
  duplicate?: string;
  networkError?: string;
  pending?: string;
  recallDetected?: string;
}

export interface TraceQueryResult {
  success: boolean;
  code: string;
  codeType: CodeType;
  drugInfo: DrugBasicInfo | null;
  batchInfo: BatchInfo | null;
  verificationStatus: VerificationStatus;
  isDuplicate: boolean;
  queryCount: number;
  firstQueryTime?: string;
  lastQueryTime?: string;
  flowNodes: FlowNode[];
  recallNotices: RecallNotice[];
  hasRecall: boolean;
  queryVoucher: QueryVoucher | null;
  queryTime: string;
  querySource: QuerySource;
  fromCache: boolean;
  customMessage?: string;
  errorMessage?: string;
  dataSourceSummary?: Record<DataSourceCategory, DataSourceType>;
}

export interface QueryAuditRecord {
  auditId: string;
  source: QuerySource;
  sourceIdentifier: string;
  queryTime: string;
  code: string;
  codeType: CodeType;
  resultStatus: VerificationStatus;
  isSuspectedFake: boolean;
  hasRecall: boolean;
  voucherId: string;
  drugName?: string;
  batchNumber?: string;
  queryCount: number;
  fromCache: boolean;
  dataSources?: Partial<Record<DataSourceCategory, DataSourceType>>;
  extra?: Record<string, unknown>;
}

export interface AuditFilter {
  sources?: QuerySource[];
  sourceIdentifiers?: string[];
  startTime?: string;
  endTime?: string;
  isSuspectedFake?: boolean;
  hasRecall?: boolean;
  resultStatuses?: VerificationStatus[];
  codes?: string[];
  voucherIds?: string[];
}

export interface VoucherSummary {
  voucherId: string;
  drugName: string;
  batchNumber: string;
  specification: string;
  manufacturer: string;
  querySource: QuerySource;
  querySourceName: string;
  queryTime: string;
  verificationStatus: VerificationStatus;
  verificationStatusName: string;
  daysToExpire?: number;
  isExpired: boolean;
  integrityVerified: boolean;
  integrityHash: string;
  displayText: string;
}

export interface DataSourceConfig {
  drug?: DataSourceType;
  batch?: DataSourceType;
  flow?: DataSourceType;
  recall?: DataSourceType;
  fallbackToLocal: boolean;
  httpConfig?: {
    baseUrl: string;
    apiKey?: string;
    timeout?: number;
    retryAttempts?: number;
    endpoints?: {
      drug?: string;
      batch?: string;
      flow?: string;
      recall?: string;
    };
  };
  customHandlers?: {
    drug?: (code: string, approvalNumber?: string) => Promise<DrugBasicInfo | null>;
    batch?: (approvalNumber: string, batchNumber?: string) => Promise<BatchInfo | null>;
    flow?: (code: string, approvalNumber?: string, batchNumber?: string) => Promise<FlowNode[]>;
    recall?: (code: string, approvalNumber?: string, batchNumber?: string) => Promise<RecallNotice[]>;
  };
}

export interface SDKConfig {
  apiBaseUrl?: string;
  apiKey?: string;
  enableCache?: boolean;
  cacheTTL?: number;
  cacheMaxSize?: number;
  enableOffline?: boolean;
  customMessages?: CustomMessages;
  querySource?: QuerySource;
  sourceIdentifier?: string;
  autoCleanExpiredCache?: boolean;
  cleanInterval?: number;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
  dataSource?: DataSourceConfig;
  enableAuditLog?: boolean;
  auditLogPersistence?: boolean;
  recallStrictMatch?: boolean;
}

export interface EventCallbackData {
  eventType: EventType;
  timestamp: string;
  source: QuerySource;
  code?: string;
  data?: unknown;
  error?: Error;
}

export type EventCallback = (data: EventCallbackData) => void;

export interface CacheEntry<T> {
  key: string;
  value: T;
  createTime: number;
  expireTime: number;
  accessCount: number;
}

export { DrugTraceSDK } from './DrugTraceSDK';

export { CodeScanner } from './modules/CodeScanner';
export type { ParseResult } from './modules/CodeScanner';

export { VerificationModule } from './modules/Verification';
export type { QueryRecord, VerificationResult } from './modules/Verification';

export { BatchArchiveModule } from './modules/BatchArchive';
export type { BatchQueryResult, BatchRegistry } from './modules/BatchArchive';

export { FlowTrackerModule } from './modules/FlowTracker';
export type { FlowQueryResult, FlowRegistry } from './modules/FlowTracker';

export { RecallNotifierModule } from './modules/RecallNotifier';
export type { RecallQueryResult } from './modules/RecallNotifier';

export { CacheManager } from './modules/CacheManager';
export type { CacheStats, CacheCategory } from './modules/CacheManager';

export { EventManager } from './modules/EventManager';

export {
  LocalDataSource,
  HttpDataSource,
  CustomDataSource,
  DataSourceRouter
} from './modules/DataSource';
export type { IDataSourceAdapter } from './modules/DataSource';

export { AuditLogger } from './modules/AuditLogger';
export type { ExportFormat } from './modules/AuditLogger';

export * from './types';

export * from './utils';

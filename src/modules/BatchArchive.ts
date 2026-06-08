import { BatchInfo, InspectionStatus } from '../types';
import { calculateDaysToExpire, isExpired } from '../utils';

export interface BatchQueryResult {
  batchInfo: BatchInfo | null;
  found: boolean;
  errorMessage?: string;
}

export interface BatchRegistry {
  [approvalNumber: string]: Array<{
    batchNumber: string;
    productionDate: string;
    expirationDate: string;
    inspectionStatus: InspectionStatus;
    inspectionReportNumber?: string;
    inspectionReportUrl?: string;
    inspector?: string;
    inspectionDate?: string;
    productionQuantity?: number;
    productionLine?: string;
    remark?: string;
  }>;
}

export class BatchArchiveModule {
  private batchRegistry: BatchRegistry = {};
  private defaultBatches: BatchRegistry = {
    '1234567890123': [
      {
        batchNumber: 'B20240101',
        productionDate: '2024-01-15T00:00:00.000Z',
        expirationDate: '2026-01-14T23:59:59.999Z',
        inspectionStatus: InspectionStatus.PASSED,
        inspectionReportNumber: 'INS-2024-001',
        inspector: '张检验员',
        inspectionDate: '2024-01-20T00:00:00.000Z',
        productionQuantity: 50000,
        productionLine: 'A线-01号'
      }
    ]
  };

  constructor(initialRegistry?: BatchRegistry) {
    this.batchRegistry = { ...this.defaultBatches, ...(initialRegistry || {}) };
  }

  queryBatch(approvalNumber: string, batchNumber?: string): BatchQueryResult {
    try {
      const key = approvalNumber.trim();
      const batches = this.batchRegistry[key];

      if (!batches || batches.length === 0) {
        return {
          batchInfo: null,
          found: false,
          errorMessage: '未找到该批准文号对应的批次信息'
        };
      }

      let matchedBatch;
      if (batchNumber) {
        matchedBatch = batches.find(b => b.batchNumber === batchNumber.trim());
        if (!matchedBatch) {
          return {
            batchInfo: null,
            found: false,
            errorMessage: `未找到批次号为 ${batchNumber} 的批次信息`
          };
        }
      } else {
        matchedBatch = batches[batches.length - 1];
      }

      const batchInfo: BatchInfo = this.createBatchInfo(matchedBatch);

      return {
        batchInfo,
        found: true
      };
    } catch (error) {
      return {
        batchInfo: null,
        found: false,
        errorMessage: `批次查询失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  queryAllBatches(approvalNumber: string): {
    batches: BatchInfo[];
    found: boolean;
    errorMessage?: string;
  } {
    try {
      const key = approvalNumber.trim();
      const batches = this.batchRegistry[key];

      if (!batches || batches.length === 0) {
        return {
          batches: [],
          found: false,
          errorMessage: '未找到该批准文号对应的批次信息'
        };
      }

      const result = batches.map(b => this.createBatchInfo(b));

      return {
        batches: result,
        found: true
      };
    } catch (error) {
      return {
        batches: [],
        found: false,
        errorMessage: `批次查询失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  registerBatch(
    approvalNumber: string,
    batchData: BatchRegistry[string][number]
  ): boolean {
    try {
      const key = approvalNumber.trim();
      if (!this.batchRegistry[key]) {
        this.batchRegistry[key] = [];
      }

      const existingIndex = this.batchRegistry[key].findIndex(
        b => b.batchNumber === batchData.batchNumber
      );

      if (existingIndex >= 0) {
        this.batchRegistry[key][existingIndex] = batchData;
      } else {
        this.batchRegistry[key].push(batchData);
      }

      return true;
    } catch {
      return false;
    }
  }

  registerBatches(approvalNumber: string, batchDataList: BatchRegistry[string]): boolean {
    try {
      for (const batchData of batchDataList) {
        this.registerBatch(approvalNumber, batchData);
      }
      return true;
    } catch {
      return false;
    }
  }

  removeBatch(approvalNumber: string, batchNumber: string): boolean {
    try {
      const key = approvalNumber.trim();
      const batches = this.batchRegistry[key];
      if (!batches) return false;

      const index = batches.findIndex(b => b.batchNumber === batchNumber.trim());
      if (index < 0) return false;

      batches.splice(index, 1);

      if (batches.length === 0) {
        delete this.batchRegistry[key];
      }

      return true;
    } catch {
      return false;
    }
  }

  checkExpiration(expirationDate: string): {
    isExpired: boolean;
    daysToExpire: number;
    status: 'expired' | 'critical' | 'warning' | 'normal';
  } {
    const days = calculateDaysToExpire(expirationDate);
    const expired = isExpired(expirationDate);

    let status: 'expired' | 'critical' | 'warning' | 'normal';
    if (expired) {
      status = 'expired';
    } else if (days <= 30) {
      status = 'critical';
    } else if (days <= 90) {
      status = 'warning';
    } else {
      status = 'normal';
    }

    return {
      isExpired: expired,
      daysToExpire: days,
      status
    };
  }

  getApprovalNumbers(): string[] {
    return Object.keys(this.batchRegistry);
  }

  clearRegistry(): void {
    this.batchRegistry = { ...this.defaultBatches };
  }

  getRegistrySnapshot(): BatchRegistry {
    return JSON.parse(JSON.stringify(this.batchRegistry));
  }

  private createBatchInfo(raw: BatchRegistry[string][number]): BatchInfo {
    const expiration = this.checkExpiration(raw.expirationDate);

    return {
      batchNumber: raw.batchNumber,
      productionDate: raw.productionDate,
      expirationDate: raw.expirationDate,
      inspectionStatus: raw.inspectionStatus,
      inspectionReportNumber: raw.inspectionReportNumber,
      inspectionReportUrl: raw.inspectionReportUrl,
      inspector: raw.inspector,
      inspectionDate: raw.inspectionDate,
      isExpired: expiration.isExpired,
      daysToExpire: expiration.daysToExpire,
      productionQuantity: raw.productionQuantity,
      productionLine: raw.productionLine,
      remark: raw.remark
    };
  }
}

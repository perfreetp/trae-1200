import { VerificationStatus, InspectionStatus, CodeType } from '../types';
import { CodeScanner } from './CodeScanner';

export interface QueryRecord {
  code: string;
  queryTime: string;
  querySource: string;
  sourceIdentifier?: string;
}

export interface VerificationResult {
  status: VerificationStatus;
  isSuspectedFake: boolean;
  isDuplicate: boolean;
  queryCount: number;
  firstQueryTime?: string;
  lastQueryTime?: string;
  inspectionStatus: InspectionStatus;
  fakeReasons: string[];
  verificationId: string;
  message?: string;
}

const FAKE_CODE_PATTERNS = [
  { pattern: /^0{8,}$/, reason: '条码全为0' },
  { pattern: /^1{8,}$/, reason: '条码全为1' },
  { pattern: /^1234567890/, reason: '条码为连续数字序列' },
  { pattern: /(\d)\1{7,}/, reason: '条码为重复数字' },
  { pattern: /999999999999/, reason: '条码为异常测试数据' },
];

const BLACKLIST_CODES = new Set<string>([
  '0000000000000',
  '1111111111111',
  '1234567890123',
  '9999999999999',
]);

export class VerificationModule {
  private queryHistory: Map<string, QueryRecord[]> = new Map();
  private codeScanner: CodeScanner;
  private blacklist: Set<string> = new Set(BLACKLIST_CODES);

  constructor(codeScanner?: CodeScanner) {
    this.codeScanner = codeScanner || new CodeScanner();
  }

  checkSuspectedFake(
    code: string,
    codeType: CodeType
  ): {
    isSuspectedFake: boolean;
    fakeReasons: string[];
  } {
    const fakeReasons: string[] = [];

    const formatValid = this.checkFormatValidity(code);
    if (!formatValid.valid) {
      fakeReasons.push(...formatValid.reasons);
    }

    if (this.isInBlacklist(code)) {
      fakeReasons.push('该条码在黑名单中');
    }

    const patternIssues = this.checkPatternIssues(code);
    fakeReasons.push(...patternIssues);

    const checkDigitValid = this.codeScanner.validateCheckDigit(code);
    if (!checkDigitValid) {
      fakeReasons.push('校验位验证失败');
    }

    const suspiciousPattern = this.codeScanner.checkSuspiciousPattern(code);
    if (suspiciousPattern) {
      fakeReasons.push('条码格式疑似异常');
    }

    if (codeType === CodeType.UNKNOWN) {
      fakeReasons.push('无法识别的条码类型');
    }

    return {
      isSuspectedFake: fakeReasons.length > 0,
      fakeReasons
    };
  }

  verify(
    code: string,
    codeType: CodeType,
    querySource: string,
    sourceIdentifier?: string
  ): VerificationResult {
    const fakeReasons: string[] = [];
    let status = VerificationStatus.PENDING;
    let inspectionStatus = InspectionStatus.NOT_INSPECTED;

    const formatValid = this.checkFormatValidity(code);
    if (!formatValid.valid) {
      fakeReasons.push(...formatValid.reasons);
    }

    if (this.isInBlacklist(code)) {
      fakeReasons.push('该条码在黑名单中');
    }

    const patternIssues = this.checkPatternIssues(code);
    fakeReasons.push(...patternIssues);

    const checkDigitValid = this.codeScanner.validateCheckDigit(code);
    if (!checkDigitValid) {
      fakeReasons.push('校验位验证失败');
    }

    const suspiciousPattern = this.codeScanner.checkSuspiciousPattern(code);
    if (suspiciousPattern) {
      fakeReasons.push('条码格式疑似异常');
    }

    if (codeType === CodeType.UNKNOWN) {
      fakeReasons.push('无法识别的条码类型');
    }

    const queryRecords = this.getQueryHistory(code);
    const isDuplicate = queryRecords.length > 0;
    const queryCount = queryRecords.length + 1;

    this.addQueryRecord(code, querySource, sourceIdentifier);
    const updatedRecords = this.getQueryHistory(code);
    const firstQueryTime = updatedRecords.length > 0 ? updatedRecords[0].queryTime : undefined;
    const lastQueryTime = updatedRecords.length > 0 ? updatedRecords[updatedRecords.length - 1].queryTime : undefined;

    const isSuspectedFake = fakeReasons.length > 0;

    if (fakeReasons.length >= 3) {
      status = VerificationStatus.SUSPECTED_FAKE;
    } else if (fakeReasons.length > 0 && codeType === CodeType.UNKNOWN) {
      status = VerificationStatus.INVALID;
    } else if (fakeReasons.length > 0) {
      status = VerificationStatus.SUSPECTED_FAKE;
    } else {
      status = VerificationStatus.VERIFIED;
    }

    const verificationId = this.generateVerificationId(code);

    return {
      status,
      isSuspectedFake,
      isDuplicate,
      queryCount,
      firstQueryTime,
      lastQueryTime,
      inspectionStatus,
      fakeReasons,
      verificationId,
      message: this.generateStatusMessage(status, isDuplicate)
    };
  }

  checkFormatValidity(code: string): { valid: boolean; reasons: string[] } {
    const reasons: string[] = [];

    if (!code || code.trim().length === 0) {
      reasons.push('条码为空');
      return { valid: false, reasons };
    }

    const trimmed = code.trim();

    if (trimmed.length < 4) {
      reasons.push('条码长度过短');
    }

    if (trimmed.length > 200) {
      reasons.push('条码长度过长');
    }

    if (/[^\x20-\x7E]/.test(trimmed) && !/[\u4e00-\u9fa5]/.test(trimmed)) {
      reasons.push('条码包含非法字符');
    }

    return {
      valid: reasons.length === 0,
      reasons
    };
  }

  checkPatternIssues(code: string): string[] {
    const issues: string[] = [];

    for (const { pattern, reason } of FAKE_CODE_PATTERNS) {
      if (pattern.test(code)) {
        issues.push(reason);
      }
    }

    return issues;
  }

  isInBlacklist(code: string): boolean {
    return this.blacklist.has(code) || this.blacklist.has(code.trim());
  }

  addToBlacklist(code: string): void {
    this.blacklist.add(code.trim());
  }

  removeFromBlacklist(code: string): boolean {
    return this.blacklist.delete(code.trim());
  }

  getBlacklist(): string[] {
    return Array.from(this.blacklist);
  }

  addQueryRecord(code: string, querySource: string, sourceIdentifier?: string): void {
    const trimmedCode = code.trim();
    const records = this.queryHistory.get(trimmedCode) || [];
    records.push({
      code: trimmedCode,
      queryTime: new Date().toISOString(),
      querySource,
      sourceIdentifier
    });
    this.queryHistory.set(trimmedCode, records);
  }

  getQueryHistory(code: string): QueryRecord[] {
    return this.queryHistory.get(code.trim()) || [];
  }

  clearQueryHistory(code?: string): void {
    if (code) {
      this.queryHistory.delete(code.trim());
    } else {
      this.queryHistory.clear();
    }
  }

  getAllQueryHistory(): Map<string, QueryRecord[]> {
    return new Map(this.queryHistory);
  }

  setInspectionStatus(_code: string, status: InspectionStatus): void {
    // Stub for future integration with backend inspection data
    void status;
  }

  getInspectionStatus(_code: string): InspectionStatus {
    // Stub for future integration with backend inspection data
    return InspectionStatus.NOT_INSPECTED;
  }

  private generateVerificationId(code: string): string {
    const timestamp = Date.now().toString(36);
    const codeHash = this.simpleHash(code);
    return `V-${timestamp}-${codeHash}`;
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  private generateStatusMessage(status: VerificationStatus, isDuplicate: boolean): string {
    if (isDuplicate) {
      return '该条码已被重复查询，请核实药品来源';
    }

    switch (status) {
      case VerificationStatus.VERIFIED:
        return '条码验证通过，信息真实有效';
      case VerificationStatus.SUSPECTED_FAKE:
        return '警告：该条码疑似假码，请谨慎使用';
      case VerificationStatus.INVALID:
        return '条码格式无效，请检查输入';
      case VerificationStatus.EXPIRED:
        return '该药品已过有效期';
      case VerificationStatus.NETWORK_ERROR:
        return '网络异常，请稍后重试';
      default:
        return '验证中，请稍候...';
    }
  }
}

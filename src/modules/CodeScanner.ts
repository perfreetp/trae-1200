import { CodeType, DrugBasicInfo } from '../types';
import { validateGS1Code, parseGS1Code, parseBarcode } from '../utils';

export interface ParseResult {
  code: string;
  codeType: CodeType;
  rawData: Record<string, unknown>;
  drugInfo: Partial<DrugBasicInfo> | null;
  isValidFormat: boolean;
  parseErrors: string[];
}

const GS1_PATTERN = /^01\d{14}/;
const DM_PATTERN = /^[A-Z0-9]{20,}$/;
const QR_PATTERN = /[{["]/;
const EAN13_PATTERN = /^\d{13}$/;
const EAN8_PATTERN = /^\d{8}$/;
const UPCA_PATTERN = /^\d{12}$/;
const CODE128_PATTERN = /^[\x20-\x7E]+$/;

const SUSPICIOUS_PATTERNS = [
  /0{8,}/,
  /1{8,}/,
  /(\d)\1{6,}/,
  /^1234567890123/,
  /^0000000000000/,
  /9999999999999/
];

export class CodeScanner {
  private customParsers: Map<CodeType, (code: string) => Partial<DrugBasicInfo> | null> = new Map();

  detectCodeType(code: string): CodeType {
    if (!code || typeof code !== 'string') {
      return CodeType.UNKNOWN;
    }

    const trimmedCode = code.trim();

    if (GS1_PATTERN.test(trimmedCode) && validateGS1Code(trimmedCode)) {
      return CodeType.GS1;
    }

    if (QR_PATTERN.test(trimmedCode)) {
      return CodeType.QR_CODE;
    }

    if (DM_PATTERN.test(trimmedCode) && trimmedCode.length >= 20 && trimmedCode.length <= 50) {
      return CodeType.DM_CODE;
    }

    if (EAN13_PATTERN.test(trimmedCode) || EAN8_PATTERN.test(trimmedCode) || UPCA_PATTERN.test(trimmedCode)) {
      return CodeType.BARCODE_1D;
    }

    if (CODE128_PATTERN.test(trimmedCode) && trimmedCode.length >= 4 && trimmedCode.length <= 40) {
      return CodeType.BARCODE_1D;
    }

    return CodeType.UNKNOWN;
  }

  parse(code: string): ParseResult {
    const errors: string[] = [];
    const trimmedCode = code.trim();

    if (!trimmedCode) {
      errors.push('条码为空');
      return {
        code: trimmedCode,
        codeType: CodeType.UNKNOWN,
        rawData: {},
        drugInfo: null,
        isValidFormat: false,
        parseErrors: errors
      };
    }

    const codeType = this.detectCodeType(trimmedCode);
    const rawData: Record<string, unknown> = {
      originalCode: code,
      length: trimmedCode.length
    };

    if (codeType === CodeType.UNKNOWN) {
      errors.push('无法识别的条码格式');
    }

    let drugInfo: Partial<DrugBasicInfo> | null = null;

    try {
      switch (codeType) {
        case CodeType.GS1:
          const gs1Result = parseGS1Code(trimmedCode);
          if (gs1Result) {
            rawData.gs1 = gs1Result;
            drugInfo = {
              code: trimmedCode,
              codeType: CodeType.GS1,
              approvalNumber: gs1Result.gtin
            };
            if (gs1Result.lotNumber) {
              (drugInfo as Record<string, unknown>).batchNumber = gs1Result.lotNumber;
            }
          }
          break;

        case CodeType.QR_CODE:
          try {
            const jsonData = JSON.parse(trimmedCode);
            rawData.qrData = jsonData;
            drugInfo = this.parseQRJsonData(jsonData, trimmedCode);
          } catch (_e) {
            rawData.qrText = trimmedCode;
            drugInfo = {
              code: trimmedCode,
              codeType: CodeType.QR_CODE,
              description: trimmedCode
            };
          }
          break;

        case CodeType.BARCODE_1D:
          const barcodeResult = parseBarcode(trimmedCode);
          rawData.barcode = barcodeResult;
          drugInfo = {
            code: trimmedCode,
            codeType: CodeType.BARCODE_1D,
            approvalNumber: trimmedCode
          };
          break;

        case CodeType.DM_CODE:
          drugInfo = {
            code: trimmedCode,
            codeType: CodeType.DM_CODE,
            approvalNumber: trimmedCode
          };
          rawData.dm = { code: trimmedCode };
          break;

        default:
          drugInfo = {
            code: trimmedCode,
            codeType: CodeType.UNKNOWN,
            approvalNumber: trimmedCode
          };
      }
    } catch (error) {
      errors.push(`解析失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }

    const isSuspicious = this.checkSuspiciousPattern(trimmedCode);
    if (isSuspicious) {
      errors.push('条码格式疑似异常');
      rawData.suspicious = true;
    }

    const customParser = this.customParsers.get(codeType);
    if (customParser && drugInfo) {
      try {
        const customResult = customParser(trimmedCode);
        if (customResult) {
          drugInfo = { ...drugInfo, ...customResult };
        }
      } catch (error) {
        errors.push(`自定义解析器错误: ${error instanceof Error ? error.message : '未知错误'}`);
      }
    }

    return {
      code: trimmedCode,
      codeType,
      rawData,
      drugInfo,
      isValidFormat: errors.length === 0 || codeType !== CodeType.UNKNOWN,
      parseErrors: errors
    };
  }

  parseBatch(codes: string[]): ParseResult[] {
    return codes.map(code => this.parse(code));
  }

  checkSuspiciousPattern(code: string): boolean {
    return SUSPICIOUS_PATTERNS.some(pattern => pattern.test(code));
  }

  validateCheckDigit(code: string): boolean {
    const digits = code.replace(/\D/g, '');
    if (digits.length < 8) {
      return true;
    }

    if (digits.length === 8 || digits.length === 13) {
      let sum = 0;
      for (let i = 0; i < digits.length - 1; i++) {
        const digit = parseInt(digits[i], 10);
        const multiplier = (digits.length === 13)
          ? (i % 2 === 0 ? 1 : 3)
          : (i % 2 === 0 ? 3 : 1);
        sum += digit * multiplier;
      }
      const checkDigit = parseInt(digits[digits.length - 1], 10);
      const calculated = (10 - (sum % 10)) % 10;
      return checkDigit === calculated;
    }

    if (digits.length === 12) {
      let sumOdd = 0;
      let sumEven = 0;
      for (let i = 0; i < 11; i++) {
        const digit = parseInt(digits[i], 10);
        if (i % 2 === 0) {
          sumOdd += digit;
        } else {
          sumEven += digit;
        }
      }
      const total = sumOdd * 3 + sumEven;
      const checkDigit = parseInt(digits[11], 10);
      const calculated = (10 - (total % 10)) % 10;
      return checkDigit === calculated;
    }

    return true;
  }

  registerParser(codeType: CodeType, parser: (code: string) => Partial<DrugBasicInfo> | null): void {
    this.customParsers.set(codeType, parser);
  }

  unregisterParser(codeType: CodeType): boolean {
    return this.customParsers.delete(codeType);
  }

  private parseQRJsonData(jsonData: unknown, originalCode: string): Partial<DrugBasicInfo> {
    const result: Partial<DrugBasicInfo> = {
      code: originalCode,
      codeType: CodeType.QR_CODE
    };

    if (jsonData && typeof jsonData === 'object') {
      const data = jsonData as Record<string, unknown>;

      if (typeof data.code === 'string') {
        result.approvalNumber = data.code;
      }
      if (typeof data.name === 'string') {
        result.drugName = data.name;
      }
      if (typeof data.genericName === 'string') {
        result.genericName = data.genericName;
      }
      if (typeof data.spec === 'string') {
        result.specification = data.spec;
      }
      if (typeof data.manufacturer === 'string') {
        result.manufacturer = data.manufacturer;
      }
      if (typeof data.approvalNo === 'string') {
        result.approvalNumber = data.approvalNo;
      }
    }

    return result;
  }
}

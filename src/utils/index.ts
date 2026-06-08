import { QueryVoucher, QuerySource } from '../types';

export const generateId = (): string => {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${random}`;
};

export const generateHash = (data: string, salt?: string): string => {
  const input = salt ? `${data}${salt}` : data;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
};

export const generateSignature = (payload: Record<string, unknown>, secret: string = ''): string => {
  const sorted = Object.keys(payload).sort();
  const query = sorted.map(key => `${key}=${JSON.stringify(payload[key])}`).join('&');
  return generateHash(query, secret);
};

export const calculateDaysToExpire = (expirationDateStr: string): number => {
  const expiration = new Date(expirationDateStr);
  const now = new Date();
  const diff = expiration.getTime() - now.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
};

export const isExpired = (expirationDateStr: string): boolean => {
  return calculateDaysToExpire(expirationDateStr) <= 0;
};

export const formatDate = (date: Date = new Date()): string => {
  return date.toISOString();
};

export const generateVoucher = (
  code: string,
  querySource: QuerySource,
  ttl: number = 86400000
): QueryVoucher => {
  const queryTime = new Date();
  const expireTime = new Date(queryTime.getTime() + ttl);
  const queryHash = generateHash(`${code}${queryTime.toISOString()}${querySource}`);
  const payload: Record<string, unknown> = {
    code,
    queryTime: queryTime.toISOString(),
    querySource,
    queryHash
  };

  return {
    voucherId: generateId(),
    code,
    queryTime: queryTime.toISOString(),
    querySource,
    queryHash,
    expireTime: expireTime.toISOString(),
    signature: generateSignature(payload, queryHash)
  };
};

export const validateVoucher = (voucher: QueryVoucher, secret: string = ''): boolean => {
  const payload: Record<string, unknown> = {
    code: voucher.code,
    queryTime: voucher.queryTime,
    querySource: voucher.querySource,
    queryHash: voucher.queryHash
  };
  const expectedSignature = generateSignature(payload, secret || voucher.queryHash);
  return expectedSignature === voucher.signature && new Date(voucher.expireTime) > new Date();
};

export const sleep = (ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  attempts: number = 3,
  delay: number = 1000,
  onError?: (error: Error, attempt: number) => void
): Promise<T> => {
  let lastError: Error | null = null;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (onError) {
        onError(lastError, i + 1);
      }
      if (i < attempts - 1) {
        await sleep(delay * Math.pow(2, i));
      }
    }
  }

  throw lastError || new Error('Retry failed');
};

export const isValidDate = (dateString: string): boolean => {
  const date = new Date(dateString);
  return !isNaN(date.getTime());
};

export const validateGS1Code = (code: string): boolean => {
  if (!code.startsWith('01') || code.length < 16) {
    return false;
  }
  const gtin = code.substring(2, 16);
  return /^\d{14}$/.test(gtin);
};

export const parseGS1Code = (code: string): { gtin: string; lotNumber?: string; serialNumber?: string; productionDate?: string; expirationDate?: string } | null => {
  if (!validateGS1Code(code)) {
    return null;
  }

  const result: { gtin: string; lotNumber?: string; serialNumber?: string; productionDate?: string; expirationDate?: string } = {
    gtin: code.substring(2, 16)
  };

  let index = 16;

  while (index < code.length) {
    const ai = code.substring(index, index + 2);
    index += 2;

    switch (ai) {
      case '10':
        result.lotNumber = code.substring(index, Math.min(index + 20, code.length)).split(/\x1D/)[0];
        index += Math.min(20, code.length - index);
        break;
      case '11':
        if (index + 6 <= code.length) {
          const yy = code.substring(index, index + 2);
          const mm = code.substring(index + 2, index + 4);
          const dd = code.substring(index + 4, index + 6);
          result.productionDate = `20${yy}-${mm}-${dd}T00:00:00.000Z`;
          index += 6;
        }
        break;
      case '17':
        if (index + 6 <= code.length) {
          const yy = code.substring(index, index + 2);
          const mm = code.substring(index + 2, index + 4);
          const dd = code.substring(index + 4, index + 6);
          result.expirationDate = `20${yy}-${mm}-${dd}T23:59:59.999Z`;
          index += 6;
        }
        break;
      case '21':
        result.serialNumber = code.substring(index, Math.min(index + 20, code.length)).split(/\x1D/)[0];
        index += Math.min(20, code.length - index);
        break;
      default:
        index += 2;
    }

    if (index < code.length && code[index] === '\x1D') {
      index++;
    }
  }

  return result;
};

export const parseBarcode = (code: string): Record<string, string> => {
  const result: Record<string, string> = {
    rawCode: code
  };

  if (/^\d{13}$/.test(code)) {
    result.type = 'EAN-13';
    result.countryCode = code.substring(0, 3);
    result.manufacturerCode = code.substring(3, 8);
    result.productCode = code.substring(8, 12);
    result.checkDigit = code.substring(12, 13);
  } else if (/^\d{12}$/.test(code)) {
    result.type = 'UPC-A';
    result.numberSystem = code.substring(0, 1);
    result.manufacturerCode = code.substring(1, 6);
    result.productCode = code.substring(6, 11);
    result.checkDigit = code.substring(11, 12);
  } else if (/^\d{8}$/.test(code)) {
    result.type = 'EAN-8';
    result.countryCode = code.substring(0, 3);
    result.productCode = code.substring(3, 7);
    result.checkDigit = code.substring(7, 8);
  }

  return result;
};

export const getStorageAdapter = (): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
} => {
  const memoryStore = new Map<string, string>();

  try {
    if (typeof localStorage !== 'undefined') {
      return {
        getItem: (key: string) => localStorage.getItem(key),
        setItem: (key: string, value: string) => localStorage.setItem(key, value),
        removeItem: (key: string) => localStorage.removeItem(key),
        clear: () => localStorage.clear()
      };
    }
  } catch (_e) {
    // ignore
  }

  return {
    getItem: (key: string) => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string) => memoryStore.set(key, value),
    removeItem: (key: string) => memoryStore.delete(key),
    clear: () => memoryStore.clear()
  };
};

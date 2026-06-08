import {
  DrugTraceSDK,
  QuerySource,
  EventType,
  VerificationStatus,
  CodeType,
  FlowNodeType,
  RecallLevel,
  RecallStatus,
  InspectionStatus
} from '../src';

(async () => {
  console.log('=== 药品追溯查询 SDK 使用示例 ===\n');

  const sdk = new DrugTraceSDK({
    querySource: QuerySource.HOSPITAL_KIOSK,
    sourceIdentifier: 'HOSPITAL-A-001',
    enableCache: true,
    cacheTTL: 1800000,
    cacheMaxSize: 200,
    autoCleanExpiredCache: true,
    cleanInterval: 300000,
    customMessages: {
      verified: '✅ 药品信息验证通过，请放心使用',
      suspectedFake: '⚠️ 疑似假码，请立即报告',
      duplicate: '📋 该条码已被多次查询'
    }
  });

  console.log('1. SDK 初始化状态:', sdk.isInitialized ? '已初始化' : '未初始化');

  sdk.on(EventType.QUERY_SUCCESS, (data) => {
    console.log(`[事件] 查询成功: ${data.code} at ${data.timestamp}`);
  });

  sdk.on(EventType.FAKE_CODE_DETECTED, (data) => {
    console.log(`[事件] 检测到假码: ${data.code}`, data.data);
  });

  sdk.on(EventType.DUPLICATE_QUERY, (data) => {
    console.log(`[事件] 重复查询: ${data.code}`, data.data);
  });

  sdk.on(EventType.RECALL_DETECTED, (data) => {
    console.log(`[事件] 检测到召回: ${data.code}`, data.data);
  });

  sdk.on(EventType.CACHE_HIT, (data) => {
    console.log(`[事件] 缓存命中: ${data.code}`);
  });

  console.log('\n2. 扫码解析示例:');
  const parseResult1 = sdk.scanAndParse('6922201000001');
  console.log('  - 一维条码 EAN-13:', parseResult1.codeType);
  console.log('    格式有效:', parseResult1.isValidFormat);

  const parseResult2 = sdk.scanAndParse('010692220100000110B202401011726011421SN123456');
  console.log('  - GS1 码:', parseResult2.codeType);
  console.log('    解析数据:', JSON.stringify(parseResult2.rawData.gs1 || {}));

  const parseResult3 = sdk.scanAndParse('{"name":"阿莫西林胶囊","spec":"0.5g*24粒"}');
  console.log('  - QR 码(JSON):', parseResult3.codeType);
  console.log('    药品名:', parseResult3.drugInfo?.drugName);

  const parseResult4 = sdk.scanAndParse('0000000000000');
  console.log('  - 异常条码检测:');
  console.log('    疑似异常:', parseResult4.parseErrors.length > 0 ? '是' : '否');
  console.log('    错误信息:', parseResult4.parseErrors);

  console.log('\n3. 完整追溯查询示例:');
  const result = await sdk.query('1234567890123');
  console.log('  - 查询成功:', result.success);
  console.log('  - 条码类型:', result.codeType);
  console.log('  - 药品名称:', result.drugInfo?.drugName);
  console.log('  - 批准文号:', result.drugInfo?.approvalNumber);
  console.log('  - 验证状态:', result.verificationStatus);
  console.log('  - 自定义文案:', result.customMessage);

  if (result.batchInfo) {
    console.log('  - 批次信息:');
    console.log('    批号:', result.batchInfo.batchNumber);
    console.log('    生产日期:', result.batchInfo.productionDate);
    console.log('    有效期至:', result.batchInfo.expirationDate);
    console.log('    剩余天数:', result.batchInfo.daysToExpire);
    console.log('    是否过期:', result.batchInfo.isExpired ? '是' : '否');
    console.log('    检验状态:', result.batchInfo.inspectionStatus);
  }

  console.log('  - 流向节点数:', result.flowNodes.length);
  result.flowNodes.forEach((node, idx) => {
    console.log(`    ${idx + 1}. [${node.nodeType}] ${node.nodeName} @ ${node.operationTime}`);
  });

  console.log('  - 召回公告数:', result.recallNotices.length);
  if (result.hasRecall) {
    result.recallNotices.forEach(notice => {
      console.log('    -', notice.recallTitle);
      console.log('      召回级别:', sdk.recallModule.formatRecallLevel(notice.recallLevel));
    });
  }

  console.log('  - 查询次数:', result.queryCount);
  console.log('  - 是否重复查询:', result.isDuplicate ? '是' : '否');
  console.log('  - 查询凭证ID:', result.queryVoucher?.voucherId);
  console.log('  - 来自缓存:', result.fromCache ? '是' : '否');

  console.log('\n4. 重复查询检测:');
  const result2 = await sdk.query('1234567890123', { skipCache: true });
  console.log('  - 第二次查询是否重复:', result2.isDuplicate ? '是' : '否');
  console.log('  - 查询次数:', result2.queryCount);

  console.log('\n5. 缓存命中测试:');
  const result3 = await sdk.query('1234567890123');
  console.log('  - 第三次查询来自缓存:', result3.fromCache ? '是' : '否');

  console.log('\n6. 查询凭证生成与验证:');
  const voucher = sdk.generateVoucher('TEST-001', QuerySource.E_COMMERCE);
  console.log('  - 生成凭证ID:', voucher.voucherId);
  console.log('  - 凭证过期时间:', voucher.expireTime);

  const validation = sdk.validateVoucher(voucher);
  console.log('  - 凭证验证:', validation.valid ? '有效' : '无效');

  const validation2 = sdk.validateVoucher(voucher.voucherId);
  console.log('  - 按ID验证:', validation2.valid ? '有效' : '无效');

  console.log('\n7. 缓存管理:');
  const stats = sdk.cacheModule.getStats();
  console.log('  - 缓存条目:', stats.totalEntries);
  console.log('  - 过期条目:', stats.expiredEntries);
  console.log('  - 命中次数:', stats.hitCount);
  console.log('  - 未命中次数:', stats.missCount);

  console.log('\n8. 注册自定义数据:');
  const batchRegistered = sdk.registerBatchData('NEW-DRUG-001', [
    {
      batchNumber: 'NB-2024-001',
      productionDate: '2024-06-01T00:00:00.000Z',
      expirationDate: '2027-05-31T23:59:59.999Z',
      inspectionStatus: InspectionStatus.PASSED,
      productionQuantity: 10000
    }
  ]);
  console.log('  - 批次数据注册:', batchRegistered ? '成功' : '失败');

  console.log('\n9. 异常码检测:');
  const fakeResult = await sdk.query('0000000000000');
  console.log('  - 全零码验证状态:', fakeResult.verificationStatus);
  console.log('  - 验证提示:', fakeResult.customMessage);
  console.log('  - 错误信息:', fakeResult.errorMessage);

  console.log('\n10. 自定义文案:');
  sdk.setCustomMessage('verified', '验证完成！药品信息真实可靠');
  sdk.setCustomMessages({
    expired: '⚠️ 该药品已过期，禁止销售和使用',
    networkError: '❌ 网络连接失败，请检查后重试'
  });
  console.log('  - 自定义文案已更新');

  const customResult = await sdk.query('1234567890123', { skipCache: true });
  console.log('  - 新文案:', customResult.customMessage);

  console.log('\n11. 各子模块直接访问:');
  console.log('  - 扫码模块检测码类型:', sdk.scannerModule.detectCodeType('6922201000001'));
  console.log('  - 验证模块黑名单数量:', sdk.verificationModule.getBlacklist().length);
  console.log('  - 批次模块注册批准文号数:', sdk.batchModule.getApprovalNumbers().length);
  console.log('  - 流向模块注册码数:', sdk.flowModule.getRegisteredCodes().length);
  console.log('  - 召回模块活动召回数:', sdk.recallModule.getActiveRecalls().length);
  console.log('  - 事件模块监听器数量:', sdk.eventModule.getListenerCount());

  sdk.destroy();
  console.log('\n=== 示例执行完毕 ===');
})().catch(console.error);

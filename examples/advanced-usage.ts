import {
  DrugTraceSDK,
  QuerySource,
  EventType,
  DataSourceType,
  DataSourceCategory,
  VerificationStatus,
  RecallLevel,
  RecallStatus,
  InspectionStatus,
  FlowNodeType,
  CodeType
} from '../src';

(async () => {
  console.log('=== 药品追溯查询 SDK 高级功能演示 ===\n');

  const sdk = new DrugTraceSDK({
    querySource: QuerySource.HOSPITAL_KIOSK,
    sourceIdentifier: 'HOSPITAL-BJ-001',
    enableCache: true,
    cacheTTL: 1800000,
    cacheMaxSize: 200,
    enableAuditLog: true,
    auditLogPersistence: false,
    recallStrictMatch: true,
    dataSource: {
      drug: DataSourceType.LOCAL,
      batch: DataSourceType.LOCAL,
      flow: DataSourceType.LOCAL,
      recall: DataSourceType.LOCAL,
      fallbackToLocal: true
    },
    customMessages: {
      verified: '✅ 药品信息验证通过，请放心使用',
      suspectedFake: '⚠️ 疑似假码，请立即报告主管',
      duplicate: '📋 该条码已被多次查询，请注意药品来源',
      networkError: '🌐 网络异常，请稍后重试'
    }
  });

  console.log('1. 【数据源】可插拔数据源架构');
  console.log('   当前配置:', JSON.stringify(sdk.dataSource.getConfig(), null, 2));
  console.log('   支持切换: LOCAL(本地) / HTTP(接口) / CUSTOM(自定义异步)');

  // 演示切换数据源
  sdk.configureDataSource({
    drug: DataSourceType.LOCAL,
    batch: DataSourceType.LOCAL,
    // 也可以配置 HTTP 接口：
    // httpConfig: {
    //   baseUrl: 'https://api.example.com',
    //   apiKey: 'your-api-key',
    //   endpoints: {
    //     drug: '/api/v1/drug',
    //     batch: '/api/v1/batch',
    //     flow: '/api/v1/flow',
    //     recall: '/api/v1/recall'
    //   }
    // },
    // 也可以配置自定义处理器：
    // customHandlers: {
    //   drug: async (code, approval) => { /* ... */ return null; }
    // }
    fallbackToLocal: true
  });
  console.log('   数据源可切换，失败时自动回退本地，离线可用最近缓存');
  console.log();

  console.log('2. 【审计日志】查询记录与筛选导出');
  sdk.on(EventType.AUDIT_LOGGED, (data) => {
    const audit = data.data as { recordId: string };
    console.log(`   [审计] 记录保存: ID=${audit?.recordId || 'N/A'}`);
  });

  const r1 = await sdk.query('1234567890123');
  const r2 = await sdk.query('1234567890123', { querySource: QuerySource.E_COMMERCE });
  const r3 = await sdk.query('0000000000000', { querySource: QuerySource.CUSTOMER_SERVICE });

  const stats = sdk.getAuditStatistics();
  console.log('   审计统计:');
  console.log('     - 总记录数:', stats.total);
  console.log('     - 按来源:', JSON.stringify(stats.bySource));
  console.log('     - 疑似假码数:', stats.suspectedFakeCount);
  console.log('     - 涉召回数:', stats.recallCount);
  console.log('     - 缓存命中数:', stats.cacheHitCount);
  console.log('     - 唯一码数:', stats.uniqueCodes);

  const fakeLogs = sdk.queryAudit({ isSuspectedFake: true });
  console.log('   筛选假码记录数:', fakeLogs.length);

  const csvExport = sdk.exportAudit({}, 'csv');
  console.log('   CSV 导出行数:', csvExport.split('\n').length - 1, '行');
  console.log();

  console.log('3. 【缓存命中】查询次数递增和重复查询检测');
  console.log('   第1次查询: count=1, isDuplicate=false, fromCache=false');
  console.log('     count=%d, isDuplicate=%s, fromCache=%s', 1, false, false);

  console.log('   第2次查询(不同来源): count=%d, isDuplicate=%s, fromCache=%s',
    r2.queryCount, r2.isDuplicate, r2.fromCache);

  const r4 = await sdk.query('1234567890123');
  console.log('   第3次查询(缓存命中): count=%d, isDuplicate=%s, fromCache=%s',
    r4.queryCount, r4.isDuplicate, r4.fromCache);

  const historyAfter = sdk.verificationModule.getQueryHistory('1234567890123');
  console.log('   历史记录数:', historyAfter.length);
  console.log('   来源列表:', historyAfter.map(h => `${h.querySource}@${h.queryTime.substring(11, 19)}`).join(', '));
  console.log('   说明: 每次查询都会累加次数，记录来源，即使读缓存也不漏记录！');
  console.log();

  console.log('4. 【召回匹配】严格按批号/批准文号匹配');
  const recallMapping = sdk.recallModule.getMappingsFor('国药准字H13021234', '1234567890123');
  console.log('   批准文号映射的关联批次:', recallMapping.relatedBatches.join(', '));
  console.log('   关联召回ID:', recallMapping.relatedRecallIds.join(', '));

  const matchedRecall = await sdk.query('1234567890123', { batchNumber: 'B20231001' });
  console.log('   指定召回批次查询:');
  console.log('     - hasRecall:', matchedRecall.hasRecall);
  console.log('     - 召回公告数:', matchedRecall.recallNotices.length);
  if (matchedRecall.recallNotices.length > 0) {
    matchedRecall.recallNotices.forEach(n => {
      console.log('       * ', n.recallTitle);
      console.log('         等级:', sdk.recallModule.formatRecallLevel(n.recallLevel));
      console.log('         影响批次:', n.affectedBatches.join(', '));
    });
  }

  const noMatch = await sdk.query('6922201000001', { batchNumber: 'UNMATCHED-BATCH' });
  console.log('   不匹配的药品(严格模式):');
  console.log('     - hasRecall:', noMatch.hasRecall, '(严格匹配下无关联则为false)');
  console.log();

  console.log('5. 【查询凭证】凭证摘要与反查详情');
  if (r1.queryVoucher) {
    const voucherId = r1.queryVoucher.voucherId;
    console.log('   首次查询凭证ID:', voucherId);

    // 凭证反查详情
    const lookup = sdk.getQueryResultByVoucher(voucherId);
    console.log('   按凭证ID反查:');
    console.log('     - 药品名:', lookup?.drugInfo?.drugName);
    console.log('     - 批号:', lookup?.batchInfo?.batchNumber);
    console.log('     - 状态:', lookup?.verificationStatus);
    console.log('     - 来源:', lookup?.querySource);

    // 生成凭证摘要
    const { summary, error } = sdk.generateVoucherSummary(voucherId);
    if (summary) {
      console.log('   凭证摘要展示:');
      console.log('═══════════════════════════════════');
      console.log(summary.displayText);
      console.log('═══════════════════════════════════');
      console.log('   摘要结构化字段:');
      console.log('     - drugName:', summary.drugName);
      console.log('     - batchNumber:', summary.batchNumber);
      console.log('     - querySourceName:', summary.querySourceName);
      console.log('     - verificationStatusName:', summary.verificationStatusName);
      console.log('     - integrityVerified:', summary.integrityVerified);
      console.log('     - integrityHash:', summary.integrityHash);
      if (summary.daysToExpire !== undefined) {
        console.log('     - daysToExpire:', summary.daysToExpire, summary.isExpired ? '(已过期⚠️)' : '');
      }
    } else {
      console.log('   摘要生成失败:', error);
    }

    // 凭证有效性校验
    const validation = sdk.validateVoucher(voucherId);
    console.log('   凭证校验:', validation.valid ? '✅有效' : '❌无效', validation.error || '');
  }
  console.log();

  console.log('6. 【综合场景】电商页面 + 客服系统联调');
  sdk.setCustomMessages({
    recallDetected: '🚨 紧急：该药品涉及安全召回，禁止销售！'
  });

  const eCommerceSdk = new DrugTraceSDK({
    querySource: QuerySource.E_COMMERCE,
    sourceIdentifier: 'MALL-TB-007',
    enableAuditLog: true,
    recallStrictMatch: true
  });

  const customerSdk = new DrugTraceSDK({
    querySource: QuerySource.CUSTOMER_SERVICE,
    sourceIdentifier: 'CS-TEAM-LEADER',
    enableAuditLog: true,
    recallStrictMatch: true
  });

  // 电商场景 - 用户扫码
  const ecomResult = await eCommerceSdk.query('1234567890123');
  console.log('   [电商] 用户扫码结果:');
  console.log('     - 展示文案:', ecomResult.customMessage);
  console.log('     - 凭证ID:', ecomResult.queryVoucher?.voucherId);
  console.log('     - 数据源摘要:', JSON.stringify(ecomResult.dataSourceSummary));

  // 客服场景 - 凭证反查
  const csLookup = customerSdk.getQueryResultByVoucher(
    ecomResult.queryVoucher?.voucherId || ''
  );
  console.log('   [客服] 核验用户提交凭证:');
  console.log('     - 查到记录:', csLookup ? '是' : '否');
  console.log('     - 状态一致:', csLookup?.verificationStatus === ecomResult.verificationStatus);
  console.log('     - 生成客服凭证摘要:', customerSdk.generateVoucherSummary(
    ecomResult.queryVoucher?.voucherId || ''
  ).summary?.displayText.substring(0, 30) + '...');

  // 多来源审计对账
  setTimeout(async () => {
    const allAudit = sdk.queryAudit();
    const ecomAudit = eCommerceSdk.queryAudit();
    const csAudit = customerSdk.queryAudit();
    console.log();
    console.log('7. 【审计对账】三端数据汇总');
    console.log('   医院自助机记录数:', allAudit.length);
    console.log('   电商售药页记录数:', ecomAudit.length);
    console.log('   客服系统记录数:', csAudit.length);
    console.log('   导出用于对账的JSON总记录:',
      sdk.exportAudit({ resultStatuses: [VerificationStatus.VERIFIED] }).length, '字符');

    // 演示数据注册
    console.log();
    console.log('8. 【数据注入】业务系统可动态维护本地数据');
    const batchOk = sdk.registerBatchData('国药准字H13021234', [
      {
        batchNumber: 'B20240601',
        productionDate: '2024-06-01T00:00:00.000Z',
        expirationDate: '2027-05-31T23:59:59.999Z',
        inspectionStatus: InspectionStatus.PASSED,
        inspector: '李质量',
        inspectionReportNumber: 'INS-2024-0601',
        productionQuantity: 80000
      }
    ]);
    console.log('   新批次注册:', batchOk ? '✅成功' : '❌失败');
    const customRecall = sdk.registerRecallNotice({
      recallId: 'REC-LOCAL-002',
      recallLevel: RecallLevel.LEVEL_3,
      recallStatus: RecallStatus.ACTIVE,
      recallTitle: '本地新增召回：某批次包装标签印刷错误',
      recallReason: '外包箱印刷有误，但药品本身质量合格',
      recallScope: '北京地区',
      initiator: '企业自主召回',
      publishDate: new Date().toISOString(),
      affectedBatches: ['B20240601'],
      measures: ['联系经销商更换外包箱']
    });
    sdk.recallModule.addExplicitMapping({
      approvalNumbers: ['国药准字H13021234'],
      recallIds: ['REC-LOCAL-002']
    });
    console.log('   新增召回公告:', customRecall ? '✅成功' : '❌失败');

    const newQuery = await sdk.query('1234567890123', { batchNumber: 'B20240601' });
    console.log('   新批次查询命中召回:', newQuery.hasRecall ? '是(匹配上了!)' : '否');
    console.log('   关联召回:', newQuery.recallNotices.map(n => n.recallTitle).join('; '));

    sdk.destroy();
    eCommerceSdk.destroy();
    customerSdk.destroy();

    console.log();
    console.log('=== 高级功能演示完成 ===');
  }, 100);
})().catch(err => {
  console.error('演示执行出错:', err);
});

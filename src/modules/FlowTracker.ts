import { FlowNode, FlowNodeType } from '../types';

export interface FlowQueryResult {
  nodes: FlowNode[];
  found: boolean;
  hasCompleteChain: boolean;
  errorMessage?: string;
}

export interface FlowRegistry {
  [code: string]: FlowNode[];
}

const DEFAULT_FLOW_NODES: FlowRegistry = {
  '1234567890123': [
    {
      nodeId: 'NODE-001',
      nodeType: FlowNodeType.MANUFACTURER,
      nodeName: '华北制药集团有限责任公司',
      nodeLicense: '京HZ20200001',
      operator: '李生产',
      operationTime: '2024-01-15T08:00:00.000Z',
      operationType: '生产出库',
      fromLocation: '北京市大兴区生产基地A区',
      toLocation: '北京市朝阳区仓储中心',
      quantity: 50000,
      batchNumber: 'B20240101',
      contactPhone: '010-12345678',
      contactAddress: '北京市大兴区生物医药产业基地'
    },
    {
      nodeId: 'NODE-002',
      nodeType: FlowNodeType.WHOLESALER,
      nodeName: '国药控股北京有限公司',
      nodeLicense: '京HP20210001',
      operator: '王批发',
      operationTime: '2024-01-16T10:30:00.000Z',
      operationType: '批发入库',
      fromLocation: '北京市朝阳区仓储中心',
      toLocation: '北京市丰台区国药仓库',
      quantity: 50000,
      batchNumber: 'B20240101',
      contactPhone: '010-23456789',
      contactAddress: '北京市丰台区南四环西路'
    },
    {
      nodeId: 'NODE-003',
      nodeType: FlowNodeType.DISTRIBUTOR,
      nodeName: '北京医药配送有限公司',
      nodeLicense: '京HP20220002',
      operator: '张配送',
      operationTime: '2024-01-18T09:15:00.000Z',
      operationType: '配送出库',
      fromLocation: '北京市丰台区国药仓库',
      toLocation: '北京市海淀区海淀医院',
      quantity: 10000,
      batchNumber: 'B20240101',
      contactPhone: '010-34567890',
      contactAddress: '北京市海淀区中关村大街'
    },
    {
      nodeId: 'NODE-004',
      nodeType: FlowNodeType.HOSPITAL,
      nodeName: '北京市海淀医院',
      nodeLicense: '京医20230001',
      operator: '赵药房',
      operationTime: '2024-01-18T14:00:00.000Z',
      operationType: '药房入库',
      fromLocation: '北京市海淀区中关村大街',
      toLocation: '北京市海淀医院门诊药房',
      quantity: 10000,
      batchNumber: 'B20240101',
      contactPhone: '010-82619999',
      contactAddress: '北京市海淀区中关村大街29号'
    }
  ]
};

export class FlowTrackerModule {
  private flowRegistry: FlowRegistry;

  constructor(initialRegistry?: FlowRegistry) {
    this.flowRegistry = { ...DEFAULT_FLOW_NODES, ...(initialRegistry || {}) };
  }

  queryFlow(code: string, batchNumber?: string): FlowQueryResult {
    try {
      const key = code.trim();
      let nodes = this.flowRegistry[key];

      if (!nodes || nodes.length === 0) {
        return {
          nodes: [],
          found: false,
          hasCompleteChain: false,
          errorMessage: '未找到该药品的流向信息'
        };
      }

      if (batchNumber) {
        nodes = nodes.filter(n => n.batchNumber === batchNumber.trim());
        if (nodes.length === 0) {
          return {
            nodes: [],
            found: false,
            hasCompleteChain: false,
            errorMessage: `未找到批次号为 ${batchNumber} 的流向信息`
          };
        }
      }

      const sortedNodes = this.sortNodesByTime(nodes);
      const hasCompleteChain = this.checkCompleteChain(sortedNodes);

      return {
        nodes: sortedNodes,
        found: true,
        hasCompleteChain
      };
    } catch (error) {
      return {
        nodes: [],
        found: false,
        hasCompleteChain: false,
        errorMessage: `流向查询失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  queryNodesByType(code: string, nodeType: FlowNodeType): FlowQueryResult {
    const result = this.queryFlow(code);
    if (!result.found) {
      return result;
    }

    const filtered = result.nodes.filter(n => n.nodeType === nodeType);
    return {
      nodes: filtered,
      found: filtered.length > 0,
      hasCompleteChain: false,
      errorMessage: filtered.length === 0 ? `未找到类型为 ${nodeType} 的流转节点` : undefined
    };
  }

  getFirstNode(code: string): FlowNode | null {
    const result = this.queryFlow(code);
    if (!result.found || result.nodes.length === 0) {
      return null;
    }
    return result.nodes[0];
  }

  getLastNode(code: string): FlowNode | null {
    const result = this.queryFlow(code);
    if (!result.found || result.nodes.length === 0) {
      return null;
    }
    return result.nodes[result.nodes.length - 1];
  }

  getCurrentLocation(code: string): {
    location: string;
    nodeType: FlowNodeType;
    nodeName: string;
    timestamp: string;
  } | null {
    const lastNode = this.getLastNode(code);
    if (!lastNode) {
      return null;
    }

    return {
      location: lastNode.toLocation || lastNode.contactAddress || '未知',
      nodeType: lastNode.nodeType,
      nodeName: lastNode.nodeName,
      timestamp: lastNode.operationTime
    };
  }

  addFlowNode(code: string, node: FlowNode): boolean {
    try {
      const key = code.trim();
      if (!this.flowRegistry[key]) {
        this.flowRegistry[key] = [];
      }
      this.flowRegistry[key].push(node);
      return true;
    } catch {
      return false;
    }
  }

  addFlowNodes(code: string, nodes: FlowNode[]): boolean {
    try {
      for (const node of nodes) {
        this.addFlowNode(code, node);
      }
      return true;
    } catch {
      return false;
    }
  }

  removeFlowNode(code: string, nodeId: string): boolean {
    try {
      const key = code.trim();
      const nodes = this.flowRegistry[key];
      if (!nodes) return false;

      const index = nodes.findIndex(n => n.nodeId === nodeId);
      if (index < 0) return false;

      nodes.splice(index, 1);

      if (nodes.length === 0) {
        delete this.flowRegistry[key];
      }

      return true;
    } catch {
      return false;
    }
  }

  clearFlow(code?: string): void {
    if (code) {
      delete this.flowRegistry[code.trim()];
    } else {
      this.flowRegistry = { ...DEFAULT_FLOW_NODES };
    }
  }

  getRegisteredCodes(): string[] {
    return Object.keys(this.flowRegistry);
  }

  getRegistrySnapshot(): FlowRegistry {
    return JSON.parse(JSON.stringify(this.flowRegistry));
  }

  private sortNodesByTime(nodes: FlowNode[]): FlowNode[] {
    return [...nodes].sort((a, b) => {
      return new Date(a.operationTime).getTime() - new Date(b.operationTime).getTime();
    });
  }

  private checkCompleteChain(nodes: FlowNode[]): boolean {
    if (nodes.length < 2) return false;

    const firstType = nodes[0].nodeType;
    const lastType = nodes[nodes.length - 1].nodeType;

    const startsWithManufacturer = firstType === FlowNodeType.MANUFACTURER;
    const endsWithConsumerOrPharmacy =
      lastType === FlowNodeType.CONSUMER ||
      lastType === FlowNodeType.PHARMACY ||
      lastType === FlowNodeType.HOSPITAL ||
      lastType === FlowNodeType.RETAILER;

    return startsWithManufacturer && endsWithConsumerOrPharmacy;
  }
}

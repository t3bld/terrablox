export type ModuleScenarioValue =
  | string
  | number
  | boolean
  | null
  | ModuleScenarioValue[]
  | { [key: string]: ModuleScenarioValue };

export interface GenericModuleCostScenario {
  moduleCount: number;
  inputs: Record<string, ModuleScenarioValue>;
}

export interface Ec2ModuleCostScenario {
  instanceCount: number;
  instanceType: string;
  monitoring: boolean;
  createEip: boolean;
  tenancy: "default" | "dedicated";
  rootVolume: {
    enabled: boolean;
    type: "gp2" | "gp3" | "io1" | "io2";
    size: number;
    iops: number;
    throughput: number;
  };
}

export interface ModuleCostBreakdownItem {
  name: string;
  monthlyCost: number;
}

export interface ModuleInfracostEstimate {
  region: "eu-west-1";
  currency: "EUR";
  totalMonthlyCost: number;
  totalAnnualCost: number;
  resourceCount: number;
  costedResources: number;
  freeResources: number;
  byService: ModuleCostBreakdownItem[];
  byComponent: ModuleCostBreakdownItem[];
  diagnostics: Array<{
    severity: string;
    message: string;
  }>;
  estimatedAt: string;
  estimatorVersion: string;
  partial: boolean;
}

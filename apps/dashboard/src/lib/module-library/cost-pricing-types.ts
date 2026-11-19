export type ModuleCostModelKind =
  | "application-load-balancer"
  | "classic-load-balancer"
  | "eks-cluster"
  | "kms-key"
  | "route53-zone"
  | "secrets-manager";

export interface ModuleCostControl {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  /** Workload growth changes this value each month; provisioned quantities stay fixed. */
  growsWithWorkload: boolean;
}

export interface ModuleCostModel {
  id: string;
  kind: ModuleCostModelKind;
  service: string;
  resourceTypes: string[];
  controls: ModuleCostControl[];
  /** EUR rates keyed by the calculation implemented for `kind`. */
  rates: Record<string, number>;
  assumptions: string[];
}

export type ModuleCostDriverControl =
  | {
      kind: "number";
      id: string;
      label: string;
      unit: string;
      min: number;
      max: number;
      step: number;
      defaultValue: number | null;
      growsWithWorkload: boolean;
      sourceVariable: string | null;
    }
  | {
      kind: "boolean";
      id: string;
      label: string;
      defaultValue: boolean | null;
      sourceVariable: string;
    }
  | {
      kind: "select";
      id: string;
      label: string;
      defaultValue: string | null;
      options: Array<{ value: string; label: string }>;
      sourceVariable: string;
    }
  | {
      kind: "text";
      id: string;
      label: string;
      defaultValue: string | null;
      sourceVariable: string;
    };

export interface ModuleCostDriverModel {
  id: string;
  resourceType: string;
  costClass: "recurring" | "usage" | "free" | "unclassified";
  driver: string;
  controls: ModuleCostDriverControl[];
  reason: string;
}

export interface ModuleCostPricingResponse {
  region: string;
  currency: "EUR";
  hoursPerMonth: number;
  pricedAt: string;
  models: ModuleCostModel[];
  driverModels: ModuleCostDriverModel[];
  unpricedResourceTypes: string[];
  warnings: string[];
  source: {
    aws: "AWS Price List Bulk API";
    awsPublicationDates: string[];
    fx: "European Central Bank";
    fxDate: string | null;
    usdPerEur: number | null;
  };
}

/**
 * The AWS regions a project can be pointed at.
 *
 * A list rather than a free-text field, because a region is not something anyone
 * should be able to typo: `eu-central-l` passes the format check, reaches
 * CloudFormation, and fails there with an endpoint error that says nothing about
 * the letter that is wrong.
 *
 * Commercial partition only. GovCloud and China would need different policy ARNs
 * (`arn:aws-us-gov:…`, `arn:aws-cn:…`) than the deploy templates hard-code, so
 * offering them here would offer a setup that cannot finish.
 *
 * Regions launch a few times a year, so this list is treated as a convenience
 * rather than as the authority: {@link isKnownRegion} is only used to decide what
 * to show, and the picker still accepts anything correctly shaped. No client
 * needs updating for a new region.
 */
export interface AwsRegion {
  code: string;
  /** The name AWS uses in the console, so the two can be matched up. */
  name: string;
  /** Groups the picker, and matches the search: "europe" finds all of them. */
  area: "Americas" | "Europe" | "Asia Pacific" | "Middle East" | "Africa";
}

export const AWS_REGIONS: AwsRegion[] = [
  { code: "us-east-1", name: "US East (N. Virginia)", area: "Americas" },
  { code: "us-east-2", name: "US East (Ohio)", area: "Americas" },
  { code: "us-west-1", name: "US West (N. California)", area: "Americas" },
  { code: "us-west-2", name: "US West (Oregon)", area: "Americas" },

  { code: "ca-central-1", name: "Canada (Central)", area: "Americas" },
  { code: "ca-west-1", name: "Canada West (Calgary)", area: "Americas" },

  { code: "eu-central-1", name: "Europe (Frankfurt)", area: "Europe" },
  { code: "eu-central-2", name: "Europe (Zurich)", area: "Europe" },
  { code: "eu-west-1", name: "Europe (Ireland)", area: "Europe" },
  { code: "eu-west-2", name: "Europe (London)", area: "Europe" },
  { code: "eu-west-3", name: "Europe (Paris)", area: "Europe" },
  { code: "eu-north-1", name: "Europe (Stockholm)", area: "Europe" },
  { code: "eu-south-1", name: "Europe (Milan)", area: "Europe" },
  { code: "eu-south-2", name: "Europe (Spain)", area: "Europe" },

  { code: "ap-east-1", name: "Asia Pacific (Hong Kong)", area: "Asia Pacific" },
  { code: "ap-east-2", name: "Asia Pacific (Taipei)", area: "Asia Pacific" },
  { code: "ap-south-1", name: "Asia Pacific (Mumbai)", area: "Asia Pacific" },
  {
    code: "ap-south-2",
    name: "Asia Pacific (Hyderabad)",
    area: "Asia Pacific",
  },
  {
    code: "ap-northeast-1",
    name: "Asia Pacific (Tokyo)",
    area: "Asia Pacific",
  },
  {
    code: "ap-northeast-2",
    name: "Asia Pacific (Seoul)",
    area: "Asia Pacific",
  },
  {
    code: "ap-northeast-3",
    name: "Asia Pacific (Osaka)",
    area: "Asia Pacific",
  },
  {
    code: "ap-southeast-1",
    name: "Asia Pacific (Singapore)",
    area: "Asia Pacific",
  },
  {
    code: "ap-southeast-2",
    name: "Asia Pacific (Sydney)",
    area: "Asia Pacific",
  },
  {
    code: "ap-southeast-3",
    name: "Asia Pacific (Jakarta)",
    area: "Asia Pacific",
  },
  {
    code: "ap-southeast-4",
    name: "Asia Pacific (Melbourne)",
    area: "Asia Pacific",
  },
  {
    code: "ap-southeast-5",
    name: "Asia Pacific (Malaysia)",
    area: "Asia Pacific",
  },
  {
    code: "ap-southeast-7",
    name: "Asia Pacific (Thailand)",
    area: "Asia Pacific",
  },

  { code: "me-central-1", name: "Middle East (UAE)", area: "Middle East" },
  { code: "me-south-1", name: "Middle East (Bahrain)", area: "Middle East" },
  { code: "il-central-1", name: "Israel (Tel Aviv)", area: "Middle East" },

  { code: "af-south-1", name: "Africa (Cape Town)", area: "Africa" },

  { code: "sa-east-1", name: "South America (São Paulo)", area: "Americas" },
  { code: "mx-central-1", name: "Mexico (Central)", area: "Americas" },
];

/** The order the picker groups the list in. */
export const AWS_REGION_AREAS: AwsRegion["area"][] = [
  "Europe",
  "Americas",
  "Asia Pacific",
  "Middle East",
  "Africa",
];

export function findAwsRegion(code: string): AwsRegion | undefined {
  const needle = code.trim().toLowerCase();
  return AWS_REGIONS.find((region) => region.code === needle);
}

export function isKnownRegion(code: string): boolean {
  return findAwsRegion(code) !== undefined;
}

/** `Europe (Frankfurt) · eu-central-1`, or just the code for a newer region. */
export function describeRegion(code: string): string {
  const region = findAwsRegion(code);
  return region ? `${region.name} · ${region.code}` : code;
}

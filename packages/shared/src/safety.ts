const RISKY_PATTERNS: { pattern: RegExp; description: string }[] = [
  { pattern: /git\s+push/, description: "Git push operation" },
  { pattern: /git\s+push\s+--force/, description: "Force push (destructive)" },
  { pattern: /rm\s+-rf?\s+/, description: "Recursive file deletion" },
  { pattern: /npm\s+publish/, description: "Package publishing" },
  { pattern: /yarn\s+publish/, description: "Package publishing" },
  { pattern: /npm\s+install\s+(?!--save-dev)/, description: "Dependency installation" },
  { pattern: /DROP\s+TABLE/i, description: "Database table drop" },
  { pattern: /DELETE\s+FROM/i, description: "Database deletion" },
  { pattern: /curl\s+.*\|\s*sh/, description: "Remote script execution" },
  { pattern: /chmod\s+777/, description: "Overly permissive file permissions" },
  { pattern: /aws\s+s3\s+rm/, description: "S3 object deletion" },
  { pattern: /terraform\s+destroy/, description: "Infrastructure destruction" },
  { pattern: /cdk\s+destroy/, description: "CDK stack destruction" },
];

const RISKY_FILE_PATTERNS = [
  /\.env$/,
  /credentials/i,
  /secrets?\./i,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
];

export interface RiskAssessment {
  isRisky: boolean;
  risks: { description: string; severity: "low" | "medium" | "high" }[];
}

export function assessCommandRisk(command: string): RiskAssessment {
  const risks: RiskAssessment["risks"] = [];

  for (const { pattern, description } of RISKY_PATTERNS) {
    if (pattern.test(command)) {
      const severity = pattern.source.includes("force") || pattern.source.includes("destroy")
        ? "high"
        : "medium";
      risks.push({ description, severity });
    }
  }

  return { isRisky: risks.length > 0, risks };
}

export function assessFileRisk(filePath: string): RiskAssessment {
  const risks: RiskAssessment["risks"] = [];

  for (const pattern of RISKY_FILE_PATTERNS) {
    if (pattern.test(filePath)) {
      risks.push({
        description: `Sensitive file modification: ${filePath}`,
        severity: "high",
      });
    }
  }

  return { isRisky: risks.length > 0, risks };
}

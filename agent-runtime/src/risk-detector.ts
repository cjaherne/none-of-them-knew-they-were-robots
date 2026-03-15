import { RiskAssessment, CursorStreamEvent } from "./types";

const RISKY_COMMAND_PATTERNS: { pattern: RegExp; description: string; severity: "low" | "medium" | "high" }[] = [
  { pattern: /git\s+push\s+--force/, description: "Force push (destructive)", severity: "high" },
  { pattern: /git\s+push/, description: "Git push operation", severity: "medium" },
  { pattern: /rm\s+-rf?\s+/, description: "Recursive file deletion", severity: "high" },
  { pattern: /npm\s+publish/, description: "Package publishing", severity: "high" },
  { pattern: /DROP\s+TABLE/i, description: "Database table drop", severity: "high" },
  { pattern: /DELETE\s+FROM/i, description: "Database deletion", severity: "high" },
  { pattern: /curl\s+.*\|\s*sh/, description: "Remote script execution", severity: "high" },
  { pattern: /chmod\s+777/, description: "Overly permissive file permissions", severity: "medium" },
  { pattern: /terraform\s+destroy/, description: "Infrastructure destruction", severity: "high" },
  { pattern: /cdk\s+destroy/, description: "CDK stack destruction", severity: "high" },
  { pattern: /npm\s+install\s+(?!--save-dev)/, description: "Dependency installation", severity: "low" },
];

const SENSITIVE_FILE_PATTERNS = [
  /\.env$/,
  /credentials/i,
  /secrets?\./i,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
];

export function assessEventRisk(event: CursorStreamEvent): RiskAssessment {
  const risks: RiskAssessment["risks"] = [];

  if (event.tool_call?.name === "run_command" || event.tool_call?.name === "shell") {
    const command = String(event.tool_call.arguments?.command || "");
    for (const { pattern, description, severity } of RISKY_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        risks.push({ description, severity });
      }
    }
  }

  if (event.tool_call?.name === "write_file" || event.tool_call?.name === "create_file") {
    const filePath = String(event.tool_call.arguments?.path || "");
    for (const pattern of SENSITIVE_FILE_PATTERNS) {
      if (pattern.test(filePath)) {
        risks.push({
          description: `Sensitive file modification: ${filePath}`,
          severity: "high",
        });
      }
    }
  }

  if (event.tool_call?.name === "delete_file") {
    risks.push({
      description: `File deletion: ${event.tool_call.arguments?.path}`,
      severity: "medium",
    });
  }

  const content = event.content || "";
  for (const { pattern, description, severity } of RISKY_COMMAND_PATTERNS) {
    if (pattern.test(content)) {
      risks.push({ description: `In output: ${description}`, severity });
    }
  }

  return { isRisky: risks.length > 0, risks };
}

export function assessOutputRisks(events: CursorStreamEvent[]): RiskAssessment {
  const allRisks: RiskAssessment["risks"] = [];

  for (const event of events) {
    const assessment = assessEventRisk(event);
    allRisks.push(...assessment.risks);
  }

  return { isRisky: allRisks.length > 0, risks: allRisks };
}

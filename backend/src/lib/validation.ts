import type { ZodError, ZodIssue } from "zod";

export interface ValidationIssueDetail {
  field: string;
  reason: string;
  code: string;
}

function issueDetail(issue: ZodIssue): ValidationIssueDetail {
  return {
    field: issue.path.length ? issue.path.join(".") : "request",
    reason: issue.message,
    code: issue.code,
  };
}

/** A stable, human-readable validation payload shared by every settings screen. */
export function validationFailure(title: string, error: ZodError) {
  const issues = error.issues.map(issueDetail);
  const reason = issues.map((issue) => `${issue.field}: ${issue.reason}`).join("; ");
  return {
    error: title,
    reason,
    issues,
    action: "Correct the listed fields and save again.",
  };
}

export function settingFailure(field: string, reason: string, action: string) {
  return {
    error: "invalid setting",
    reason: `${field}: ${reason}`,
    issues: [{ field, reason, code: "custom" }],
    action,
  };
}

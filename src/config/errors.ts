export function formatConfigError(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues?: Array<{ path?: Array<string | number>; message?: string }> }).issues ?? [];
    return issues
      .map((issue) => `${issue.path?.join(".") || "config"}: ${issue.message ?? "Invalid value"}`)
      .join("; ");
  }

  return error instanceof Error ? error.message : "Unknown configuration error";
}

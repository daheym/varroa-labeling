export class ApiError extends Error {
  constructor(public status: number, detail?: string) {
    super(detail ? `${detail} (HTTP ${status})` : `Request failed (HTTP ${status})`);
    this.retryable = !detail && (status === 400 || status >= 500);
  }
  readonly retryable: boolean;
}

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = typeof body?.detail === "string" ? body.detail : undefined;
    throw new ApiError(response.status, detail);
  }
  return response.json();
}

export const json = (data: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

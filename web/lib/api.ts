export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    cache: "no-store",
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Request failed") as Error & {
      field?: string;
      rows?: unknown;
    };
    error.field = data.field;
    error.rows = data.rows;
    throw error;
  }
  return data as T;
}

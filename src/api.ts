/** Same-origin transport. Browser storage never holds provider keys. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      typeof data === 'object' && data && 'error' in data ? String(data.error) : 'Request failed.',
    );
  return data as T;
}

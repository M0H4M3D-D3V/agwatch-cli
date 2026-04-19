export type HttpRequest = {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

export type HttpResponse<T = unknown> = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  rawText: string;
  json?: T;
};

export async function httpRequest<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });

    const rawText = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });

    let json: T | undefined;
    try {
      json = JSON.parse(rawText) as T;
    } catch {
      json = undefined;
    }

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers,
      rawText,
      json,
    };
  } finally {
    clearTimeout(timer);
  }
}

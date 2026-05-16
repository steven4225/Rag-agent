import { apiErrorSchema } from "@/lib/contracts";

export class ApiRequestError extends Error {
  code: string;
  traceId?: string;

  constructor(message: string, code = "UNKNOWN_ERROR", traceId?: string) {
    super(message);
    this.code = code;
    this.traceId = traceId;
  }
}

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      throw new ApiRequestError(parsed.data.message, parsed.data.code, parsed.data.traceId);
    }
    throw new ApiRequestError(`Request failed with status ${response.status}`, "HTTP_ERROR");
  }

  return body as T;
}

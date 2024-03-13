interface SerializedRequest {
  id: string
  url: string
  method: string
  headers: Array<[string, string]>
  credentials: RequestCredentials
  body: string
}

interface SerializedResponse {
  status: number
  statusText: string
  headers: Array<[string, string]>
  body: string
}

export async function serialiseRequest(request: Request, requestId: string): Promise<SerializedRequest> {
  return {
    id: requestId,
    method: request.method,
    url: request.url,
    headers: Array.from(request.headers.entries()),
    credentials: request.credentials,
    body: ['GET', 'HEAD'].includes(request.method)
      ? null
      : await request.text(),
  } as SerializedRequest
}

export function parseRequest(requestInit: SerializedRequest): Request {
  return new Request(new URL(requestInit.url), {
    method: requestInit.method,
    headers: new Headers(requestInit.headers),
    credentials: requestInit.credentials,
    body: requestInit.body,
  })
}

export async function serialiseResponse(response: Response): Promise<SerializedResponse> {
  const responseText = await response.text()
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    body: responseText,
  }
}

export function parseResponse(responseInit: SerializedResponse): Response {
  return new Response(responseInit.body || null, {
    status: responseInit.status,
    statusText: responseInit.statusText,
    headers: responseInit.headers,
  })
}

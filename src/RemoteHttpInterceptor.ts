import { ChildProcess } from 'child_process'
import { HttpRequestEventMap } from './glossary'
import { Interceptor } from './Interceptor'
import { BatchInterceptor } from './BatchInterceptor'
import { ClientRequestInterceptor } from './interceptors/ClientRequest'
import { XMLHttpRequestInterceptor } from './interceptors/XMLHttpRequest'
import { InteractiveRequest, toInteractiveRequest } from './utils/toInteractiveRequest'
import { emitAsync } from './utils/emitAsync'
import { FetchInterceptor } from './interceptors/fetch'

export interface SerializedRequest {
  id: string
  url: string
  method: string
  headers: Array<[string, string]>
  credentials: RequestCredentials
  body: string
}

export interface SerializedResponse {
  status: number
  statusText: string
  headers: Array<[string, string]>
  body: string
}

export class RemoteHttpInterceptor extends BatchInterceptor<
  [ClientRequestInterceptor, XMLHttpRequestInterceptor, FetchInterceptor]
> {
  requestId2Response: Map<string, { request: InteractiveRequest, resolve: () => void }> = new Map();
  constructor() {
    super({
      name: 'remote-interceptor',
      interceptors: [
        new ClientRequestInterceptor(),
        new XMLHttpRequestInterceptor(),
        new FetchInterceptor(),
      ],
    })
  }

  protected setup() {
    super.setup()

    this.on('request', async ({ request, requestId }) => {
      // Send the stringified intercepted request to
      // the parent process where the remote resolver is established.
      const serializedRequest = await serialiseRequest(request, requestId)

      this.logger.info(
        'sent serialized request to the child:',
        serializedRequest
      )
      process.send?.({
        type: 'request',
        payload: serializedRequest,
      })

      const responsePromise = new Promise<void>((resolve) => {
        this.requestId2Response.set(requestId, { request, resolve })
      })
      return responsePromise
    })

    const handleParentMessage: NodeJS.MessageListener = (message: any) => {
      if (message?.type !== 'response') {
        return
      }
      const requestId = message.requestId;
      const entry = this.requestId2Response.get(requestId)
      if (!entry) {
        return;
      }
      this.requestId2Response.delete(requestId)
      const { request, resolve } = entry

      const mockedResponse = parseResponse(message.payload)

      request.respondWith(mockedResponse)
      return resolve()
    }

      // Listen for the mocked response message from the parent.
      this.logger.info(
        'add "message" listener to the parent process',
        handleParentMessage
      )
      process.addListener('message', handleParentMessage)

    this.subscriptions.push(() => {
      process.removeListener('message', handleParentMessage)
    })
  }
}

async function serialiseRequest(request: Request, requestId: string): Promise<SerializedRequest> {
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

function parseRequest(requestInit: SerializedRequest): Request {
  return new Request(new URL(requestInit.url), {
    method: requestInit.method,
    headers: new Headers(requestInit.headers),
    credentials: requestInit.credentials,
    body: requestInit.body,
  })
}

async function serialiseResponse(response: Response): Promise<SerializedResponse> {
  const responseText = await response.text()
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    body: responseText,
  }
}

function parseResponse(responseInit: SerializedResponse): Response {
  return new Response(responseInit.body, {
    status: responseInit.status,
    statusText: responseInit.statusText,
    headers: responseInit.headers,
  })
}

export interface RemoveResolverOptions {
  process: ChildProcess
}

export class RemoteHttpResolver extends Interceptor<HttpRequestEventMap> {
  static symbol = Symbol('remote-resolver')
  private process: ChildProcess

  constructor(options: RemoveResolverOptions) {
    super(RemoteHttpResolver.symbol)
    this.process = options.process
  }

  protected setup() {
    const logger = this.logger.extend('setup')

    const handleChildMessage: NodeJS.MessageListener = async (message: any) => {
      logger.info('received message from child!', message)

      if (message?.type !== 'request') {
        logger.info('unknown message, ignoring...')
        return
      }

      const requestJson = message.payload
      logger.info('parsed intercepted request', requestJson)

      const capturedRequest = parseRequest(requestJson)

      const { interactiveRequest, requestController } =
        toInteractiveRequest(capturedRequest)

      this.emitter.once('request', () => {
        if (requestController.responsePromise.state === 'pending') {
          requestController.respondWith(undefined)
        }
      })

      await emitAsync(this.emitter, 'request', {
        request: interactiveRequest,
        requestId: requestJson.id,
      })

      const mockedResponse = await requestController.responsePromise

      if (!mockedResponse) {
        return
      }

      logger.info('event.respondWith called with:', mockedResponse)
      const responseClone = mockedResponse.clone()
      const responsePayload = {
        type: 'response',
        requestId: requestJson.id,
        payload: await serialiseResponse(responseClone),
      };
      this.process.send(
        responsePayload,
        (error) => {
          if (error) {
            return
          }

          // Emit an optimistic "response" event at this point,
          // not to rely on the back-and-forth signaling for the sake of the event.
          this.emitter.emit('response', {
            response: responseClone,
            isMockedResponse: true,
            request: capturedRequest,
            requestId: requestJson.id,
          })
        }
      )

      logger.info(
        'sent serialized mocked response to the parent:',
        responsePayload
      )
    }

    this.subscriptions.push(() => {
      this.process.removeListener('message', handleChildMessage)
      logger.info('removed the "message" listener from the child process!')
    })

    logger.info('adding a "message" listener to the child process')
    this.process.addListener('message', handleChildMessage)

    this.process.once('error', () => this.dispose())
    this.process.once('exit', () => this.dispose())
  }
}

import { ChildProcess } from 'child_process'
import { HttpRequestEventMap } from './glossary'
import { Interceptor } from './Interceptor'
import { BatchInterceptor } from './BatchInterceptor'
import { ClientRequestInterceptor } from './interceptors/ClientRequest'
import { XMLHttpRequestInterceptor } from './interceptors/XMLHttpRequest'
import { InteractiveRequest, toInteractiveRequest } from './utils/toInteractiveRequest'
import { emitAsync } from './utils/emitAsync'
import { FetchInterceptor } from './interceptors/fetch'
import { parseRequest, parseResponse, serialiseRequest, serialiseResponse } from './remoteUtils';
import WebSocket, { WebSocketServer } from 'ws';

export class RemoteHttpInterceptorOverWS extends BatchInterceptor<
  [ClientRequestInterceptor, XMLHttpRequestInterceptor, FetchInterceptor]
> {
  requestId2Response: Map<string, { request: InteractiveRequest, resolve: () => void }> = new Map();
  private _ws: WebSocket | undefined;
  constructor(private readonly options: { port: number }) {
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

    this._ws = new WebSocket(`ws://localhost:${this.options.port}`)

    this.prependListener('request', async ({ request, requestId }) => {
      // Send the stringified intercepted request to
      // the parent process where the remote resolver is established.
      const serializedRequest = await serialiseRequest(request, requestId)

      this.logger.info(
        'sent serialized request to the child:',
        serializedRequest
      )
      this._ws!.send?.(JSON.stringify({
        type: 'request',
        payload: serializedRequest,
        requestId,
      }))

      const responsePromise = new Promise<void>((resolve) => {
        this.requestId2Response.set(requestId, { request, resolve })
      })
      console.log('waiting for response', requestId)
      await responsePromise
      console.log('got response', requestId)
    })

    const handleParentMessage = (messageRaw: WebSocket.MessageEvent) => {
      if (typeof messageRaw.data !== 'string') {
        return
      }
      const message = JSON.parse(messageRaw.data)
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
    this._ws.addEventListener('message', handleParentMessage)

    this.subscriptions.push(() => {
      process.removeListener('message', handleParentMessage)
    })
  }
  public dispose(): void {
    super.dispose()
    this._ws?.close()
  }
}

export class RemoteHttpResolverOverWS extends Interceptor<HttpRequestEventMap> {
  static symbol = Symbol('remote-resolver')
  private _wss: WebSocketServer | undefined

  constructor(private readonly options: { port: number }) {
    super(RemoteHttpResolverOverWS.symbol)
  }

  protected setup() {
    const logger = this.logger.extend('setup')

    this._wss = new WebSocketServer({ port: this.options.port })

    const handleOnMessage = async (ws: WebSocket, data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        return
      }
      const rawMessage = data.toString()
      logger.info('received message from child!', rawMessage)
      const { requestId, payload } = JSON.parse(rawMessage)

      const capturedRequest = parseRequest(payload)

      const { interactiveRequest, requestController } =
        toInteractiveRequest(capturedRequest)

      console.log('emitting request event', requestId)

      await emitAsync(this.emitter, 'request', {
        request: interactiveRequest,
        requestId: requestId,
      })

      const mockedResponse = await requestController.responsePromise

      if (!mockedResponse) {
        return
      }

      logger.info('event.respondWith called with:', mockedResponse)
      console.log('calling respondWith', requestId)
      const responseClone = mockedResponse.clone()
      const responsePayload = {
        type: 'response',
        requestId: requestId,
        payload: await serialiseResponse(responseClone),
      };
      ws.send(
        JSON.stringify(responsePayload),
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
            requestId: requestId,
          })
        }
      )

      logger.info(
        'sent serialized mocked response to the parent:',
        responsePayload
      )
    }

    const handleConnection = (ws: WebSocket) => ws.on('message', (data, isBinary) => handleOnMessage(ws, data, isBinary))

    this.subscriptions.push(() => {
      this._wss!.removeListener('connection', handleConnection);
      logger.info('removed the "message" listener from the child process!')
    })

    logger.info('adding a "message" listener to the child process')
    this._wss.on('connection', handleConnection);

    this._wss.once('close', () => this.dispose())
    this._wss.once('error', () => this.dispose())
  }
  
  public dispose(): void {
    super.dispose()
    this._wss?.close()
  }
}

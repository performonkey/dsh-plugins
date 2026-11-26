/** Worker-side stream dispatcher executing local streams for Master tunnel requests. */

import type {
  ClusterFrame,
  StreamCloseFrame,
  StreamItemFrame,
  StreamOpenFrame,
  StreamUplinkFrame,
  TunnelStreamId,
} from '@deepseek-ai/dsh-cluster-protocol'

/** Asynchronous FIFO queue providing an AsyncIterable interface for stream uplinks. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private ended = false

  /**
   * Push an item into the queue.
   * @param item - Value to enqueue.
   */
  push(item: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  /** Close the queue to further pushes. */
  end(): void {
    if (this.ended) return
    this.ended = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.({ value: undefined, done: true })
    }
  }

  /**
   * Asynchronous iterator consuming enqueued items.
   * @returns AsyncIterator of items.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!
      } else if (this.ended) {
        return
      } else {
        const result = await new Promise<IteratorResult<T>>(resolve => {
          this.waiters.push(resolve)
        })
        if (result.done) return
        yield result.value
      }
    }
  }
}

/** Function opening a local stream on the worker node. */
export type LocalStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  signal: AbortSignal,
) => Promise<AsyncIterable<unknown>>

interface ActiveStream {
  readonly controller: AbortController
  readonly uplinkQueue: AsyncQueue<unknown>
}

/** Manages active streams on the worker side requested through the reverse tunnel. */
export class WorkerStreamDispatcher {
  private readonly activeStreams = new Map<TunnelStreamId, ActiveStream>()

  /**
   * @param opener - Local stream execution function.
   * @param sendFrame - Sender delivering frames back to Master.
   */
  constructor(
    private readonly opener: LocalStreamOpener,
    private readonly sendFrame: (frame: ClusterFrame) => void,
  ) {}

  /**
   * Handle an incoming cluster frame related to streams.
   * @param frame - Tunnel frame.
   */
  async handleFrame(frame: ClusterFrame): Promise<void> {
    switch (frame.type) {
      case 'stream:open':
        await this.handleOpen(frame)
        break
      case 'stream:uplink':
        this.handleUplink(frame)
        break
      case 'stream:close':
        this.handleClose(frame)
        break
      default:
        break
    }
  }

  private async handleOpen(frame: StreamOpenFrame): Promise<void> {
    const streamId = frame.streamId
    const controller = new AbortController()
    const uplinkQueue = new AsyncQueue<unknown>()

    this.activeStreams.set(streamId, { controller, uplinkQueue })

    try {
      const downlink = await this.opener(
        frame.endpoint,
        frame.payload,
        uplinkQueue,
        controller.signal,
      )

      for await (const item of downlink) {
        if (controller.signal.aborted) break
        const itemFrame: StreamItemFrame = {
          type: 'stream:item',
          streamId,
          value: item,
        }
        this.sendFrame(itemFrame)
      }

      if (!controller.signal.aborted) {
        const closeFrame: StreamCloseFrame = {
          type: 'stream:close',
          streamId,
          reason: 'completed',
        }
        this.sendFrame(closeFrame)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const closeFrame: StreamCloseFrame = {
          type: 'stream:close',
          streamId,
          reason: 'error',
          error: {
            code: 'stream/execution-failure',
            message: err instanceof Error ? err.message : String(err),
            details: {},
          },
        }
        this.sendFrame(closeFrame)
      }
    } finally {
      this.activeStreams.delete(streamId)
      uplinkQueue.end()
    }
  }

  private handleUplink(frame: StreamUplinkFrame): void {
    const stream = this.activeStreams.get(frame.streamId)
    if (stream) {
      stream.uplinkQueue.push(frame.item)
    }
  }

  private handleClose(frame: StreamCloseFrame): void {
    const stream = this.activeStreams.get(frame.streamId)
    if (stream) {
      stream.controller.abort(frame.reason)
      stream.uplinkQueue.end()
      this.activeStreams.delete(frame.streamId)
    }
  }

  /** Abort and clean up all active streams (e.g. on disconnect). */
  close(): void {
    for (const [id, stream] of this.activeStreams.entries()) {
      stream.controller.abort('Worker stream dispatcher closed')
      stream.uplinkQueue.end()
      this.activeStreams.delete(id)
    }
  }
}

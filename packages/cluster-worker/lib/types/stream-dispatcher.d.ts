/** Worker-side stream dispatcher executing local streams for Master tunnel requests. */
import type { ClusterFrame } from '@deepseek-ai/dsh-cluster-protocol';
/** Asynchronous FIFO queue providing an AsyncIterable interface for stream uplinks. */
export declare class AsyncQueue<T> implements AsyncIterable<T> {
    private readonly items;
    private readonly waiters;
    private ended;
    /**
     * Push an item into the queue.
     * @param item - Value to enqueue.
     */
    push(item: T): void;
    /** Close the queue to further pushes. */
    end(): void;
    /**
     * Asynchronous iterator consuming enqueued items.
     * @returns AsyncIterator of items.
     */
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
/** Function opening a local stream on the worker node. */
export type LocalStreamOpener = (endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, signal: AbortSignal) => Promise<AsyncIterable<unknown>>;
/** Manages active streams on the worker side requested through the reverse tunnel. */
export declare class WorkerStreamDispatcher {
    private readonly opener;
    private readonly sendFrame;
    private readonly activeStreams;
    /**
     * @param opener - Local stream execution function.
     * @param sendFrame - Sender delivering frames back to Master.
     */
    constructor(opener: LocalStreamOpener, sendFrame: (frame: ClusterFrame) => void);
    /**
     * Handle an incoming cluster frame related to streams.
     * @param frame - Tunnel frame.
     */
    handleFrame(frame: ClusterFrame): Promise<void>;
    private handleOpen;
    private handleUplink;
    private handleClose;
    /** Abort and clean up all active streams (e.g. on disconnect). */
    close(): void;
}
//# sourceMappingURL=stream-dispatcher.d.ts.map
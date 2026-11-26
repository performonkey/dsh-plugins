/** Worker-side stream dispatcher executing local streams for Master tunnel requests. */
/** Asynchronous FIFO queue providing an AsyncIterable interface for stream uplinks. */
export class AsyncQueue {
    items = [];
    waiters = [];
    ended = false;
    /**
     * Push an item into the queue.
     * @param item - Value to enqueue.
     */
    push(item) {
        if (this.ended)
            return;
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter({ value: item, done: false });
        }
        else {
            this.items.push(item);
        }
    }
    /** Close the queue to further pushes. */
    end() {
        if (this.ended)
            return;
        this.ended = true;
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter?.({ value: undefined, done: true });
        }
    }
    /**
     * Asynchronous iterator consuming enqueued items.
     * @returns AsyncIterator of items.
     */
    async *[Symbol.asyncIterator]() {
        while (true) {
            if (this.items.length > 0) {
                yield this.items.shift();
            }
            else if (this.ended) {
                return;
            }
            else {
                const result = await new Promise(resolve => {
                    this.waiters.push(resolve);
                });
                if (result.done)
                    return;
                yield result.value;
            }
        }
    }
}
/** Manages active streams on the worker side requested through the reverse tunnel. */
export class WorkerStreamDispatcher {
    opener;
    sendFrame;
    activeStreams = new Map();
    /**
     * @param opener - Local stream execution function.
     * @param sendFrame - Sender delivering frames back to Master.
     */
    constructor(opener, sendFrame) {
        this.opener = opener;
        this.sendFrame = sendFrame;
    }
    /**
     * Handle an incoming cluster frame related to streams.
     * @param frame - Tunnel frame.
     */
    async handleFrame(frame) {
        switch (frame.type) {
            case 'stream:open':
                await this.handleOpen(frame);
                break;
            case 'stream:uplink':
                this.handleUplink(frame);
                break;
            case 'stream:close':
                this.handleClose(frame);
                break;
            default:
                break;
        }
    }
    async handleOpen(frame) {
        const streamId = frame.streamId;
        const controller = new AbortController();
        const uplinkQueue = new AsyncQueue();
        this.activeStreams.set(streamId, { controller, uplinkQueue });
        try {
            const downlink = await this.opener(frame.endpoint, frame.payload, uplinkQueue, controller.signal);
            for await (const item of downlink) {
                if (controller.signal.aborted)
                    break;
                const itemFrame = {
                    type: 'stream:item',
                    streamId,
                    value: item,
                };
                this.sendFrame(itemFrame);
            }
            if (!controller.signal.aborted) {
                const closeFrame = {
                    type: 'stream:close',
                    streamId,
                    reason: 'completed',
                };
                this.sendFrame(closeFrame);
            }
        }
        catch (err) {
            if (!controller.signal.aborted) {
                const closeFrame = {
                    type: 'stream:close',
                    streamId,
                    reason: 'error',
                    error: {
                        code: 'stream/execution-failure',
                        message: err instanceof Error ? err.message : String(err),
                        details: {},
                    },
                };
                this.sendFrame(closeFrame);
            }
        }
        finally {
            this.activeStreams.delete(streamId);
            uplinkQueue.end();
        }
    }
    handleUplink(frame) {
        const stream = this.activeStreams.get(frame.streamId);
        if (stream) {
            stream.uplinkQueue.push(frame.item);
        }
    }
    handleClose(frame) {
        const stream = this.activeStreams.get(frame.streamId);
        if (stream) {
            stream.controller.abort(frame.reason);
            stream.uplinkQueue.end();
            this.activeStreams.delete(frame.streamId);
        }
    }
    /** Abort and clean up all active streams (e.g. on disconnect). */
    close() {
        for (const [id, stream] of this.activeStreams.entries()) {
            stream.controller.abort('Worker stream dispatcher closed');
            stream.uplinkQueue.end();
            this.activeStreams.delete(id);
        }
    }
}
//# sourceMappingURL=stream-dispatcher.js.map
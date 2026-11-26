/** Wire frames and type discriminators for cluster master-worker tunnel communication. */
/**
 * Serialize a cluster frame to a JSON string.
 * @param frame - Frame to encode.
 * @returns JSON serialized string.
 */
export function serializeClusterFrame(frame) {
    return JSON.stringify(frame);
}
/**
 * Validate and parse a raw wire payload into a typed cluster frame.
 * @param raw - Raw string or buffer from socket.
 * @returns Parsed cluster frame, or undefined if malformed or unknown type.
 */
export function parseClusterFrame(raw) {
    if (typeof raw !== 'string') {
        if (Buffer.isBuffer(raw)) {
            raw = raw.toString('utf-8');
        }
        else {
            return undefined;
        }
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return undefined;
    }
    const candidate = parsed;
    if (typeof candidate.type !== 'string') {
        return undefined;
    }
    switch (candidate.type) {
        case 'control:hello': {
            const f = parsed;
            if (typeof f.token === 'string' &&
                typeof f.workerId === 'string' &&
                typeof f.name === 'string' &&
                Array.isArray(f.workspaces) &&
                typeof f.version === 'string' &&
                typeof f.timestamp === 'number') {
                return f;
            }
            return undefined;
        }
        case 'control:ready': {
            const f = parsed;
            if (typeof f.accepted === 'boolean' && typeof f.masterTime === 'number') {
                return f;
            }
            return undefined;
        }
        case 'ping': {
            const f = parsed;
            if (typeof f.timestamp === 'number') {
                return f;
            }
            return undefined;
        }
        case 'pong': {
            const f = parsed;
            if (typeof f.timestamp === 'number') {
                return f;
            }
            return undefined;
        }
        case 'http:req': {
            const f = parsed;
            if (typeof f.reqId === 'string' &&
                typeof f.method === 'string' &&
                typeof f.path === 'string') {
                return f;
            }
            return undefined;
        }
        case 'http:cancel': {
            const f = parsed;
            return typeof f.reqId === 'string' ? f : undefined;
        }
        case 'http:resp': {
            const f = parsed;
            if (typeof f.reqId === 'string' && typeof f.status === 'number') {
                return f;
            }
            return undefined;
        }
        case 'stream:open': {
            const f = parsed;
            if (typeof f.streamId === 'string' && typeof f.endpoint === 'string') {
                return f;
            }
            return undefined;
        }
        case 'stream:item': {
            const f = parsed;
            if (typeof f.streamId === 'string' && 'value' in f) {
                return f;
            }
            return undefined;
        }
        case 'stream:uplink': {
            const f = parsed;
            if (typeof f.streamId === 'string' && 'item' in f) {
                return f;
            }
            return undefined;
        }
        case 'stream:close': {
            const f = parsed;
            if (typeof f.streamId === 'string') {
                return f;
            }
            return undefined;
        }
        default:
            return undefined;
    }
}
/**
 * Determine if a frame is a control hello frame.
 * @param frame - Candidate frame.
 * @returns True if frame is control hello.
 */
export function isControlHelloFrame(frame) {
    return frame.type === 'control:hello';
}
/**
 * Determine if a frame is a control ready frame.
 * @param frame - Candidate frame.
 * @returns True if frame is control ready.
 */
export function isControlReadyFrame(frame) {
    return frame.type === 'control:ready';
}
/**
 * Determine if a frame is an HTTP request frame.
 * @param frame - Candidate frame.
 * @returns True if frame is HTTP request.
 */
export function isHttpReqFrame(frame) {
    return frame.type === 'http:req';
}
/**
 * Determine if a frame is an HTTP response frame.
 * @param frame - Candidate frame.
 * @returns True if frame is HTTP response.
 */
export function isHttpRespFrame(frame) {
    return frame.type === 'http:resp';
}
//# sourceMappingURL=frames.js.map
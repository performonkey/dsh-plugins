/** Wire frames and type discriminators for cluster master-worker tunnel communication. */
import type { Branded } from '@deepseek-ai/dsh-brand';
/** Opaque brand for worker node identification. */
export type WorkerId = Branded<'WorkerId'>;
/** Opaque brand for HTTP request correlation. */
export type TunnelRequestId = Branded<'TunnelRequestId'>;
/** Opaque brand for multiplexed stream correlation. */
export type TunnelStreamId = Branded<'TunnelStreamId'>;
/** Worker registration handshake frame sent immediately upon connecting. */
export interface ControlHelloFrame {
    readonly type: 'control:hello';
    readonly token: string;
    readonly workerId: WorkerId;
    readonly name: string;
    readonly workspaces: readonly string[];
    readonly version: string;
    readonly timestamp: number;
}
/** Master registration acknowledgment frame. */
export interface ControlReadyFrame {
    readonly type: 'control:ready';
    readonly accepted: boolean;
    readonly reason?: string | undefined;
    readonly masterTime: number;
}
/** Heartbeat ping frame. */
export interface PingFrame {
    readonly type: 'ping';
    readonly timestamp: number;
}
/** Heartbeat pong frame. */
export interface PongFrame {
    readonly type: 'pong';
    readonly timestamp: number;
}
/** Transparent HTTP unary request frame dispatched from master to worker. */
export interface HttpReqFrame {
    readonly type: 'http:req';
    readonly reqId: TunnelRequestId;
    readonly method: string;
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly body?: string | undefined;
}
/** Cancel an outstanding HTTP request. */
export interface HttpCancelFrame {
    readonly type: 'http:cancel';
    readonly reqId: TunnelRequestId;
}
/** Transparent HTTP unary response frame returned from worker to master. */
export interface HttpRespFrame {
    readonly type: 'http:resp';
    readonly reqId: TunnelRequestId;
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly body?: string | undefined;
}
/** Open a logical streaming channel on the tunnel. */
export interface StreamOpenFrame {
    readonly type: 'stream:open';
    readonly streamId: TunnelStreamId;
    readonly endpoint: string;
    readonly payload?: unknown;
    readonly peer?: unknown;
}
/** Downlink item frame sent from worker to master. */
export interface StreamItemFrame {
    readonly type: 'stream:item';
    readonly streamId: TunnelStreamId;
    readonly value: unknown;
}
/** Uplink item frame sent from master to worker. */
export interface StreamUplinkFrame {
    readonly type: 'stream:uplink';
    readonly streamId: TunnelStreamId;
    readonly item: unknown;
}
/** Stream termination frame. */
export interface StreamCloseFrame {
    readonly type: 'stream:close';
    readonly streamId: TunnelStreamId;
    readonly reason?: string | undefined;
    readonly error?: {
        readonly code: string;
        readonly message: string;
        readonly details?: object;
    } | undefined;
}
/** All valid cluster tunnel frames. */
export type ClusterFrame = ControlHelloFrame | ControlReadyFrame | PingFrame | PongFrame | HttpReqFrame | HttpCancelFrame | HttpRespFrame | StreamOpenFrame | StreamItemFrame | StreamUplinkFrame | StreamCloseFrame;
/** Known cluster frame discriminant tags. */
export type ClusterFrameType = ClusterFrame['type'];
/**
 * Serialize a cluster frame to a JSON string.
 * @param frame - Frame to encode.
 * @returns JSON serialized string.
 */
export declare function serializeClusterFrame(frame: ClusterFrame): string;
/**
 * Validate and parse a raw wire payload into a typed cluster frame.
 * @param raw - Raw string or buffer from socket.
 * @returns Parsed cluster frame, or undefined if malformed or unknown type.
 */
export declare function parseClusterFrame(raw: unknown): ClusterFrame | undefined;
/**
 * Determine if a frame is a control hello frame.
 * @param frame - Candidate frame.
 * @returns True if frame is control hello.
 */
export declare function isControlHelloFrame(frame: ClusterFrame): frame is ControlHelloFrame;
/**
 * Determine if a frame is a control ready frame.
 * @param frame - Candidate frame.
 * @returns True if frame is control ready.
 */
export declare function isControlReadyFrame(frame: ClusterFrame): frame is ControlReadyFrame;
/**
 * Determine if a frame is an HTTP request frame.
 * @param frame - Candidate frame.
 * @returns True if frame is HTTP request.
 */
export declare function isHttpReqFrame(frame: ClusterFrame): frame is HttpReqFrame;
/**
 * Determine if a frame is an HTTP response frame.
 * @param frame - Candidate frame.
 * @returns True if frame is HTTP response.
 */
export declare function isHttpRespFrame(frame: ClusterFrame): frame is HttpRespFrame;
//# sourceMappingURL=frames.d.ts.map
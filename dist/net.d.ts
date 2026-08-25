import type { FoyerContext } from './client.js';
import type { Topology, Unsubscribe } from './types.js';
export type PeerOptions = {
    topology: Topology;
    /**
     * Passed straight to createDataChannel. The default is reliable and
     * ordered, which is what most apps want.
     *
     * Realtime games usually do not: if your protocol already sequences and
     * retries, an ordered channel head-of-line blocks and adds exactly the
     * latency the protocol exists to avoid. `{ ordered: false, maxRetransmits: 0 }`
     * is the usual choice there.
     */
    channel?: RTCDataChannelInit;
    label?: string;
};
export type Peer = {
    id: string;
    send: (data: string | ArrayBufferView | ArrayBuffer) => void;
    close: () => void;
    readonly open: boolean;
};
type Events = {
    peer: Peer;
    leave: string;
    data: {
        from: string;
        data: unknown;
    };
    error: Error;
};
type Listener<K extends keyof Events> = (payload: Events[K]) => void;
export declare class PeerNet {
    private readonly ctx;
    private readonly roomId;
    private readonly selfId;
    private readonly hostId;
    private readonly opts;
    private channel;
    private connections;
    private channels;
    private pendingIce;
    private listeners;
    constructor(ctx: FoyerContext, roomId: string, hostId: string, opts: PeerOptions);
    get peers(): string[];
    on: <K extends keyof Events>(event: K, listener: Listener<K>) => Unsubscribe;
    private emit;
    private shouldConnect;
    private isOfferer;
    connect: () => Promise<void>;
    close: () => void;
    private send;
    private drop;
    private newConnection;
    private adopt;
    private offerTo;
    private onSignal;
}
export {};

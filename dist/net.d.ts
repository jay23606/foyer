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
    /**
     * Should these two be connected at all?
     *
     * In a star only host-to-client pairs are wired, which is correct when the
     * host is authoritative and wrong for anything peers must exchange
     * directly. In a mesh everyone is wired to everyone.
     */
    private shouldConnect;
    /**
     * Exactly one side of a pair must offer, or both offer at once and the
     * negotiation collides.
     *
     * In a star the client offers and the host answers, so the host never has
     * to know who is arriving before they arrive. In a mesh there is no host to
     * lean on, so the lower id offers -- both peers compute the same answer
     * from data they already have.
     */
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

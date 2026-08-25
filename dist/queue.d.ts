import type { SupabaseClient } from '@supabase/supabase-js';
import type { Unsubscribe } from './types.js';
export type QueueOptions = {
    /** Which queue. Separate tags never meet, so one table serves many apps. */
    tag?: string;
    /** Local media to send. Omit for a data-only pairing. */
    media?: MediaStream;
    channel?: RTCDataChannelInit;
    /** Give up after this long with nobody to pair with. */
    timeoutMs?: number;
    iceServers?: RTCIceServer[];
    /** Table prefix, matching the schema. */
    prefix?: string;
};
type Events = {
    data: unknown;
    stream: MediaStream;
    close: void;
};
type Listener<K extends keyof Events> = (payload: Events[K]) => void;
export declare class QueuePeer {
    readonly id: string;
    private pc;
    private dc;
    private listeners;
    constructor(id: string, pc: RTCPeerConnection);
    /** @internal */
    attachChannel(dc: RTCDataChannel): void;
    /** @internal */
    emit<K extends keyof Events>(event: K, payload: Events[K]): void;
    on: <K extends keyof Events>(event: K, listener: Listener<K>) => Unsubscribe;
    get open(): boolean;
    send: (data: string | ArrayBufferView | ArrayBuffer) => void;
    close: () => void;
}
/**
 * Pairs with whoever is waiting, or waits to be paired with.
 *
 * Resolves once a peer connection is established, or rejects on timeout.
 */
export declare const pair: (supabase: SupabaseClient, options?: QueueOptions) => Promise<QueuePeer>;
export {};

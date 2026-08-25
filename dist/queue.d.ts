import type { SupabaseClient } from '@supabase/supabase-js';
import type { Unsubscribe, VideoQuality } from './types.js';
export type QueueOptions = {
    /** Which queue. Separate tags never meet, so one table serves many apps. */
    tag?: string;
    /** Local media to send. Omit for a data-only pairing. */
    media?: MediaStream;
    channel?: RTCDataChannelInit;
    /** Give up after this long with nobody to pair with. */
    timeoutMs?: number;
    /**
     * Stop waiting.
     *
     * Without this the only way out of a search is to wait out the timeout,
     * which is a poor answer when someone has simply changed their mind and
     * clicked away. Aborting also withdraws the advertisement, so nobody is
     * paired with a browser that has stopped listening.
     */
    signal?: AbortSignal;
    iceServers?: RTCIceServer[];
    /** Table prefix, matching the schema. */
    prefix?: string;
    /**
     * Video quality. A pairing is always two people, so the curve is asked for
     * one receiver -- but it is the same curve a room uses, so an app that
     * tunes quality tunes it everywhere rather than only half its connections.
     */
    videoQuality?: (peers: number) => VideoQuality;
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

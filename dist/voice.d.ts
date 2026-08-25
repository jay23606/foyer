import type { SupabaseClient } from '@supabase/supabase-js';
import type { FoyerContext } from './client.js';
import type { Unsubscribe } from './types.js';
export type VoiceStatus = 'off' | 'starting' | 'live' | 'denied' | 'unavailable';
export type VoiceListener = (status: VoiceStatus, detail?: string) => void;
export declare class VoiceMesh {
    private readonly ctx;
    private readonly roomId;
    private readonly selfId;
    private channel;
    private stream;
    private connections;
    private audio;
    private pendingIce;
    private status;
    private listeners;
    private mutedFlag;
    constructor(ctx: FoyerContext, roomId: string);
    get muted(): boolean;
    get currentStatus(): VoiceStatus;
    get peerCount(): number;
    onStatus: (listener: VoiceListener) => Unsubscribe;
    private setStatus;
    /**
     * Call this from a click or a keypress. getUserMedia prompts for
     * permission, and browsers refuse to play audio that no interaction asked
     * for; both need the user gesture that only a real event carries.
     *
     * Returns the status it settled on, so callers never have to re-read a
     * getter whose value this call just changed.
     */
    start: () => Promise<VoiceStatus>;
    stop: () => void;
    setMuted: (muted: boolean) => void;
    toggleMuted: () => boolean;
    private applyMute;
    private stopTracks;
    private openChannel;
    private send;
    private isOfferer;
    private newConnection;
    private offerTo;
    private onSignal;
    private attachAudio;
    private dropAudio;
    private drop;
}
export type StandaloneVoiceOptions = {
    supabase: SupabaseClient;
    /** Any stable string shared by everyone who should hear each other. */
    roomId: string;
    /** This player's id. Must be unique per participant and stable for the call. */
    playerId: string;
    iceServers?: RTCIceServer[];
};
/**
 * A voice mesh without the rest of foyer.
 *
 * Plenty of apps already have their own rooms and identity and want only this
 * part. Requiring them to adopt foyer's room model to get a microphone would
 * be a poor trade, so the mesh is constructible on its own: it needs a channel
 * name and a stable id, and nothing else foyer owns.
 */
export declare const createVoiceMesh: (options: StandaloneVoiceOptions) => VoiceMesh;

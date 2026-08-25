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
    private streamListeners;
    private leaveListeners;
    private mutedFlag;
    private cameraOffFlag;
    private audioOnly;
    private videoSenders;
    private videoSending;
    constructor(ctx: FoyerContext, roomId: string);
    get muted(): boolean;
    get currentStatus(): VoiceStatus;
    get peerCount(): number;
    onStatus: (listener: VoiceListener) => Unsubscribe;
    /** Fires when a peer's media arrives. Attach it to a <video> yourself. */
    onStream: (listener: (peerId: string, stream: MediaStream) => void) => Unsubscribe;
    /** Fires when a peer goes away, so their tile can be removed. */
    onLeave: (listener: (peerId: string) => void) => Unsubscribe;
    private setStatus;
    /**
     * Call this from a click or a keypress. getUserMedia prompts for
     * permission, and browsers refuse to play audio that no interaction asked
     * for; both need the user gesture that only a real event carries.
     *
     * Returns the status it settled on, so callers never have to re-read a
     * getter whose value this call just changed.
     */
    start: (request?: MediaStreamConstraints | MediaStream) => Promise<VoiceStatus>;
    stop: () => void;
    setMuted: (muted: boolean) => void;
    toggleMuted: () => boolean;
    get cameraOff(): boolean;
    setCameraOff: (off: boolean) => void;
    toggleCamera: () => boolean;
    get sendingVideo(): boolean;
    /**
     * Stop or resume sending video, without renegotiating.
     *
     * Disabling a track only makes the encoder send black frames; it keeps
     * paying for a stream nobody wants. Detaching the track from the sender
     * stops it outright, and replaceTrack is specified not to require a new
     * offer and answer -- which matters mid-call.
     *
     * Audio is untouched. Somebody whose camera is off is usually still
     * talking.
     */
    setVideoSending: (sending: boolean) => void;
    private applyVideoSending;
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
/**
 * The same mesh, named for what it now carries.
 *
 * `VoiceMesh` began audio-only and the name stuck; it takes constraints or a
 * ready-made stream, so it carries video and shared screens too. Both names
 * refer to one class, and the voice spelling stays because callers depend on it.
 */
export { VoiceMesh as MediaMesh };
export declare const createMediaMesh: (options: StandaloneVoiceOptions) => VoiceMesh;

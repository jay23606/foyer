import type { SupabaseClient } from '@supabase/supabase-js';
import type { FoyerContext } from './client.js';
import type { Unsubscribe, VideoQuality } from './types.js';
export type MediaStatus = 'off' | 'starting' | 'live' | 'denied' | 'unavailable';
export type MediaListener = (status: MediaStatus, detail?: string) => void;
export declare class MediaMesh {
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
    get currentStatus(): MediaStatus;
    get peerCount(): number;
    onStatus: (listener: MediaListener) => Unsubscribe;
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
    start: (request?: MediaStreamConstraints | MediaStream) => Promise<MediaStatus>;
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
    /**
     * Video quality, chosen from how many people are watching.
     *
     * A mesh makes every sender upload one copy per peer, so the cost of a
     * stream is multiplied by the audience. Fixed quality therefore has no
     * good setting: whatever looks right for two people is ruinous for
     * sixteen, and whatever survives sixteen looks needlessly poor for two.
     *
     * So it is not fixed. Two people get a decent picture; a crowd gets small
     * tiles, which is all a crowd of tiles can show anyway. Roughly a megabit
     * up either way, which is the number that actually has to hold.
     */
    private qualityFor;
    /**
     * Applied through the sender's parameters rather than by touching the
     * track, so the encoder changes its mind mid-call without a fresh offer
     * and answer. Runs whenever the peer count moves.
     */
    private applyVideoQuality;
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
export type StandaloneMediaOptions = {
    supabase: SupabaseClient;
    /** Any stable string shared by everyone who should hear each other. */
    roomId: string;
    /** This player's id. Must be unique per participant and stable for the call. */
    playerId: string;
    iceServers?: RTCIceServer[];
    videoQuality?: (peers: number) => VideoQuality;
    peerGraceMs?: number;
    audioConstraints?: MediaTrackConstraints;
};
/**
 * A voice mesh without the rest of foyer.
 *
 * Plenty of apps already have their own rooms and identity and want only this
 * part. Requiring them to adopt foyer's room model to get a microphone would
 * be a poor trade, so the mesh is constructible on its own: it needs a channel
 * name and a stable id, and nothing else foyer owns.
 */
export declare const createMediaMesh: (options: StandaloneMediaOptions) => MediaMesh;

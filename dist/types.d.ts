import type { SupabaseClient } from '@supabase/supabase-js';
/**
 * A player. `name` is a display name, not an identity: two players may share
 * one, and a player may change theirs. `id` is the identity, and it is the
 * Supabase auth user id, so row-level security can reason about it.
 */
export type Player = {
    id: string;
    name: string;
};
/** A player as seen inside a room, with whatever state your app hung on them. */
export type RoomPlayer<TState = Record<string, unknown>> = Player & {
    isHost: boolean;
    state: TState;
    joinedAt: string;
};
/**
 * A room. `metadata` is yours: foyer stores it, broadcasts changes to it, and
 * lets only the host write it, but never reads it. A map name, a time control,
 * a difficulty -- all metadata.
 */
export type Room<TMeta = Record<string, unknown>> = {
    id: string;
    code: string;
    name: string;
    hostId: string;
    maxPlayers: number;
    metadata: TMeta;
    status: string;
    isOpen: boolean;
    playerCount: number;
    hostName: string;
    createdAt: string;
};
export type Message = {
    id: number;
    playerId: string | null;
    playerName: string;
    body: string;
    /** A join/leave notice rather than something a player typed. */
    system: boolean;
    createdAt: string;
};
/**
 * How peers are wired to each other.
 *
 * This is the choice that quietly ruins multiplayer apps, so foyer makes you
 * state it.
 *
 * - `star` -- everyone connects to the host and nobody else. Correct when one
 *   peer is authoritative, as in a client/server game where the host *is* the
 *   server. Cheap: n-1 connections.
 * - `mesh` -- everyone connects to everyone. Correct when peers must reach
 *   each other directly, as in voice chat, where a star means everyone hears
 *   the host and nobody hears anyone else. Costs n(n-1)/2 connections.
 *
 * Picking the wrong one produces a system that connects perfectly and is
 * subtly useless, which is much harder to debug than a system that fails.
 */
export type Topology = 'star' | 'mesh';
/**
 * What a sender should aim for, given how many peers are receiving.
 *
 * `scaleResolutionDownBy` of 2 halves each dimension, so a quarter of the
 * pixels. Both are applied through the sender's parameters, which take effect
 * without renegotiating.
 */
export type VideoQuality = {
    maxBitrate: number;
    scaleResolutionDownBy: number;
};
export type FoyerOptions = {
    supabase: SupabaseClient;
    /**
     * Table prefix, so several apps can share one Supabase project. Must match
     * the prefix in schema.sql.
     */
    prefix?: string;
    /** Defaults to a public STUN server. No TURN: peers behind symmetric NAT will not connect. */
    iceServers?: RTCIceServer[];
    /**
     * Project URL and anon key.
     *
     * Only used to release a player's seat from a closing tab, which has to be
     * a raw keepalive fetch -- the supabase client cannot finish a normal
     * request during unload. Supply them and foyer never touches the client's
     * internals; omit them and it falls back to reading undocumented fields,
     * which works today and is not promised to keep working.
     */
    url?: string;
    anonKey?: string;
    /**
     * Video quality as a function of how many peers are receiving.
     *
     * A mesh multiplies a stream by its audience, so quality cannot sensibly be
     * fixed. The default trades resolution for headcount and lands around a
     * megabit up whatever the room size, which suits small tiles. An app that
     * wants something else -- a two-person call that should look good, a wall
     * of thumbnails that need not -- replaces the whole curve.
     */
    videoQuality?: (peers: number) => VideoQuality;
    /**
     * Room code length. Five is short enough to read aloud and long enough that
     * collisions are not a worry at small scale; a busier deployment may want
     * more.
     */
    codeLength?: number;
    /**
     * The alphabet codes are drawn from. The default omits O/0 and I/1, which
     * are the pairs people mishear and mistype. Replace it to add characters or
     * to remove more.
     */
    codeAlphabet?: string;
    /**
     * How long to wait before believing a peer has gone.
     *
     * Presence is the only signal for a browser that vanished without saying
     * anything, but it also fires for a connection that merely stumbled. Zero
     * drops immediately, which suits a LAN and punishes a phone on a train.
     */
    peerGraceMs?: number;
    /**
     * Microphone constraints for the default capture.
     *
     * Echo cancellation and noise suppression are assumed on, which is right
     * for talking and wrong for sending music. Ignored when you pass your own
     * constraints or your own stream to start().
     */
    audioConstraints?: MediaTrackConstraints;
    /**
     * Hand a room to someone else when its host leaves, rather than closing it.
     *
     * Off by default, because whether a host is replaceable depends entirely on
     * the app. A game whose host is also the server should let the room die
     * with it; a conversation should carry on. The longest-present player is
     * promoted, which every client works out identically.
     */
    hostMigration?: boolean;
};
export type CreateRoomOptions<TMeta> = {
    name?: string;
    metadata?: TMeta;
    maxPlayers?: number;
    status?: string;
};
/** Unsubscribes a live subscription. Safe to call twice. */
export type Unsubscribe = () => void;

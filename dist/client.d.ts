import type { SupabaseClient } from '@supabase/supabase-js';
import type { CreateRoomOptions, FoyerOptions, Player, Room, Unsubscribe, VideoQuality } from './types.js';
import { RoomHandle } from './room.js';
import { type QueueOptions, type QueuePeer } from './queue.js';
/** Internal handle passed to rooms so they inherit configuration. */
export type FoyerContext = {
    supabase: SupabaseClient;
    table: (name: string) => string;
    iceServers: RTCIceServer[];
    requirePlayer: () => Player;
    /** Resolved once: options first, the client's own fields only as a fallback. */
    rest: {
        url: string;
        key: string;
    } | null;
    videoQuality: ((peers: number) => VideoQuality) | null;
    graceMs: number;
    audioConstraints: MediaTrackConstraints | undefined;
    hostMigration: boolean;
};
export declare class Foyer {
    private readonly supabase;
    private readonly prefix;
    private readonly ice;
    private readonly rest;
    private readonly quality;
    private readonly codeLength;
    private readonly codeAlphabet;
    private readonly graceMs;
    private readonly audio;
    private readonly migrate;
    private current;
    constructor(options: FoyerOptions);
    /** The signed-in player, or null. */
    get player(): Player | null;
    private table;
    private context;
    /**
     * Signs in and ensures a profile row.
     *
     * Anonymous by default, because asking for an email before someone has
     * played once loses most of them. The row is keyed to the auth user, so an
     * anonymous player who later claims a real account keeps their history
     * rather than starting again.
     *
     * Calling this again with a different name renames the existing player; it
     * does not create a second one.
     */
    signIn: (name: string) => Promise<Player>;
    /** True if this browser already has a session, so sign-in can be skipped. */
    hasSession: () => Promise<boolean>;
    /** Signs out and forgets the player. The profile row and its history remain. */
    signOut: () => Promise<void>;
    /** Open rooms, newest first. */
    listRooms: <TMeta = Record<string, unknown>>() => Promise<Room<TMeta>[]>;
    /** Live room list. Fires on any change to a room or its player count. */
    onRooms: (onChange: () => void) => Unsubscribe;
    createRoom: <TMeta = Record<string, unknown>>(options?: CreateRoomOptions<TMeta>) => Promise<RoomHandle<TMeta>>;
    /** Joins by room id or by the short code, whichever you have. */
    join: <TMeta = Record<string, unknown>>(idOrCode: string) => Promise<RoomHandle<TMeta>>;
    /**
     * Pairs with whoever is waiting, or waits to be paired with.
     *
     * The other way to meet someone: `join` needs a room you already know
     * about, this needs nothing. Anonymous on purpose -- it never touches
     * profiles or auth, because the apps that want random pairing hold no
     * accounts and want none.
     */
    queue: (options?: QueueOptions) => Promise<QueuePeer>;
    private toRoom;
}
export declare const createFoyer: (options: FoyerOptions) => Foyer;

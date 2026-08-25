import type { SupabaseClient } from '@supabase/supabase-js';
import type { CreateRoomOptions, FoyerOptions, Player, Room, Unsubscribe } from './types.js';
import { RoomHandle } from './room.js';
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
};
export declare class Foyer {
    private readonly supabase;
    private readonly prefix;
    private readonly ice;
    private readonly rest;
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
    private toRoom;
}
export declare const createFoyer: (options: FoyerOptions) => Foyer;

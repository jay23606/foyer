import type { FoyerContext } from './client.js';
import type { Message, Room, RoomPlayer, Unsubscribe } from './types.js';
import { PeerNet, type PeerOptions } from './net.js';
import { MediaMesh } from './voice.js';
type Events = {
    players: RoomPlayer[];
    host: string;
    metadata: unknown;
    status: string;
    message: Message;
    closed: void;
};
type Listener<K extends keyof Events> = (payload: Events[K]) => void;
/**
 * A room you are in.
 *
 * Everything here is a lobby concern: who is present, what the settings are,
 * what has been said, and who is no longer welcome. Peer connections and voice
 * are separate, deliberately -- they attach to a room rather than being part
 * of it, so an app that only wants a lobby never opens a peer connection, and
 * a failure in one cannot disturb the other.
 */
export declare class RoomHandle<TMeta = Record<string, unknown>> {
    private readonly ctx;
    private data;
    private roster;
    private channel;
    private listeners;
    private unloadHandler;
    private heartbeat;
    private accessToken;
    private net;
    private mesh;
    constructor(ctx: FoyerContext, room: Room<TMeta>);
    get id(): string;
    get code(): string;
    get name(): string;
    get status(): string;
    get metadata(): TMeta;
    get hostId(): string;
    get maxPlayers(): number;
    get isOpen(): boolean;
    get createdAt(): string;
    get players(): RoomPlayer[];
    get isHost(): boolean;
    on: <K extends keyof Events>(event: K, listener: Listener<K>) => Unsubscribe;
    private emit;
    /** Called by the client on create/join; you do not normally call this. */
    join: () => Promise<void>;
    leave: () => Promise<void>;
    /**
     * Says goodbye when the tab goes away, and proves we are still here while
     * it has not.
     *
     * Three mechanisms, each covering the way the one before it fails:
     *
     *  - `leave()` is the clean path, and the only one that always works.
     *  - The unload beacon catches a closing tab. Best effort by nature --
     *    browsers are entitled to skip these handlers entirely.
     *  - The heartbeat is what lets the database work it out unaided. Stop
     *    bumping last_seen and foyer_reap_rooms deletes the row, firing the
     *    same trigger a clean leave would have.
     *
     * The beacon must carry the *user's* token rather than the anon key. The
     * delete policy is `auth.uid() = player_id`, so an anon request matches no
     * rows and PostgREST answers 204 regardless -- a silent no-op indis-
     * tinguishable from success. The token is cached because an unload handler
     * cannot await getSession.
     */
    private watchUnload;
    private teardown;
    private refreshPlayers;
    private subscribe;
    /** Host only; the database enforces it. */
    update: (patch: Partial<{
        metadata: TMeta;
        status: string;
        name: string;
        isOpen: boolean;
    }>) => Promise<void>;
    /** Your own per-player blob: a colour, a team, a download percentage. */
    setPlayerState: (state: Record<string, unknown>) => Promise<void>;
    say: (body: string, system?: boolean) => Promise<void>;
    history: (limit?: number) => Promise<Message[]>;
    /** Removes a player. They may rejoin; use ban if they should not. */
    kick: (playerId: string) => Promise<void>;
    /**
     * Removes a player and refuses the rejoin at the database.
     *
     * This is the reason foyer needs Postgres rather than only a data channel:
     * a ban a client can ignore is not a ban.
     */
    ban: (playerId: string) => Promise<void>;
    unban: (playerId: string) => Promise<void>;
    /**
     * Opens peer connections for this room.
     *
     * Separate from the room on purpose: an app that only wants a lobby never
     * opens a peer connection, and one that wants both keeps them independent.
     * You must choose a topology -- see the note on `Topology` for why that is
     * not defaulted.
     */
    connect: (options: PeerOptions) => Promise<PeerNet>;
    /**
     * The voice mesh for this room, created on first use.
     *
     * Nothing happens until you call `start()`, which must come from a user
     * gesture. Always a mesh and always its own connections -- see voice.ts.
     */
    voice: () => MediaMesh;
    /**
     * The same mesh under the name that fits when it carries pictures.
     *
     * `start({ audio: true, video: true })` and listen with `onStream`; a mesh
     * carrying video does not play itself, because only the app knows where the
     * picture goes.
     */
    media: () => MediaMesh;
}
export {};

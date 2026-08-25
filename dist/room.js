import { PeerNet } from './net.js';
import { VoiceMesh } from './voice.js';
/**
 * A room you are in.
 *
 * Everything here is a lobby concern: who is present, what the settings are,
 * what has been said, and who is no longer welcome. Peer connections and voice
 * are separate, deliberately -- they attach to a room rather than being part
 * of it, so an app that only wants a lobby never opens a peer connection, and
 * a failure in one cannot disturb the other.
 */
export class RoomHandle {
    ctx;
    data;
    roster = [];
    channel = null;
    listeners = new Map();
    unloadHandler = null;
    net = null;
    mesh = null;
    constructor(ctx, room) {
        this.ctx = ctx;
        this.data = room;
    }
    get id() { return this.data.id; }
    get code() { return this.data.code; }
    get name() { return this.data.name; }
    get status() { return this.data.status; }
    get metadata() { return this.data.metadata; }
    get hostId() { return this.data.hostId; }
    get maxPlayers() { return this.data.maxPlayers; }
    get isOpen() { return this.data.isOpen; }
    get createdAt() { return this.data.createdAt; }
    get players() { return this.roster; }
    get isHost() { return this.ctx.requirePlayer().id === this.data.hostId; }
    on = (event, listener) => {
        const set = this.listeners.get(event) ?? new Set();
        set.add(listener);
        this.listeners.set(event, set);
        return () => { set.delete(listener); };
    };
    emit = (event, payload) => {
        this.listeners.get(event)?.forEach(l => l(payload));
    };
    // ------------------------------------------------------------- lifecycle
    /** Called by the client on create/join; you do not normally call this. */
    join = async () => {
        const player = this.ctx.requirePlayer();
        // A banned player's insert is refused by the policy, not by us asking
        // politely -- so a rejection here is the ban working, not a bug.
        const { error } = await this.ctx.supabase
            .from(this.ctx.table('room_players'))
            .upsert({
            room_id: this.id,
            player_id: player.id,
            is_host: player.id === this.data.hostId,
        }, { onConflict: 'room_id,player_id', ignoreDuplicates: true });
        if (error)
            throw new Error(`foyer: could not join (${error.message})`);
        await this.refreshPlayers();
        this.subscribe();
        this.watchUnload();
        await this.say(`${player.name} joined`, true);
    };
    leave = async () => {
        const player = this.ctx.requirePlayer();
        await this.say(`${player.name} left`, true);
        this.teardown();
        await this.ctx.supabase
            .from(this.ctx.table('room_players'))
            .delete()
            .eq('room_id', this.id)
            .eq('player_id', player.id);
    };
    /**
     * A closing tab sends no goodbye, so the row would linger and the room
     * would look occupied. keepalive lets the request outlive the page.
     */
    watchUnload = () => {
        if (typeof window === 'undefined')
            return;
        const rest = this.ctx.rest;
        if (!rest)
            return;
        const player = this.ctx.requirePlayer();
        this.unloadHandler = () => {
            // A normal supabase call cannot finish during unload; keepalive lets
            // this one outlive the page. Best effort -- presence and the reaper
            // both cover the case where it does not land.
            void fetch(`${rest.url}/rest/v1/${this.ctx.table('room_players')}`
                + `?room_id=eq.${this.id}&player_id=eq.${player.id}`, {
                method: 'DELETE',
                keepalive: true,
                headers: { apikey: rest.key, Authorization: `Bearer ${rest.key}` },
            }).catch(() => { });
        };
        window.addEventListener('beforeunload', this.unloadHandler);
    };
    teardown = () => {
        this.net?.close();
        this.net = null;
        this.mesh?.stop();
        this.mesh = null;
        if (this.unloadHandler && typeof window !== 'undefined') {
            window.removeEventListener('beforeunload', this.unloadHandler);
            this.unloadHandler = null;
        }
        if (this.channel) {
            void this.ctx.supabase.removeChannel(this.channel);
            this.channel = null;
        }
    };
    // -------------------------------------------------------------- presence
    refreshPlayers = async () => {
        const { data, error } = await this.ctx.supabase
            .from(this.ctx.table('room_players'))
            .select(`player_id, is_host, state, joined_at, profile:${this.ctx.table('profiles')}(name)`)
            .eq('room_id', this.id)
            .order('joined_at');
        if (error)
            return;
        this.roster = (data ?? []).map((row) => ({
            id: row.player_id,
            name: row.profile?.name ?? 'unknown',
            isHost: row.is_host,
            state: row.state ?? {},
            joinedAt: row.joined_at,
        }));
        this.emit('players', this.roster);
    };
    subscribe = () => {
        const self = this.ctx.requirePlayer();
        this.channel = this.ctx.supabase
            .channel(`foyer:room:${this.id}`, { config: { presence: { key: self.id } } })
            .on('postgres_changes', { event: '*', schema: 'public', table: this.ctx.table('room_players'), filter: `room_id=eq.${this.id}` }, () => { void this.refreshPlayers(); })
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: this.ctx.table('rooms'), filter: `id=eq.${this.id}` }, ({ new: row }) => {
            const wasOpen = this.data.isOpen;
            this.data = { ...this.data, metadata: row.metadata, status: row.status, isOpen: row.is_open };
            this.emit('metadata', row.metadata);
            this.emit('status', row.status);
            if (wasOpen && !row.is_open)
                this.emit('closed', undefined);
        })
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: this.ctx.table('messages'), filter: `room_id=eq.${this.id}` }, ({ new: row }) => {
            this.emit('message', {
                id: row.id,
                playerId: row.player_id,
                playerName: this.roster.find(p => p.id === row.player_id)?.name ?? 'unknown',
                body: row.body,
                system: row.system,
                createdAt: row.created_at,
            });
        })
            // A crashed tab, a dropped network or a closed laptop sends no
            // goodbye, and its unload fetch never ran. Presence notices within
            // seconds; the row would otherwise sit there until the reaper, with
            // the room looking fuller than it is.
            .on('presence', { event: 'leave' }, ({ key }) => {
            if (key === self.id)
                return;
            if (!this.roster.some(p => p.id === key))
                return;
            // Only the host writes the correction, or every remaining player
            // would race to issue the same delete.
            if (this.isHost)
                void this.kick(key);
            else
                void this.refreshPlayers();
        })
            .subscribe(status => {
            if (status === 'SUBSCRIBED')
                void this.channel?.track({ id: self.id });
        });
    };
    // --------------------------------------------------------------- writing
    /** Host only; the database enforces it. */
    update = async (patch) => {
        const row = { updated_at: new Date().toISOString() };
        if (patch.metadata !== undefined)
            row.metadata = patch.metadata;
        if (patch.status !== undefined)
            row.status = patch.status;
        if (patch.name !== undefined)
            row.name = patch.name;
        if (patch.isOpen !== undefined)
            row.is_open = patch.isOpen;
        const { error } = await this.ctx.supabase
            .from(this.ctx.table('rooms')).update(row).eq('id', this.id);
        if (error)
            throw new Error(`foyer: could not update room (${error.message})`);
    };
    /** Your own per-player blob: a colour, a team, a download percentage. */
    setPlayerState = async (state) => {
        const player = this.ctx.requirePlayer();
        await this.ctx.supabase
            .from(this.ctx.table('room_players'))
            .update({ state })
            .eq('room_id', this.id)
            .eq('player_id', player.id);
    };
    say = async (body, system = false) => {
        const player = this.ctx.requirePlayer();
        const text = body.trim().slice(0, 500);
        if (!text)
            return;
        await this.ctx.supabase.from(this.ctx.table('messages')).insert({
            room_id: this.id, player_id: player.id, body: text, system,
        });
    };
    history = async (limit = 100) => {
        const { data } = await this.ctx.supabase
            .from(this.ctx.table('messages'))
            .select(`id, player_id, body, system, created_at, profile:${this.ctx.table('profiles')}(name)`)
            .eq('room_id', this.id)
            .order('created_at', { ascending: true })
            .limit(limit);
        return (data ?? []).map((row) => ({
            id: row.id,
            playerId: row.player_id,
            playerName: row.profile?.name ?? 'unknown',
            body: row.body,
            system: row.system,
            createdAt: row.created_at,
        }));
    };
    // ------------------------------------------------------------ moderation
    /** Removes a player. They may rejoin; use ban if they should not. */
    kick = async (playerId) => {
        await this.ctx.supabase
            .from(this.ctx.table('room_players'))
            .delete().eq('room_id', this.id).eq('player_id', playerId);
    };
    /**
     * Removes a player and refuses the rejoin at the database.
     *
     * This is the reason foyer needs Postgres rather than only a data channel:
     * a ban a client can ignore is not a ban.
     */
    ban = async (playerId) => {
        await this.ctx.supabase
            .from(this.ctx.table('bans'))
            .upsert({ room_id: this.id, player_id: playerId }, { onConflict: 'room_id,player_id' });
        await this.kick(playerId);
    };
    unban = async (playerId) => {
        await this.ctx.supabase
            .from(this.ctx.table('bans'))
            .delete().eq('room_id', this.id).eq('player_id', playerId);
    };
    // ----------------------------------------------------------------- peers
    /**
     * Opens peer connections for this room.
     *
     * Separate from the room on purpose: an app that only wants a lobby never
     * opens a peer connection, and one that wants both keeps them independent.
     * You must choose a topology -- see the note on `Topology` for why that is
     * not defaulted.
     */
    connect = async (options) => {
        this.net?.close();
        this.net = new PeerNet(this.ctx, this.id, this.data.hostId, options);
        await this.net.connect();
        return this.net;
    };
    /**
     * The voice mesh for this room, created on first use.
     *
     * Nothing happens until you call `start()`, which must come from a user
     * gesture. Always a mesh and always its own connections -- see voice.ts.
     */
    voice = () => {
        this.mesh ??= new VoiceMesh(this.ctx, this.id);
        return this.mesh;
    };
    /**
     * The same mesh under the name that fits when it carries pictures.
     *
     * `start({ audio: true, video: true })` and listen with `onStream`; a mesh
     * carrying video does not play itself, because only the app knows where the
     * picture goes.
     */
    media = () => this.voice();
}

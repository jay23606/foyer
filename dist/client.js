import { RoomHandle } from './room.js';
import { makeCode } from './codes.js';
import { pair } from './queue.js';
const DEFAULT_PREFIX = 'foyer_';
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
export class Foyer {
    supabase;
    prefix;
    ice;
    rest;
    quality;
    codeLength;
    codeAlphabet;
    graceMs;
    audio;
    current = null;
    constructor(options) {
        this.supabase = options.supabase;
        this.prefix = options.prefix ?? DEFAULT_PREFIX;
        this.ice = options.iceServers ?? DEFAULT_ICE;
        // Reading supabaseUrl/supabaseKey off the client is undocumented. It is
        // the fallback rather than the plan, and if it ever stops working the
        // fix is to pass url/anonKey explicitly.
        const loose = options.supabase;
        const url = options.url ?? loose.supabaseUrl;
        const key = options.anonKey ?? loose.supabaseKey;
        this.rest = url && key ? { url, key } : null;
        this.quality = options.videoQuality ?? null;
        this.codeLength = options.codeLength ?? 5;
        this.codeAlphabet = options.codeAlphabet;
        this.graceMs = options.peerGraceMs ?? 0;
        this.audio = options.audioConstraints;
    }
    /** The signed-in player, or null. */
    get player() { return this.current; }
    table = (name) => `${this.prefix}${name}`;
    context = () => ({
        supabase: this.supabase,
        table: this.table,
        iceServers: this.ice,
        rest: this.rest,
        videoQuality: this.quality,
        graceMs: this.graceMs,
        audioConstraints: this.audio,
        requirePlayer: () => {
            if (!this.current)
                throw new Error('foyer: not signed in');
            return this.current;
        },
    });
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
    signIn = async (name) => {
        const trimmed = name.trim().slice(0, 32);
        if (!trimmed)
            throw new Error('foyer: a name is required');
        let { data: session } = await this.supabase.auth.getSession();
        if (!session.session) {
            const { error } = await this.supabase.auth.signInAnonymously();
            if (error)
                throw error;
            session = (await this.supabase.auth.getSession()).data;
        }
        const id = session.session?.user.id;
        if (!id)
            throw new Error('foyer: sign-in produced no user');
        const { error } = await this.supabase
            .from(this.table('profiles'))
            .upsert({ id, name: trimmed }, { onConflict: 'id' });
        if (error)
            throw error;
        this.current = { id, name: trimmed };
        return this.current;
    };
    /** True if this browser already has a session, so sign-in can be skipped. */
    hasSession = async () => {
        const { data } = await this.supabase.auth.getSession();
        return Boolean(data.session);
    };
    /** Signs out and forgets the player. The profile row and its history remain. */
    signOut = async () => {
        await this.supabase.auth.signOut();
        this.current = null;
    };
    // ----------------------------------------------------------------- lobby
    /** Open rooms, newest first. */
    listRooms = async () => {
        const { data, error } = await this.supabase
            .from(this.table('rooms'))
            .select(`*, ${this.table('room_players')}(count), host:${this.table('profiles')}!${this.table('rooms')}_host_id_fkey(name)`)
            .eq('is_open', true)
            .order('created_at', { ascending: false });
        if (error)
            throw error;
        return (data ?? []).map(row => this.toRoom(row));
    };
    /** Live room list. Fires on any change to a room or its player count. */
    onRooms = (onChange) => {
        const channel = this.supabase
            .channel('foyer:lobby')
            .on('postgres_changes', { event: '*', schema: 'public', table: this.table('rooms') }, () => onChange())
            .on('postgres_changes', { event: '*', schema: 'public', table: this.table('room_players') }, () => onChange())
            .subscribe();
        return () => { void this.supabase.removeChannel(channel); };
    };
    createRoom = async (options = {}) => {
        const player = this.context().requirePlayer();
        const { data, error } = await this.supabase
            .from(this.table('rooms'))
            .insert({
            code: makeCode(this.codeLength, this.codeAlphabet),
            name: options.name ?? '',
            host_id: player.id,
            max_players: options.maxPlayers ?? 8,
            metadata: options.metadata ?? {},
            status: options.status ?? 'lobby',
        })
            .select()
            .single();
        if (error)
            throw error;
        const handle = new RoomHandle(this.context(), this.toRoom(data));
        await handle.join();
        return handle;
    };
    /** Joins by room id or by the short code, whichever you have. */
    join = async (idOrCode) => {
        const byCode = idOrCode.length <= 8;
        const { data, error } = await this.supabase
            .from(this.table('rooms'))
            .select('*')
            .eq(byCode ? 'code' : 'id', byCode ? idOrCode.toUpperCase() : idOrCode)
            .maybeSingle();
        if (error)
            throw error;
        if (!data)
            throw new Error('foyer: no such room');
        const handle = new RoomHandle(this.context(), this.toRoom(data));
        await handle.join();
        return handle;
    };
    // ----------------------------------------------------------------- queue
    /**
     * Pairs with whoever is waiting, or waits to be paired with.
     *
     * The other way to meet someone: `join` needs a room you already know
     * about, this needs nothing. Anonymous on purpose -- it never touches
     * profiles or auth, because the apps that want random pairing hold no
     * accounts and want none.
     */
    queue = (options = {}) => pair(this.supabase, { prefix: this.prefix, iceServers: this.ice, ...options });
    toRoom = (row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        hostId: row.host_id,
        maxPlayers: row.max_players,
        metadata: (row.metadata ?? {}),
        status: row.status,
        isOpen: row.is_open,
        // Both are present only when the query asked for them, which listRooms
        // does and a single-row read does not.
        playerCount: row[this.table('room_players')]?.[0]?.count ?? 0,
        hostName: row.host?.name ?? 'unknown',
        createdAt: row.created_at,
    });
}
export const createFoyer = (options) => new Foyer(options);

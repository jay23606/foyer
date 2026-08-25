import type { RealtimeChannel } from '@supabase/supabase-js'
import type { FoyerContext } from './client.js'
import type { Message, Room, RoomPlayer, Unsubscribe } from './types.js'
import { PeerNet, type PeerOptions } from './net.js'
import { MediaMesh } from './voice.js'

type Events = {
	players: RoomPlayer[]
	host: string
	metadata: unknown
	status: string
	message: Message
	closed: void
}

type Listener<K extends keyof Events> = (payload: Events[K]) => void

/**
 * A room you are in.
 *
 * Everything here is a lobby concern: who is present, what the settings are,
 * what has been said, and who is no longer welcome. Peer connections and voice
 * are separate, deliberately -- they attach to a room rather than being part
 * of it, so an app that only wants a lobby never opens a peer connection, and
 * a failure in one cannot disturb the other.
 */
export class RoomHandle<TMeta = Record<string, unknown>> {
	private readonly ctx: FoyerContext
	private data: Room<TMeta>
	private roster: RoomPlayer[] = []
	private channel: RealtimeChannel | null = null
	private listeners = new Map<keyof Events, Set<Listener<never>>>()
	private unloadHandler: (() => void) | null = null
	private net: PeerNet | null = null
	private mesh: MediaMesh | null = null

	constructor(ctx: FoyerContext, room: Room<TMeta>) {
		this.ctx = ctx
		this.data = room
	}

	get id(): string { return this.data.id }
	get code(): string { return this.data.code }
	get name(): string { return this.data.name }
	get status(): string { return this.data.status }
	get metadata(): TMeta { return this.data.metadata }
	get hostId(): string { return this.data.hostId }
	get maxPlayers(): number { return this.data.maxPlayers }
	get isOpen(): boolean { return this.data.isOpen }
	get createdAt(): string { return this.data.createdAt }
	get players(): RoomPlayer[] { return this.roster }
	get isHost(): boolean { return this.ctx.requirePlayer().id === this.data.hostId }

	on = <K extends keyof Events>(event: K, listener: Listener<K>): Unsubscribe => {
		const set = this.listeners.get(event) ?? new Set()
		set.add(listener as Listener<never>)
		this.listeners.set(event, set)
		return () => { set.delete(listener as Listener<never>) }
	}

	private emit = <K extends keyof Events>(event: K, payload: Events[K]): void => {
		this.listeners.get(event)?.forEach(l => (l as Listener<K>)(payload))
	}

	// ------------------------------------------------------------- lifecycle

	/** Called by the client on create/join; you do not normally call this. */
	join = async (): Promise<void> => {
		const player = this.ctx.requirePlayer()

		// A banned player's insert is refused by the policy, not by us asking
		// politely -- so a rejection here is the ban working, not a bug.
		const { error } = await this.ctx.supabase
			.from(this.ctx.table('room_players'))
			.upsert(
				{
					room_id: this.id,
					player_id: player.id,
					is_host: player.id === this.data.hostId,
				},
				{ onConflict: 'room_id,player_id', ignoreDuplicates: true }
			)
		if (error) throw new Error(`foyer: could not join (${error.message})`)

		await this.refreshPlayers()
		this.subscribe()
		this.watchUnload()
		await this.say(`${player.name} joined`, true)
	}

	leave = async (): Promise<void> => {
		const player = this.ctx.requirePlayer()
		await this.say(`${player.name} left`, true)
		this.teardown()
		await this.ctx.supabase
			.from(this.ctx.table('room_players'))
			.delete()
			.eq('room_id', this.id)
			.eq('player_id', player.id)
	}

	/**
	 * A closing tab sends no goodbye, so the row would linger and the room
	 * would look occupied. keepalive lets the request outlive the page.
	 */
	private watchUnload = (): void => {
		if (typeof window === 'undefined') return
		const rest = this.ctx.rest
		if (!rest) return
		const player = this.ctx.requirePlayer()
		this.unloadHandler = () => {
			// A normal supabase call cannot finish during unload; keepalive lets
			// this one outlive the page. Best effort -- presence and the reaper
			// both cover the case where it does not land.
			void fetch(
				`${rest.url}/rest/v1/${this.ctx.table('room_players')}`
					+ `?room_id=eq.${this.id}&player_id=eq.${player.id}`,
				{
					method: 'DELETE',
					keepalive: true,
					headers: { apikey: rest.key, Authorization: `Bearer ${rest.key}` },
				}
			).catch(() => { /* the reaper will get it */ })
		}
		window.addEventListener('beforeunload', this.unloadHandler)
	}

	private teardown = (): void => {
		this.net?.close()
		this.net = null
		this.mesh?.stop()
		this.mesh = null
		if (this.unloadHandler && typeof window !== 'undefined') {
			window.removeEventListener('beforeunload', this.unloadHandler)
			this.unloadHandler = null
		}
		if (this.channel) {
			void this.ctx.supabase.removeChannel(this.channel)
			this.channel = null
		}
	}

	// -------------------------------------------------------------- presence

	private refreshPlayers = async (): Promise<void> => {
		const { data, error } = await this.ctx.supabase
			.from(this.ctx.table('room_players'))
			.select(`player_id, is_host, state, joined_at, profile:${this.ctx.table('profiles')}(name)`)
			.eq('room_id', this.id)
			.order('joined_at')
		if (error) return

		this.roster = (data ?? []).map((row: any) => ({
			id: row.player_id,
			name: row.profile?.name ?? 'unknown',
			isHost: row.is_host,
			state: row.state ?? {},
			joinedAt: row.joined_at,
		}))
		this.emit('players', this.roster)

		// The host's seat is empty. Everyone notices at once and everyone asks;
		// the function promotes the longest-present player and tells the rest
		// there was nothing to do, so the duplicate calls cost a round trip and
		// change nothing.
		if (
			this.ctx.hostMigration &&
			this.roster.length > 0 &&
			!this.roster.some(p => p.id === this.data.hostId)
		) {
			const { data: promoted } = await this.ctx.supabase
				.rpc(`${this.ctx.table('promote_host')}`, { target_room: this.id })
			if (promoted) {
				this.data = { ...this.data, hostId: promoted as string }
				this.emit('host', promoted as string)
				void this.refreshPlayers()
			}
		}
	}

	private subscribe = (): void => {
		const self = this.ctx.requirePlayer()
		this.channel = this.ctx.supabase
			.channel(`foyer:room:${this.id}`, { config: { presence: { key: self.id } } })
			.on('postgres_changes',
				{ event: '*', schema: 'public', table: this.ctx.table('room_players'), filter: `room_id=eq.${this.id}` },
				() => { void this.refreshPlayers() })
			.on('postgres_changes',
				{ event: 'UPDATE', schema: 'public', table: this.ctx.table('rooms'), filter: `id=eq.${this.id}` },
				({ new: row }: any) => {
					const wasOpen = this.data.isOpen
					const hostChanged = row.host_id !== this.data.hostId
					this.data = {
						...this.data,
						metadata: row.metadata,
						status: row.status,
						isOpen: row.is_open,
						hostId: row.host_id,
					}
					if (hostChanged) this.emit('host', row.host_id)
					this.emit('metadata', row.metadata)
					this.emit('status', row.status)
					if (wasOpen && !row.is_open) this.emit('closed', undefined)
				})
			.on('postgres_changes',
				{ event: 'INSERT', schema: 'public', table: this.ctx.table('messages'), filter: `room_id=eq.${this.id}` },
				({ new: row }: any) => {
					this.emit('message', {
						id: row.id,
						playerId: row.player_id,
						playerName: this.roster.find(p => p.id === row.player_id)?.name ?? 'unknown',
						body: row.body,
						system: row.system,
						createdAt: row.created_at,
					})
				})
			// A crashed tab, a dropped network or a closed laptop sends no
			// goodbye, and its unload fetch never ran. Presence notices within
			// seconds; the row would otherwise sit there until the reaper, with
			// the room looking fuller than it is.
			.on('presence', { event: 'leave' }, ({ key }: { key: string }) => {
				if (key === self.id) return
				// Only the host writes the correction, or every remaining player
				// would race to issue the same delete. Removing a seat is destructive
				// in a way dropping a connection is not -- the player has to rejoin --
				// so a stumble gets the same grace as elsewhere, re-checked against
				// presence once it has passed.
				const settle = (): void => {
					if (!this.roster.some(p => p.id === key)) return
					if (this.isHost) void this.kick(key)
					else void this.refreshPlayers()
				}
				if (this.ctx.graceMs <= 0) { settle(); return }
				setTimeout(() => {
					const present = Object.keys(this.channel?.presenceState() ?? {})
					if (!present.includes(key)) settle()
				}, this.ctx.graceMs)
			})
			.subscribe(status => {
				if (status === 'SUBSCRIBED') void this.channel?.track({ id: self.id })
			})
	}

	// --------------------------------------------------------------- writing

	/** Host only; the database enforces it. */
	update = async (patch: Partial<{ metadata: TMeta, status: string, name: string, isOpen: boolean }>): Promise<void> => {
		const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
		if (patch.metadata !== undefined) row.metadata = patch.metadata
		if (patch.status !== undefined) row.status = patch.status
		if (patch.name !== undefined) row.name = patch.name
		if (patch.isOpen !== undefined) row.is_open = patch.isOpen

		const { error } = await this.ctx.supabase
			.from(this.ctx.table('rooms')).update(row).eq('id', this.id)
		if (error) throw new Error(`foyer: could not update room (${error.message})`)
	}

	/** Your own per-player blob: a colour, a team, a download percentage. */
	setPlayerState = async (state: Record<string, unknown>): Promise<void> => {
		const player = this.ctx.requirePlayer()
		await this.ctx.supabase
			.from(this.ctx.table('room_players'))
			.update({ state })
			.eq('room_id', this.id)
			.eq('player_id', player.id)
	}

	say = async (body: string, system = false): Promise<void> => {
		const player = this.ctx.requirePlayer()
		const text = body.trim().slice(0, 500)
		if (!text) return
		await this.ctx.supabase.from(this.ctx.table('messages')).insert({
			room_id: this.id, player_id: player.id, body: text, system,
		})
	}

	history = async (limit = 100): Promise<Message[]> => {
		const { data } = await this.ctx.supabase
			.from(this.ctx.table('messages'))
			.select(`id, player_id, body, system, created_at, profile:${this.ctx.table('profiles')}(name)`)
			.eq('room_id', this.id)
			.order('created_at', { ascending: true })
			.limit(limit)
		return (data ?? []).map((row: any) => ({
			id: row.id,
			playerId: row.player_id,
			playerName: row.profile?.name ?? 'unknown',
			body: row.body,
			system: row.system,
			createdAt: row.created_at,
		}))
	}

	// ------------------------------------------------------------ moderation

	/** Removes a player. They may rejoin; use ban if they should not. */
	kick = async (playerId: string): Promise<void> => {
		await this.ctx.supabase
			.from(this.ctx.table('room_players'))
			.delete().eq('room_id', this.id).eq('player_id', playerId)
	}

	/**
	 * Removes a player and refuses the rejoin at the database.
	 *
	 * This is the reason foyer needs Postgres rather than only a data channel:
	 * a ban a client can ignore is not a ban.
	 */
	ban = async (playerId: string): Promise<void> => {
		await this.ctx.supabase
			.from(this.ctx.table('bans'))
			.upsert({ room_id: this.id, player_id: playerId }, { onConflict: 'room_id,player_id' })
		await this.kick(playerId)
	}

	unban = async (playerId: string): Promise<void> => {
		await this.ctx.supabase
			.from(this.ctx.table('bans'))
			.delete().eq('room_id', this.id).eq('player_id', playerId)
	}

	// ----------------------------------------------------------------- peers

	/**
	 * Opens peer connections for this room.
	 *
	 * Separate from the room on purpose: an app that only wants a lobby never
	 * opens a peer connection, and one that wants both keeps them independent.
	 * You must choose a topology -- see the note on `Topology` for why that is
	 * not defaulted.
	 */
	connect = async (options: PeerOptions): Promise<PeerNet> => {
		this.net?.close()
		this.net = new PeerNet(this.ctx, this.id, this.data.hostId, options)
		await this.net.connect()
		return this.net
	}

	/**
	 * The voice mesh for this room, created on first use.
	 *
	 * Nothing happens until you call `start()`, which must come from a user
	 * gesture. Always a mesh and always its own connections -- see voice.ts.
	 */
	voice = (): MediaMesh => {
		this.mesh ??= new MediaMesh(this.ctx, this.id)
		return this.mesh
	}

	/**
	 * The same mesh under the name that fits when it carries pictures.
	 *
	 * `start({ audio: true, video: true })` and listen with `onStream`; a mesh
	 * carrying video does not play itself, because only the app knows where the
	 * picture goes.
	 */
	media = (): MediaMesh => this.voice()
}

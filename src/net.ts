import type { RealtimeChannel } from '@supabase/supabase-js'
import type { FoyerContext } from './client.js'
import type { Topology, Unsubscribe } from './types.js'
import { isOfferer, shouldConnect } from './topology.js'

// Peer connections for a room.
//
// Signalling rides a Realtime channel of its own: a few dozen small messages
// per peer, once, at connect time. Everything after that goes directly between
// browsers and never touches Supabase again.
//
// Every signal carries an explicit `from` and `to` and each peer filters for
// itself. There is no server hop to rewrite addresses, so the addressing has
// to be in the payload.

const SIGNAL = 'peer-signal'

type Signal = {
	kind: 'hello' | 'sdp' | 'ice'
	from: string
	to: string | null
	data?: string
}

export type PeerOptions = {
	topology: Topology
	/**
	 * Passed straight to createDataChannel. The default is reliable and
	 * ordered, which is what most apps want.
	 *
	 * Realtime games usually do not: if your protocol already sequences and
	 * retries, an ordered channel head-of-line blocks and adds exactly the
	 * latency the protocol exists to avoid. `{ ordered: false, maxRetransmits: 0 }`
	 * is the usual choice there.
	 */
	channel?: RTCDataChannelInit
	label?: string
}

export type Peer = {
	id: string
	send: (data: string | ArrayBufferView | ArrayBuffer) => void
	close: () => void
	readonly open: boolean
}

type Events = {
	peer: Peer
	leave: string
	data: { from: string, data: unknown }
	error: Error
}

type Listener<K extends keyof Events> = (payload: Events[K]) => void

export class PeerNet {
	private readonly ctx: FoyerContext
	private readonly roomId: string
	private readonly selfId: string
	private readonly hostId: string
	private readonly opts: PeerOptions

	private channel: RealtimeChannel | null = null
	private connections = new Map<string, RTCPeerConnection>()
	private channels = new Map<string, RTCDataChannel>()
	// Candidates routinely arrive before the description they belong to;
	// adding one early throws, so they wait here.
	private pendingIce = new Map<string, RTCIceCandidateInit[]>()
	private listeners = new Map<keyof Events, Set<Listener<never>>>()
	// Attempts so far, per peer. Cleared the moment a connection succeeds, so
	// a link that fails twice a day is not treated as one that failed twice.
	private attempts = new Map<string, number>()

	constructor(ctx: FoyerContext, roomId: string, hostId: string, opts: PeerOptions) {
		this.ctx = ctx
		this.roomId = roomId
		this.hostId = hostId
		this.selfId = ctx.requirePlayer().id
		this.opts = opts
	}

	get peers(): string[] { return [...this.channels.keys()] }

	on = <K extends keyof Events>(event: K, listener: Listener<K>): Unsubscribe => {
		const set = this.listeners.get(event) ?? new Set()
		set.add(listener as Listener<never>)
		this.listeners.set(event, set)
		return () => { set.delete(listener as Listener<never>) }
	}

	private emit = <K extends keyof Events>(event: K, payload: Events[K]): void => {
		this.listeners.get(event)?.forEach(l => (l as Listener<K>)(payload))
	}

	// Both decisions live in topology.ts, where they can be tested without a
	// browser, a database and two live sessions.
	private shouldConnect = (peerId: string): boolean =>
		shouldConnect(this.opts.topology, this.selfId, this.hostId, peerId)

	private isOfferer = (peerId: string): boolean =>
		isOfferer(this.opts.topology, this.selfId, this.hostId, peerId)

	connect = async (): Promise<void> => {
		const channel = this.ctx.supabase.channel(`foyer:net:${this.roomId}`, {
			config: { broadcast: { self: false, ack: true }, presence: { key: this.selfId } },
		})

		channel.on('broadcast', { event: SIGNAL }, ({ payload }) => {
			void this.onSignal(payload as Signal)
		})

		// Presence is the safety net for peers that vanish without saying so --
		// a closed tab, a dropped network, a crashed browser.
		channel.on('presence', { event: 'leave' }, ({ key }: { key: string }) => {
			if (key === this.selfId) return
			// A peer that stumbled and came back should not lose its channel.
			if (this.ctx.graceMs <= 0) { this.drop(key); return }
			setTimeout(() => {
				const present = Object.keys(channel.presenceState())
				if (!present.includes(key)) this.drop(key)
			}, this.ctx.graceMs)
		})

		this.channel = channel

		await new Promise<void>((resolve, reject) => {
			channel.subscribe((status, err) => {
				if (status === 'SUBSCRIBED') {
					void channel.track({ id: this.selfId })
					resolve()
					return
				}
				if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
					reject(err ?? new Error(`foyer: peer signalling failed (${status})`))
				}
			})
		})

		// Announce arrival. Whoever should offer to us will now do so, and
		// whoever we should offer to is answered below.
		this.send({ kind: 'hello', from: this.selfId, to: null })
	}

	close = (): void => {
		this.channels.forEach(c => c.close())
		this.connections.forEach(c => c.close())
		this.channels.clear()
		this.connections.clear()
		this.pendingIce.clear()
		if (this.channel) {
			void this.ctx.supabase.removeChannel(this.channel)
			this.channel = null
		}
	}

	private send = (signal: Signal): void => {
		void this.channel?.send({ type: 'broadcast', event: SIGNAL, payload: signal })
	}

	private drop = (peerId: string): void => {
		this.channels.get(peerId)?.close()
		this.connections.get(peerId)?.close()
		const had = this.channels.delete(peerId)
		this.connections.delete(peerId)
		this.pendingIce.delete(peerId)
		this.attempts.delete(peerId)
		if (had) this.emit('leave', peerId)
	}

	/**
	 * Rebuilds a failed connection, or gives up and drops the peer.
	 *
	 * Only the side that offered retries. If both ends rebuilt at once they
	 * would collide exactly as two simultaneous offers do, so the same rule
	 * that settles who offers settles who reconnects.
	 *
	 * Presence is consulted first: there is no point rebuilding a connection to
	 * a browser that has closed.
	 */
	private retry = async (peerId: string): Promise<void> => {
		const tried = this.attempts.get(peerId) ?? 0
		const present = Object.keys(this.channel?.presenceState() ?? {})
		if (
			tried >= this.ctx.reconnectAttempts ||
			!present.includes(peerId) ||
			!this.isOfferer(peerId)
		) {
			this.drop(peerId)
			return
		}
		this.attempts.set(peerId, tried + 1)

		// Discard the dead connection without telling the app the peer left --
		// as far as it is concerned this one never went away.
		this.channels.get(peerId)?.close()
		this.connections.get(peerId)?.close()
		this.channels.delete(peerId)
		this.connections.delete(peerId)
		this.pendingIce.delete(peerId)

		// Each attempt waits longer, so a network that is still settling is not
		// hammered while it does.
		await new Promise(resolve => setTimeout(resolve, 500 * 2 ** tried))
		if (!this.channel) return
		try { await this.offerTo(peerId) }
		catch (err) { this.emit('error', err instanceof Error ? err : new Error(String(err))) }
	}

	private newConnection = (peerId: string): RTCPeerConnection => {
		const pc = new RTCPeerConnection({ iceServers: this.ctx.iceServers })
		this.connections.set(peerId, pc)

		pc.addEventListener('icecandidate', event => {
			if (!event.candidate) return
			this.send({
				kind: 'ice',
				from: this.selfId,
				to: peerId,
				data: JSON.stringify(event.candidate.toJSON()),
			})
		})

		pc.addEventListener('connectionstatechange', () => {
			// 'closed' is us; 'failed' is ICE giving up, which it does for
			// reasons that often do not last.
			if (pc.connectionState === 'closed') { this.drop(peerId); return }
			if (pc.connectionState === 'failed') { void this.retry(peerId); return }
			if (pc.connectionState === 'connected') this.attempts.delete(peerId)
		})

		pc.addEventListener('datachannel', event => { this.adopt(peerId, event.channel) })
		return pc
	}

	private adopt = (peerId: string, dc: RTCDataChannel): void => {
		this.channels.set(peerId, dc)
		dc.addEventListener('message', event => {
			this.emit('data', { from: peerId, data: event.data })
		})
		dc.addEventListener('close', () => { this.drop(peerId) })
		const announce = (): void => {
			this.emit('peer', {
				id: peerId,
				send: data => { if (dc.readyState === 'open') dc.send(data as string) },
				close: () => { this.drop(peerId) },
				get open() { return dc.readyState === 'open' },
			})
		}
		if (dc.readyState === 'open') announce()
		else dc.addEventListener('open', announce)
	}

	private offerTo = async (peerId: string): Promise<void> => {
		if (this.connections.has(peerId)) return
		const pc = this.newConnection(peerId)
		const dc = pc.createDataChannel(
			this.opts.label ?? 'foyer',
			this.opts.channel ?? {}
		)
		this.adopt(peerId, dc)

		const offer = await pc.createOffer()
		await pc.setLocalDescription(offer)
		this.send({ kind: 'sdp', from: this.selfId, to: peerId, data: JSON.stringify(offer) })
	}

	private onSignal = async (signal: Signal): Promise<void> => {
		if (!signal || signal.from === this.selfId) return
		if (signal.to !== null && signal.to !== this.selfId) return
		if (!this.shouldConnect(signal.from)) return

		try {
			if (signal.kind === 'hello') {
				// They have arrived. If we are the offerer for this pair, start;
				// otherwise wait, because their offer is already on its way.
				if (this.isOfferer(signal.from)) await this.offerTo(signal.from)
				else this.send({ kind: 'hello', from: this.selfId, to: signal.from })
				return
			}

			if (signal.kind === 'ice') {
				const candidate = JSON.parse(signal.data ?? '{}') as RTCIceCandidateInit
				const pc = this.connections.get(signal.from)
				if (!pc?.remoteDescription) {
					const queue = this.pendingIce.get(signal.from) ?? []
					queue.push(candidate)
					this.pendingIce.set(signal.from, queue)
					return
				}
				try { await pc.addIceCandidate(candidate) } catch { /* stale */ }
				return
			}

			const description = JSON.parse(signal.data ?? '{}') as RTCSessionDescriptionInit
			// A retry arrives as a new offer while we still hold the failed
			// connection. Reusing it would apply the offer to something already
			// dead, so the corpse is cleared out first.
			const existing = this.connections.get(signal.from)
			if (existing && description.type === 'offer' && existing.connectionState === 'failed') {
				existing.close()
				this.channels.get(signal.from)?.close()
				this.channels.delete(signal.from)
				this.connections.delete(signal.from)
				this.pendingIce.delete(signal.from)
			}
			const pc = this.connections.get(signal.from) ?? this.newConnection(signal.from)
			await pc.setRemoteDescription(description)

			const queued = this.pendingIce.get(signal.from)
			if (queued) {
				this.pendingIce.delete(signal.from)
				for (const c of queued) {
					try { await pc.addIceCandidate(c) } catch { /* stale */ }
				}
			}

			if (description.type !== 'offer') return
			const answer = await pc.createAnswer()
			await pc.setLocalDescription(answer)
			this.send({ kind: 'sdp', from: this.selfId, to: signal.from, data: JSON.stringify(answer) })
		} catch (err) {
			this.emit('error', err instanceof Error ? err : new Error(String(err)))
		}
	}
}

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import type { Unsubscribe, VideoQuality } from './types.js'

// Random pairing.
//
// The other way to meet someone. `join` needs a room you already know about;
// this needs nothing -- you ask for whoever is waiting, and if nobody is, you
// become the one waiting.
//
// Deliberately anonymous. Apps built on this hold no accounts and want none:
// the queue stores an ephemeral random id and nothing else, so there is no
// profile, no auth user and no personal data to protect. That is why it does
// not go through signIn.
//
// The claim is a single database function rather than a read followed by a
// write, because two people asking at the same moment must not both be handed
// the same partner. `for update skip locked` settles it inside one statement.

const SIGNAL = 'queue-signal'

type Signal = { kind: 'sdp' | 'ice', from: string, to: string, data: string }

export type QueueOptions = {
	/** Which queue. Separate tags never meet, so one table serves many apps. */
	tag?: string
	/** Local media to send. Omit for a data-only pairing. */
	media?: MediaStream
	channel?: RTCDataChannelInit
	/** Give up after this long with nobody to pair with. */
	timeoutMs?: number
	iceServers?: RTCIceServer[]
	/** Table prefix, matching the schema. */
	prefix?: string
	/**
	 * Video quality. A pairing is always two people, so the curve is asked for
	 * one receiver -- but it is the same curve a room uses, so an app that
	 * tunes quality tunes it everywhere rather than only half its connections.
	 */
	videoQuality?: (peers: number) => VideoQuality
}

type Events = {
	data: unknown
	stream: MediaStream
	close: void
}

type Listener<K extends keyof Events> = (payload: Events[K]) => void

export class QueuePeer {
	readonly id: string
	private pc: RTCPeerConnection
	private dc: RTCDataChannel | null = null
	private listeners = new Map<keyof Events, Set<Listener<never>>>()

	constructor(id: string, pc: RTCPeerConnection) {
		this.id = id
		this.pc = pc
	}

	/** @internal */
	attachChannel(dc: RTCDataChannel): void {
		this.dc = dc
		dc.addEventListener('message', e => { this.emit('data', e.data) })
		dc.addEventListener('close', () => { this.emit('close', undefined) })
	}

	/** @internal */
	emit<K extends keyof Events>(event: K, payload: Events[K]): void {
		this.listeners.get(event)?.forEach(l => (l as Listener<K>)(payload))
	}

	on = <K extends keyof Events>(event: K, listener: Listener<K>): Unsubscribe => {
		const set = this.listeners.get(event) ?? new Set()
		set.add(listener as Listener<never>)
		this.listeners.set(event, set)
		return () => { set.delete(listener as Listener<never>) }
	}

	get open(): boolean { return this.dc?.readyState === 'open' }

	send = (data: string | ArrayBufferView | ArrayBuffer): void => {
		if (this.dc?.readyState === 'open') this.dc.send(data as string)
	}

	close = (): void => {
		this.dc?.close()
		this.pc.close()
		this.emit('close', undefined)
	}
}

const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

// Matches the room mesh's curve at a single receiver, so a pairing and a
// two-person room look the same rather than differing by accident.
const defaultQuality = (): VideoQuality => ({ maxBitrate: 600_000, scaleResolutionDownBy: 1 })

/**
 * Pairs with whoever is waiting, or waits to be paired with.
 *
 * Resolves once a peer connection is established, or rejects on timeout.
 */
export const pair = async (
	supabase: SupabaseClient,
	options: QueueOptions = {}
): Promise<QueuePeer> => {
	const tag = options.tag ?? 'default'
	const prefix = options.prefix ?? 'foyer_'
	const ice = options.iceServers ?? DEFAULT_ICE
	const timeout = options.timeoutMs ?? 60_000
	const me = crypto.randomUUID()

	let channel: RealtimeChannel | null = null
	let settled = false
	const pendingIce: RTCIceCandidateInit[] = []
	let pc: RTCPeerConnection | null = null
	let peer: QueuePeer | null = null

	const cleanup = (): void => {
		if (channel) { void supabase.removeChannel(channel); channel = null }
	}

	return new Promise<QueuePeer>((resolve, reject) => {
		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			// Stop advertising: a waiter that has given up should not be handed
			// to the next arrival.
			void supabase.from(`${prefix}queue`).delete().eq('client_id', me)
			cleanup()
			reject(new Error('foyer: nobody to pair with'))
		}, timeout)

		const succeed = (p: QueuePeer): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(p)
		}

		const newConnection = (other: string, offering: boolean): RTCPeerConnection => {
			const conn = new RTCPeerConnection({ iceServers: ice })
			pc = conn
			peer = new QueuePeer(other, conn)

			const videoSenders = new Set<RTCRtpSender>()
			if (options.media) {
				options.media.getTracks().forEach(t => {
					const sender = conn.addTrack(t, options.media as MediaStream)
					if (t.kind === 'video') videoSenders.add(sender)
				})
			}

			// One receiver, because a pairing is two people. Applied through the
			// sender's parameters, so it needs no renegotiation.
			const applyQuality = async (): Promise<void> => {
				const curve = options.videoQuality ?? defaultQuality
				const { maxBitrate, scaleResolutionDownBy } = curve(1)
				for (const sender of videoSenders) {
					try {
						const params = sender.getParameters()
						if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
						params.encodings[0]!.maxBitrate = maxBitrate
						params.encodings[0]!.scaleResolutionDownBy = scaleResolutionDownBy
						await sender.setParameters(params)
					} catch { /* sender closed, or the browser refused the shape */ }
				}
			}

			conn.addEventListener('icecandidate', e => {
				if (!e.candidate) return
				void channel?.send({
					type: 'broadcast', event: SIGNAL,
					payload: { kind: 'ice', from: me, to: other, data: JSON.stringify(e.candidate.toJSON()) },
				})
			})

			conn.addEventListener('track', e => {
				const remote = e.streams[0]
				if (remote && peer) peer.emit('stream', remote)
			})

			conn.addEventListener('connectionstatechange', () => {
				// Parameters only stick once the sender is negotiated.
				if (conn.connectionState === 'connected') void applyQuality()
				if (conn.connectionState === 'connected' && peer) succeed(peer)
				if ((conn.connectionState === 'failed' || conn.connectionState === 'closed') && peer) {
					peer.emit('close', undefined)
				}
			})

			if (offering) {
				const dc = conn.createDataChannel('foyer', options.channel ?? {})
				peer.attachChannel(dc)
			} else {
				conn.addEventListener('datachannel', e => { peer?.attachChannel(e.channel) })
			}
			return conn
		}

		const onSignal = async (s: Signal): Promise<void> => {
			if (!s || s.to !== me) return
			if (s.kind === 'ice') {
				const candidate = JSON.parse(s.data) as RTCIceCandidateInit
				if (!pc?.remoteDescription) { pendingIce.push(candidate); return }
				try { await pc.addIceCandidate(candidate) } catch { /* stale */ }
				return
			}

			const description = JSON.parse(s.data) as RTCSessionDescriptionInit
			// An offer from a stranger who claimed us: they found us waiting.
			const conn = pc ?? newConnection(s.from, false)
			await conn.setRemoteDescription(description)
			while (pendingIce.length) {
				try { await conn.addIceCandidate(pendingIce.shift() as RTCIceCandidateInit) } catch { /* stale */ }
			}
			if (description.type !== 'offer') return
			const answer = await conn.createAnswer()
			await conn.setLocalDescription(answer)
			void channel?.send({
				type: 'broadcast', event: SIGNAL,
				payload: { kind: 'sdp', from: me, to: s.from, data: JSON.stringify(answer) },
			})
		}

		void (async () => {
			try {
				const ch = supabase.channel(`foyer:queue:${tag}`, {
					config: { broadcast: { self: false, ack: true } },
				})
				ch.on('broadcast', { event: SIGNAL }, ({ payload }) => { void onSignal(payload as Signal) })
				channel = ch

				await new Promise<void>((ok, bad) => {
					ch.subscribe((status, err) => {
						if (status === 'SUBSCRIBED') return ok()
						if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
							bad(err ?? new Error(`foyer: queue signalling failed (${status})`))
						}
					})
				})

				// Subscribe before claiming. Claim first and a fast partner could
				// offer into a channel we are not listening on yet.
				const { data, error } = await supabase.rpc(`${prefix}claim_peer`, {
					my_id: me, my_tag: tag,
				})
				if (error) throw new Error(`foyer: claim failed (${error.message})`)

				const claimed = data as string | null
				if (!claimed) return // waiting; their offer will arrive over the channel

				const conn = newConnection(claimed, true)
				const offer = await conn.createOffer()
				await conn.setLocalDescription(offer)
				void ch.send({
					type: 'broadcast', event: SIGNAL,
					payload: { kind: 'sdp', from: me, to: claimed, data: JSON.stringify(offer) },
				})
			} catch (err) {
				if (settled) return
				settled = true
				clearTimeout(timer)
				cleanup()
				reject(err instanceof Error ? err : new Error(String(err)))
			}
		})()
	})
}

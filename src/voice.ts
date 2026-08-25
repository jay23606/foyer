import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import type { FoyerContext } from './client.js'
import type { Unsubscribe, VideoQuality } from './types.js'

// Voice chat.
//
// Always a mesh, always on its own channel, never sharing a connection with
// room data. Three reasons, in order of how painfully each is learned:
//
// 1. A star topology would mean everyone hears the host and nobody hears each
//    other. Voice is the canonical case where peers must reach each other
//    directly, which is why this is not configurable.
// 2. Separate connections mean a voice failure cannot disturb the data the app
//    actually depends on.
// 3. Adding a media track to a live connection triggers renegotiation -- a
//    fresh offer/answer mid-session. Keeping voice apart means the app's own
//    connections are never renegotiated behind its back.
//
// The mic track is attached when a connection is built, not when the mic is
// unmuted, for that same reason. Muting flips `track.enabled`, which is
// instant and cannot fail.

const SIGNAL = 'voice-signal'

type Signal = { kind: 'hello' | 'sdp' | 'ice', from: string, to: string | null, data?: string }

export type MediaStatus =
	| 'off'
	| 'starting'
	| 'live'
	| 'denied'        // the browser refused, usually no permission
	| 'unavailable'   // no microphone, or an insecure context

export type MediaListener = (status: MediaStatus, detail?: string) => void

// A predicate rather than an inline `instanceof`. The compound guard that also
// checks MediaStream exists does not narrow the other branch, so the
// constraints path still saw a MediaStream in its union.
const isStream = (r: MediaStreamConstraints | MediaStream | undefined): r is MediaStream =>
	typeof MediaStream !== 'undefined' && r instanceof MediaStream

export class MediaMesh {
	private readonly ctx: FoyerContext
	private readonly roomId: string
	private readonly selfId: string

	private channel: RealtimeChannel | null = null
	private stream: MediaStream | null = null
	private connections = new Map<string, RTCPeerConnection>()
	private audio = new Map<string, HTMLAudioElement>()
	private pendingIce = new Map<string, RTCIceCandidateInit[]>()

	private status: MediaStatus = 'off'
	private listeners = new Set<MediaListener>()
	private streamListeners = new Set<(peerId: string, stream: MediaStream) => void>()
	private leaveListeners = new Set<(peerId: string) => void>()
	private mutedFlag = true
	private cameraOffFlag = false
	// Audio-only meshes play themselves through a hidden element, because an
	// app that asked for voice should not have to render anything. A mesh
	// carrying video cannot: only the app knows where the picture goes.
	private audioOnly = true
	// Senders are kept per peer because replaceTrack is a sender operation:
	// it is what stops video without a fresh offer and answer.
	private videoSenders = new Map<string, Set<RTCRtpSender>>()
	private videoSending = true
	// Attempts so far, per peer; cleared the moment a connection succeeds.
	private attempts = new Map<string, number>()

	constructor(ctx: FoyerContext, roomId: string) {
		this.ctx = ctx
		this.roomId = roomId
		this.selfId = ctx.requirePlayer().id
	}

	get muted(): boolean { return this.mutedFlag }
	get currentStatus(): MediaStatus { return this.status }
	get peerCount(): number { return this.connections.size }

	onStatus = (listener: MediaListener): Unsubscribe => {
		this.listeners.add(listener)
		listener(this.status)
		return () => { this.listeners.delete(listener) }
	}

	/** Fires when a peer's media arrives. Attach it to a <video> yourself. */
	onStream = (listener: (peerId: string, stream: MediaStream) => void): Unsubscribe => {
		this.streamListeners.add(listener)
		return () => { this.streamListeners.delete(listener) }
	}

	/** Fires when a peer goes away, so their tile can be removed. */
	onLeave = (listener: (peerId: string) => void): Unsubscribe => {
		this.leaveListeners.add(listener)
		return () => { this.leaveListeners.delete(listener) }
	}

	private setStatus = (status: MediaStatus, detail?: string): void => {
		this.status = status
		this.listeners.forEach(l => l(status, detail))
	}

	/**
	 * Call this from a click or a keypress. getUserMedia prompts for
	 * permission, and browsers refuse to play audio that no interaction asked
	 * for; both need the user gesture that only a real event carries.
	 *
	 * Returns the status it settled on, so callers never have to re-read a
	 * getter whose value this call just changed.
	 */
	start = async (request?: MediaStreamConstraints | MediaStream): Promise<MediaStatus> => {
		if (this.status === 'live' || this.status === 'starting') return this.status
		this.setStatus('starting')

		// A stream the app already has -- a camera preview, a shared screen --
		// is used as given rather than opening a second capture.
		if (isStream(request)) {
			this.stream = request
			this.audioOnly = request.getVideoTracks().length === 0
			this.applyMute()
			try { await this.openChannel() }
			catch (err) {
				this.setStatus('unavailable', String(err))
				return this.status
			}
			this.setStatus('live')
			return this.status
		}

		if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
			// Absent outside a secure context, which is the usual cause: an app
			// served over plain http on a LAN address rather than https.
			this.setStatus('unavailable', 'a secure context is required for microphone access')
			return this.status
		}

		const constraints: MediaStreamConstraints = request ?? {
			audio: this.ctx.audioConstraints
				?? { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			video: false,
		}
		this.audioOnly = !constraints.video

		try {
			this.stream = await navigator.mediaDevices.getUserMedia(constraints)
		} catch (err) {
			const name = (err as DOMException)?.name
			const denied = name === 'NotAllowedError' || name === 'SecurityError'
			this.setStatus(denied ? 'denied' : 'unavailable', String(name ?? err))
			return this.status
		}

		// Start muted. A microphone that opens live the instant someone joins
		// is a surprise nobody wants.
		this.applyMute()

		try { await this.openChannel() }
		catch (err) {
			this.stopTracks()
			this.setStatus('unavailable', String(err))
			return this.status
		}

		this.setStatus('live')
		return this.status
	}

	stop = (): void => {
		this.connections.forEach((pc, id) => { pc.close(); this.dropAudio(id) })
		this.connections.clear()
		this.pendingIce.clear()
		this.stopTracks()
		if (this.channel) {
			void this.ctx.supabase.removeChannel(this.channel)
			this.channel = null
		}
		this.mutedFlag = true
		this.setStatus('off')
	}

	setMuted = (muted: boolean): void => { this.mutedFlag = muted; this.applyMute() }
	toggleMuted = (): boolean => { this.setMuted(!this.mutedFlag); return this.mutedFlag }

	get cameraOff(): boolean { return this.cameraOffFlag }
	setCameraOff = (off: boolean): void => {
		this.cameraOffFlag = off
		// Same reasoning as muting: flip the track rather than renegotiate.
		this.stream?.getVideoTracks().forEach(t => { t.enabled = !off })
	}
	toggleCamera = (): boolean => { this.setCameraOff(!this.cameraOffFlag); return this.cameraOffFlag }

	get sendingVideo(): boolean { return this.videoSending }

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
	setVideoSending = (sending: boolean): void => {
		this.videoSending = sending
		this.connections.forEach((_pc, peerId) => { void this.applyVideoSending(peerId) })
	}

	private applyVideoSending = async (peerId: string): Promise<void> => {
		const senders = this.videoSenders.get(peerId)
		if (!senders) return
		const track = this.videoSending ? (this.stream?.getVideoTracks()[0] ?? null) : null
		for (const sender of senders) {
			try { await sender.replaceTrack(track) } catch { /* connection went away */ }
		}
	}

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
	private qualityFor = (peers: number): VideoQuality => {
		const custom = this.ctx.videoQuality
		if (custom) return custom(peers)
		if (peers <= 1) return { maxBitrate: 600_000, scaleResolutionDownBy: 1 }
		if (peers <= 3) return { maxBitrate: 300_000, scaleResolutionDownBy: 1.5 }
		if (peers <= 7) return { maxBitrate: 150_000, scaleResolutionDownBy: 2 }
		return { maxBitrate: 80_000, scaleResolutionDownBy: 4 }
	}

	/**
	 * Applied through the sender's parameters rather than by touching the
	 * track, so the encoder changes its mind mid-call without a fresh offer
	 * and answer. Runs whenever the peer count moves.
	 */
	private applyVideoQuality = async (): Promise<void> => {
		if (this.audioOnly) return
		const { maxBitrate, scaleResolutionDownBy } = this.qualityFor(this.connections.size)
		for (const senders of this.videoSenders.values()) {
			for (const sender of senders) {
				try {
					const params = sender.getParameters()
					// Firefox has been known to hand back no encodings at all
					// before the first negotiation settles.
					if (!params.encodings || params.encodings.length === 0) {
						params.encodings = [{}]
					}
					params.encodings[0]!.maxBitrate = maxBitrate
					params.encodings[0]!.scaleResolutionDownBy = scaleResolutionDownBy
					await sender.setParameters(params)
				} catch { /* sender closed, or the browser refused the shape */ }
			}
		}
	}

	private applyMute = (): void => {
		this.stream?.getAudioTracks().forEach(t => { t.enabled = !this.mutedFlag })
	}

	private stopTracks = (): void => {
		this.stream?.getTracks().forEach(t => t.stop())
		this.stream = null
	}

	private openChannel = async (): Promise<void> => {
		const channel = this.ctx.supabase.channel(`foyer:voice:${this.roomId}`, {
			config: { broadcast: { self: false, ack: true }, presence: { key: this.selfId } },
		})

		channel.on('broadcast', { event: SIGNAL }, ({ payload }) => {
			void this.onSignal(payload as Signal)
		})
		channel.on('presence', { event: 'leave' }, ({ key }: { key: string }) => {
			if (key === this.selfId) return
			// Presence fires for a browser that vanished and for one that merely
			// stumbled. With a grace period, give the second kind time to come
			// back before tearing its connection down.
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
					reject(err ?? new Error(`foyer: voice signalling failed (${status})`))
				}
			})
		})

		this.send({ kind: 'hello', from: this.selfId, to: null })
	}

	private send = (signal: Signal): void => {
		void this.channel?.send({ type: 'broadcast', event: SIGNAL, payload: signal })
	}

	// No host to defer to, so the lower id offers. Both sides compute the same
	// answer from what they already know.
	private isOfferer = (peerId: string): boolean => this.selfId < peerId

	private newConnection = (peerId: string): RTCPeerConnection => {
		const pc = new RTCPeerConnection({ iceServers: this.ctx.iceServers })
		this.connections.set(peerId, pc)

		const stream = this.stream
		if (stream) {
			stream.getTracks().forEach(t => {
				const sender = pc.addTrack(t, stream)
				// Keep the video senders: replaceTrack on them is how sending
				// stops without renegotiating, and only a sender can do it.
				if (t.kind === 'video') {
					const senders = this.videoSenders.get(peerId) ?? new Set()
					senders.add(sender)
					this.videoSenders.set(peerId, senders)
				}
			})
			// A peer arriving while we are not meant to be sending must not be
			// handed a live track just because it connected late.
			if (!this.videoSending) void this.applyVideoSending(peerId)
		}

		pc.addEventListener('icecandidate', event => {
			if (!event.candidate) return
			this.send({
				kind: 'ice', from: this.selfId, to: peerId,
				data: JSON.stringify(event.candidate.toJSON()),
			})
		})
		pc.addEventListener('track', event => {
			const remote = event.streams[0]
			if (!remote) return
			if (this.audioOnly) this.attachAudio(peerId, remote)
			this.streamListeners.forEach(l => l(peerId, remote))
		})
		pc.addEventListener('connectionstatechange', () => {
			// 'closed' is us; 'failed' is ICE giving up, which it does for
			// reasons that often do not last.
			if (pc.connectionState === 'closed') this.drop(peerId)
			if (pc.connectionState === 'failed') void this.retry(peerId)
			// Parameters only stick once the sender is negotiated, so the
			// quality is set here rather than the moment the track is added.
			if (pc.connectionState === 'connected') {
				this.attempts.delete(peerId)
				void this.applyVideoQuality()
			}
		})
		return pc
	}

	/**
	 * Rebuilds a failed connection, or gives up on the peer.
	 *
	 * A call that drops because a network changed hands should come back
	 * without anyone reloading. Only the side that offered retries, or the two
	 * ends collide exactly as two simultaneous offers do.
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

		// Discard the dead connection without telling the app the peer left.
		this.connections.get(peerId)?.close()
		this.connections.delete(peerId)
		this.videoSenders.delete(peerId)
		this.pendingIce.delete(peerId)

		await new Promise(resolve => setTimeout(resolve, 500 * 2 ** tried))
		if (!this.channel || !this.stream) return
		await this.offerTo(peerId)
	}

	private offerTo = async (peerId: string): Promise<void> => {
		if (this.connections.has(peerId) || !this.stream) return
		const pc = this.newConnection(peerId)
		const offer = await pc.createOffer()
		await pc.setLocalDescription(offer)
		this.send({ kind: 'sdp', from: this.selfId, to: peerId, data: JSON.stringify(offer) })
	}

	private onSignal = async (signal: Signal): Promise<void> => {
		if (!signal || signal.from === this.selfId || !this.stream) return
		if (signal.to !== null && signal.to !== this.selfId) return

		if (signal.kind === 'hello') {
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
		// A retry arrives as a new offer while the failed connection is still
		// held; applying an offer to a corpse gets nowhere.
		const existing = this.connections.get(signal.from)
		if (existing && description.type === 'offer' && existing.connectionState === 'failed') {
			existing.close()
			this.connections.delete(signal.from)
			this.videoSenders.delete(signal.from)
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
	}

	// Remote audio needs a real element to play through. It stays out of the
	// layout and off the accessibility tree: it is a speaker, not a control.
	private attachAudio = (peerId: string, stream: MediaStream): void => {
		let el = this.audio.get(peerId)
		if (!el) {
			el = document.createElement('audio')
			el.autoplay = true
			el.setAttribute('aria-hidden', 'true')
			el.style.display = 'none'
			document.body.appendChild(el)
			this.audio.set(peerId, el)
		}
		el.srcObject = stream
		void el.play().catch(() => { /* blocked until a gesture; the toggle retries */ })
	}

	private dropAudio = (peerId: string): void => {
		const el = this.audio.get(peerId)
		if (!el) return
		el.srcObject = null
		el.remove()
		this.audio.delete(peerId)
	}

	private drop = (peerId: string): void => {
		// Take it before removing it: deleting first leaves nothing to close,
		// and the connection would leak.
		const pc = this.connections.get(peerId)
		const had = this.connections.delete(peerId)
		pc?.close()
		this.pendingIce.delete(peerId)
		this.videoSenders.delete(peerId)
		this.attempts.delete(peerId)
		this.dropAudio(peerId)
		if (had) {
			this.leaveListeners.forEach(l => l(peerId))
			// A smaller audience means the remaining senders can afford more.
			void this.applyVideoQuality()
		}
	}
}

export type StandaloneMediaOptions = {
	supabase: SupabaseClient
	/** Any stable string shared by everyone who should hear each other. */
	roomId: string
	/** This player's id. Must be unique per participant and stable for the call. */
	playerId: string
	iceServers?: RTCIceServer[]
	videoQuality?: (peers: number) => VideoQuality
	peerGraceMs?: number
	audioConstraints?: MediaTrackConstraints
	reconnectAttempts?: number
}

/**
 * A voice mesh without the rest of foyer.
 *
 * Plenty of apps already have their own rooms and identity and want only this
 * part. Requiring them to adopt foyer's room model to get a microphone would
 * be a poor trade, so the mesh is constructible on its own: it needs a channel
 * name and a stable id, and nothing else foyer owns.
 */
export const createMediaMesh = (options: StandaloneMediaOptions): MediaMesh => {
	const player = { id: options.playerId, name: '' }
	const ctx: FoyerContext = {
		supabase: options.supabase,
		// The mesh touches no tables; it is entirely broadcast and presence.
		table: (name: string) => name,
		iceServers: options.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }],
		rest: null,
		// Never read here: the heartbeat keeps a room_players row alive, and a
		// standalone mesh has neither a room nor a row.
		heartbeatMs: 0,
		videoQuality: options.videoQuality ?? null,
		graceMs: options.peerGraceMs ?? 0,
		audioConstraints: options.audioConstraints,
		// A standalone mesh has no room to hand anyone.
		hostMigration: false,
		reconnectAttempts: options.reconnectAttempts ?? 3,
		requirePlayer: () => player,
	}
	return new MediaMesh(ctx, options.roomId)
}

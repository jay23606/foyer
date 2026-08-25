import type { RealtimeChannel } from '@supabase/supabase-js'
import type { FoyerContext } from './client.js'
import type { Unsubscribe } from './types.js'

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

export type VoiceStatus =
	| 'off'
	| 'starting'
	| 'live'
	| 'denied'        // the browser refused, usually no permission
	| 'unavailable'   // no microphone, or an insecure context

export type VoiceListener = (status: VoiceStatus, detail?: string) => void

export class VoiceMesh {
	private readonly ctx: FoyerContext
	private readonly roomId: string
	private readonly selfId: string

	private channel: RealtimeChannel | null = null
	private stream: MediaStream | null = null
	private connections = new Map<string, RTCPeerConnection>()
	private audio = new Map<string, HTMLAudioElement>()
	private pendingIce = new Map<string, RTCIceCandidateInit[]>()

	private status: VoiceStatus = 'off'
	private listeners = new Set<VoiceListener>()
	private mutedFlag = true

	constructor(ctx: FoyerContext, roomId: string) {
		this.ctx = ctx
		this.roomId = roomId
		this.selfId = ctx.requirePlayer().id
	}

	get muted(): boolean { return this.mutedFlag }
	get currentStatus(): VoiceStatus { return this.status }
	get peerCount(): number { return this.connections.size }

	onStatus = (listener: VoiceListener): Unsubscribe => {
		this.listeners.add(listener)
		listener(this.status)
		return () => { this.listeners.delete(listener) }
	}

	private setStatus = (status: VoiceStatus, detail?: string): void => {
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
	start = async (): Promise<VoiceStatus> => {
		if (this.status === 'live' || this.status === 'starting') return this.status
		this.setStatus('starting')

		if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
			// Absent outside a secure context, which is the usual cause: an app
			// served over plain http on a LAN address rather than https.
			this.setStatus('unavailable', 'a secure context is required for microphone access')
			return this.status
		}

		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
				video: false,
			})
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
			if (key !== this.selfId) this.drop(key)
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
		if (stream) stream.getAudioTracks().forEach(t => { pc.addTrack(t, stream) })

		pc.addEventListener('icecandidate', event => {
			if (!event.candidate) return
			this.send({
				kind: 'ice', from: this.selfId, to: peerId,
				data: JSON.stringify(event.candidate.toJSON()),
			})
		})
		pc.addEventListener('track', event => {
			const remote = event.streams[0]
			if (remote) this.attachAudio(peerId, remote)
		})
		pc.addEventListener('connectionstatechange', () => {
			if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.drop(peerId)
		})
		return pc
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
		this.connections.get(peerId)?.close()
		this.connections.delete(peerId)
		this.pendingIce.delete(peerId)
		this.dropAudio(peerId)
	}
}

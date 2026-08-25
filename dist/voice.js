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
const SIGNAL = 'voice-signal';
// A predicate rather than an inline `instanceof`. The compound guard that also
// checks MediaStream exists does not narrow the other branch, so the
// constraints path still saw a MediaStream in its union.
const isStream = (r) => typeof MediaStream !== 'undefined' && r instanceof MediaStream;
export class MediaMesh {
    ctx;
    roomId;
    selfId;
    channel = null;
    stream = null;
    connections = new Map();
    audio = new Map();
    pendingIce = new Map();
    status = 'off';
    listeners = new Set();
    streamListeners = new Set();
    leaveListeners = new Set();
    mutedFlag = true;
    cameraOffFlag = false;
    // Audio-only meshes play themselves through a hidden element, because an
    // app that asked for voice should not have to render anything. A mesh
    // carrying video cannot: only the app knows where the picture goes.
    audioOnly = true;
    // Senders are kept per peer because replaceTrack is a sender operation:
    // it is what stops video without a fresh offer and answer.
    videoSenders = new Map();
    videoSending = true;
    constructor(ctx, roomId) {
        this.ctx = ctx;
        this.roomId = roomId;
        this.selfId = ctx.requirePlayer().id;
    }
    get muted() { return this.mutedFlag; }
    get currentStatus() { return this.status; }
    get peerCount() { return this.connections.size; }
    onStatus = (listener) => {
        this.listeners.add(listener);
        listener(this.status);
        return () => { this.listeners.delete(listener); };
    };
    /** Fires when a peer's media arrives. Attach it to a <video> yourself. */
    onStream = (listener) => {
        this.streamListeners.add(listener);
        return () => { this.streamListeners.delete(listener); };
    };
    /** Fires when a peer goes away, so their tile can be removed. */
    onLeave = (listener) => {
        this.leaveListeners.add(listener);
        return () => { this.leaveListeners.delete(listener); };
    };
    setStatus = (status, detail) => {
        this.status = status;
        this.listeners.forEach(l => l(status, detail));
    };
    /**
     * Call this from a click or a keypress. getUserMedia prompts for
     * permission, and browsers refuse to play audio that no interaction asked
     * for; both need the user gesture that only a real event carries.
     *
     * Returns the status it settled on, so callers never have to re-read a
     * getter whose value this call just changed.
     */
    start = async (request) => {
        if (this.status === 'live' || this.status === 'starting')
            return this.status;
        this.setStatus('starting');
        // A stream the app already has -- a camera preview, a shared screen --
        // is used as given rather than opening a second capture.
        if (isStream(request)) {
            this.stream = request;
            this.audioOnly = request.getVideoTracks().length === 0;
            this.applyMute();
            try {
                await this.openChannel();
            }
            catch (err) {
                this.setStatus('unavailable', String(err));
                return this.status;
            }
            this.setStatus('live');
            return this.status;
        }
        if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
            // Absent outside a secure context, which is the usual cause: an app
            // served over plain http on a LAN address rather than https.
            this.setStatus('unavailable', 'a secure context is required for microphone access');
            return this.status;
        }
        const constraints = request ?? {
            audio: this.ctx.audioConstraints
                ?? { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
        };
        this.audioOnly = !constraints.video;
        try {
            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        }
        catch (err) {
            const name = err?.name;
            const denied = name === 'NotAllowedError' || name === 'SecurityError';
            this.setStatus(denied ? 'denied' : 'unavailable', String(name ?? err));
            return this.status;
        }
        // Start muted. A microphone that opens live the instant someone joins
        // is a surprise nobody wants.
        this.applyMute();
        try {
            await this.openChannel();
        }
        catch (err) {
            this.stopTracks();
            this.setStatus('unavailable', String(err));
            return this.status;
        }
        this.setStatus('live');
        return this.status;
    };
    stop = () => {
        this.connections.forEach((pc, id) => { pc.close(); this.dropAudio(id); });
        this.connections.clear();
        this.pendingIce.clear();
        this.stopTracks();
        if (this.channel) {
            void this.ctx.supabase.removeChannel(this.channel);
            this.channel = null;
        }
        this.mutedFlag = true;
        this.setStatus('off');
    };
    setMuted = (muted) => { this.mutedFlag = muted; this.applyMute(); };
    toggleMuted = () => { this.setMuted(!this.mutedFlag); return this.mutedFlag; };
    get cameraOff() { return this.cameraOffFlag; }
    setCameraOff = (off) => {
        this.cameraOffFlag = off;
        // Same reasoning as muting: flip the track rather than renegotiate.
        this.stream?.getVideoTracks().forEach(t => { t.enabled = !off; });
    };
    toggleCamera = () => { this.setCameraOff(!this.cameraOffFlag); return this.cameraOffFlag; };
    get sendingVideo() { return this.videoSending; }
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
    setVideoSending = (sending) => {
        this.videoSending = sending;
        this.connections.forEach((_pc, peerId) => { void this.applyVideoSending(peerId); });
    };
    applyVideoSending = async (peerId) => {
        const senders = this.videoSenders.get(peerId);
        if (!senders)
            return;
        const track = this.videoSending ? (this.stream?.getVideoTracks()[0] ?? null) : null;
        for (const sender of senders) {
            try {
                await sender.replaceTrack(track);
            }
            catch { /* connection went away */ }
        }
    };
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
    qualityFor = (peers) => {
        const custom = this.ctx.videoQuality;
        if (custom)
            return custom(peers);
        if (peers <= 1)
            return { maxBitrate: 600_000, scaleResolutionDownBy: 1 };
        if (peers <= 3)
            return { maxBitrate: 300_000, scaleResolutionDownBy: 1.5 };
        if (peers <= 7)
            return { maxBitrate: 150_000, scaleResolutionDownBy: 2 };
        return { maxBitrate: 80_000, scaleResolutionDownBy: 4 };
    };
    /**
     * Applied through the sender's parameters rather than by touching the
     * track, so the encoder changes its mind mid-call without a fresh offer
     * and answer. Runs whenever the peer count moves.
     */
    applyVideoQuality = async () => {
        if (this.audioOnly)
            return;
        const { maxBitrate, scaleResolutionDownBy } = this.qualityFor(this.connections.size);
        for (const senders of this.videoSenders.values()) {
            for (const sender of senders) {
                try {
                    const params = sender.getParameters();
                    // Firefox has been known to hand back no encodings at all
                    // before the first negotiation settles.
                    if (!params.encodings || params.encodings.length === 0) {
                        params.encodings = [{}];
                    }
                    params.encodings[0].maxBitrate = maxBitrate;
                    params.encodings[0].scaleResolutionDownBy = scaleResolutionDownBy;
                    await sender.setParameters(params);
                }
                catch { /* sender closed, or the browser refused the shape */ }
            }
        }
    };
    applyMute = () => {
        this.stream?.getAudioTracks().forEach(t => { t.enabled = !this.mutedFlag; });
    };
    stopTracks = () => {
        this.stream?.getTracks().forEach(t => t.stop());
        this.stream = null;
    };
    openChannel = async () => {
        const channel = this.ctx.supabase.channel(`foyer:voice:${this.roomId}`, {
            config: { broadcast: { self: false, ack: true }, presence: { key: this.selfId } },
        });
        channel.on('broadcast', { event: SIGNAL }, ({ payload }) => {
            void this.onSignal(payload);
        });
        channel.on('presence', { event: 'leave' }, ({ key }) => {
            if (key === this.selfId)
                return;
            // Presence fires for a browser that vanished and for one that merely
            // stumbled. With a grace period, give the second kind time to come
            // back before tearing its connection down.
            if (this.ctx.graceMs <= 0) {
                this.drop(key);
                return;
            }
            setTimeout(() => {
                const present = Object.keys(channel.presenceState());
                if (!present.includes(key))
                    this.drop(key);
            }, this.ctx.graceMs);
        });
        this.channel = channel;
        await new Promise((resolve, reject) => {
            channel.subscribe((status, err) => {
                if (status === 'SUBSCRIBED') {
                    void channel.track({ id: this.selfId });
                    resolve();
                    return;
                }
                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    reject(err ?? new Error(`foyer: voice signalling failed (${status})`));
                }
            });
        });
        this.send({ kind: 'hello', from: this.selfId, to: null });
    };
    send = (signal) => {
        void this.channel?.send({ type: 'broadcast', event: SIGNAL, payload: signal });
    };
    // No host to defer to, so the lower id offers. Both sides compute the same
    // answer from what they already know.
    isOfferer = (peerId) => this.selfId < peerId;
    newConnection = (peerId) => {
        const pc = new RTCPeerConnection({ iceServers: this.ctx.iceServers });
        this.connections.set(peerId, pc);
        const stream = this.stream;
        if (stream) {
            stream.getTracks().forEach(t => {
                const sender = pc.addTrack(t, stream);
                // Keep the video senders: replaceTrack on them is how sending
                // stops without renegotiating, and only a sender can do it.
                if (t.kind === 'video') {
                    const senders = this.videoSenders.get(peerId) ?? new Set();
                    senders.add(sender);
                    this.videoSenders.set(peerId, senders);
                }
            });
            // A peer arriving while we are not meant to be sending must not be
            // handed a live track just because it connected late.
            if (!this.videoSending)
                void this.applyVideoSending(peerId);
        }
        pc.addEventListener('icecandidate', event => {
            if (!event.candidate)
                return;
            this.send({
                kind: 'ice', from: this.selfId, to: peerId,
                data: JSON.stringify(event.candidate.toJSON()),
            });
        });
        pc.addEventListener('track', event => {
            const remote = event.streams[0];
            if (!remote)
                return;
            if (this.audioOnly)
                this.attachAudio(peerId, remote);
            this.streamListeners.forEach(l => l(peerId, remote));
        });
        pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed')
                this.drop(peerId);
            // Parameters only stick once the sender is negotiated, so the
            // quality is set here rather than the moment the track is added.
            if (pc.connectionState === 'connected')
                void this.applyVideoQuality();
        });
        return pc;
    };
    offerTo = async (peerId) => {
        if (this.connections.has(peerId) || !this.stream)
            return;
        const pc = this.newConnection(peerId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.send({ kind: 'sdp', from: this.selfId, to: peerId, data: JSON.stringify(offer) });
    };
    onSignal = async (signal) => {
        if (!signal || signal.from === this.selfId || !this.stream)
            return;
        if (signal.to !== null && signal.to !== this.selfId)
            return;
        if (signal.kind === 'hello') {
            if (this.isOfferer(signal.from))
                await this.offerTo(signal.from);
            else
                this.send({ kind: 'hello', from: this.selfId, to: signal.from });
            return;
        }
        if (signal.kind === 'ice') {
            const candidate = JSON.parse(signal.data ?? '{}');
            const pc = this.connections.get(signal.from);
            if (!pc?.remoteDescription) {
                const queue = this.pendingIce.get(signal.from) ?? [];
                queue.push(candidate);
                this.pendingIce.set(signal.from, queue);
                return;
            }
            try {
                await pc.addIceCandidate(candidate);
            }
            catch { /* stale */ }
            return;
        }
        const description = JSON.parse(signal.data ?? '{}');
        const pc = this.connections.get(signal.from) ?? this.newConnection(signal.from);
        await pc.setRemoteDescription(description);
        const queued = this.pendingIce.get(signal.from);
        if (queued) {
            this.pendingIce.delete(signal.from);
            for (const c of queued) {
                try {
                    await pc.addIceCandidate(c);
                }
                catch { /* stale */ }
            }
        }
        if (description.type !== 'offer')
            return;
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send({ kind: 'sdp', from: this.selfId, to: signal.from, data: JSON.stringify(answer) });
    };
    // Remote audio needs a real element to play through. It stays out of the
    // layout and off the accessibility tree: it is a speaker, not a control.
    attachAudio = (peerId, stream) => {
        let el = this.audio.get(peerId);
        if (!el) {
            el = document.createElement('audio');
            el.autoplay = true;
            el.setAttribute('aria-hidden', 'true');
            el.style.display = 'none';
            document.body.appendChild(el);
            this.audio.set(peerId, el);
        }
        el.srcObject = stream;
        void el.play().catch(() => { });
    };
    dropAudio = (peerId) => {
        const el = this.audio.get(peerId);
        if (!el)
            return;
        el.srcObject = null;
        el.remove();
        this.audio.delete(peerId);
    };
    drop = (peerId) => {
        // Take it before removing it: deleting first leaves nothing to close,
        // and the connection would leak.
        const pc = this.connections.get(peerId);
        const had = this.connections.delete(peerId);
        pc?.close();
        this.pendingIce.delete(peerId);
        this.videoSenders.delete(peerId);
        this.dropAudio(peerId);
        if (had) {
            this.leaveListeners.forEach(l => l(peerId));
            // A smaller audience means the remaining senders can afford more.
            void this.applyVideoQuality();
        }
    };
}
/**
 * A voice mesh without the rest of foyer.
 *
 * Plenty of apps already have their own rooms and identity and want only this
 * part. Requiring them to adopt foyer's room model to get a microphone would
 * be a poor trade, so the mesh is constructible on its own: it needs a channel
 * name and a stable id, and nothing else foyer owns.
 */
export const createMediaMesh = (options) => {
    const player = { id: options.playerId, name: '' };
    const ctx = {
        supabase: options.supabase,
        // The mesh touches no tables; it is entirely broadcast and presence.
        table: (name) => name,
        iceServers: options.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }],
        rest: null,
        videoQuality: options.videoQuality ?? null,
        graceMs: options.peerGraceMs ?? 0,
        audioConstraints: options.audioConstraints,
        // A standalone mesh has no room to hand anyone.
        hostMigration: false,
        requirePlayer: () => player,
    };
    return new MediaMesh(ctx, options.roomId);
};

import { isOfferer, shouldConnect } from './topology.js';
// Peer connections for a room.
//
// Signalling rides a Realtime channel of its own: a few dozen small messages
// per peer, once, at connect time. Everything after that goes directly between
// browsers and never touches Supabase again.
//
// Every signal carries an explicit `from` and `to` and each peer filters for
// itself. There is no server hop to rewrite addresses, so the addressing has
// to be in the payload.
const SIGNAL = 'peer-signal';
export class PeerNet {
    ctx;
    roomId;
    selfId;
    hostId;
    opts;
    channel = null;
    connections = new Map();
    channels = new Map();
    // Candidates routinely arrive before the description they belong to;
    // adding one early throws, so they wait here.
    pendingIce = new Map();
    listeners = new Map();
    constructor(ctx, roomId, hostId, opts) {
        this.ctx = ctx;
        this.roomId = roomId;
        this.hostId = hostId;
        this.selfId = ctx.requirePlayer().id;
        this.opts = opts;
    }
    get peers() { return [...this.channels.keys()]; }
    on = (event, listener) => {
        const set = this.listeners.get(event) ?? new Set();
        set.add(listener);
        this.listeners.set(event, set);
        return () => { set.delete(listener); };
    };
    emit = (event, payload) => {
        this.listeners.get(event)?.forEach(l => l(payload));
    };
    // Both decisions live in topology.ts, where they can be tested without a
    // browser, a database and two live sessions.
    shouldConnect = (peerId) => shouldConnect(this.opts.topology, this.selfId, this.hostId, peerId);
    isOfferer = (peerId) => isOfferer(this.opts.topology, this.selfId, this.hostId, peerId);
    connect = async () => {
        const channel = this.ctx.supabase.channel(`foyer:net:${this.roomId}`, {
            config: { broadcast: { self: false, ack: true }, presence: { key: this.selfId } },
        });
        channel.on('broadcast', { event: SIGNAL }, ({ payload }) => {
            void this.onSignal(payload);
        });
        // Presence is the safety net for peers that vanish without saying so --
        // a closed tab, a dropped network, a crashed browser.
        channel.on('presence', { event: 'leave' }, ({ key }) => {
            if (key !== this.selfId)
                this.drop(key);
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
                    reject(err ?? new Error(`foyer: peer signalling failed (${status})`));
                }
            });
        });
        // Announce arrival. Whoever should offer to us will now do so, and
        // whoever we should offer to is answered below.
        this.send({ kind: 'hello', from: this.selfId, to: null });
    };
    close = () => {
        this.channels.forEach(c => c.close());
        this.connections.forEach(c => c.close());
        this.channels.clear();
        this.connections.clear();
        this.pendingIce.clear();
        if (this.channel) {
            void this.ctx.supabase.removeChannel(this.channel);
            this.channel = null;
        }
    };
    send = (signal) => {
        void this.channel?.send({ type: 'broadcast', event: SIGNAL, payload: signal });
    };
    drop = (peerId) => {
        this.channels.get(peerId)?.close();
        this.connections.get(peerId)?.close();
        const had = this.channels.delete(peerId);
        this.connections.delete(peerId);
        this.pendingIce.delete(peerId);
        if (had)
            this.emit('leave', peerId);
    };
    newConnection = (peerId) => {
        const pc = new RTCPeerConnection({ iceServers: this.ctx.iceServers });
        this.connections.set(peerId, pc);
        pc.addEventListener('icecandidate', event => {
            if (!event.candidate)
                return;
            this.send({
                kind: 'ice',
                from: this.selfId,
                to: peerId,
                data: JSON.stringify(event.candidate.toJSON()),
            });
        });
        pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                this.drop(peerId);
            }
        });
        pc.addEventListener('datachannel', event => { this.adopt(peerId, event.channel); });
        return pc;
    };
    adopt = (peerId, dc) => {
        this.channels.set(peerId, dc);
        dc.addEventListener('message', event => {
            this.emit('data', { from: peerId, data: event.data });
        });
        dc.addEventListener('close', () => { this.drop(peerId); });
        const announce = () => {
            this.emit('peer', {
                id: peerId,
                send: data => { if (dc.readyState === 'open')
                    dc.send(data); },
                close: () => { this.drop(peerId); },
                get open() { return dc.readyState === 'open'; },
            });
        };
        if (dc.readyState === 'open')
            announce();
        else
            dc.addEventListener('open', announce);
    };
    offerTo = async (peerId) => {
        if (this.connections.has(peerId))
            return;
        const pc = this.newConnection(peerId);
        const dc = pc.createDataChannel(this.opts.label ?? 'foyer', this.opts.channel ?? {});
        this.adopt(peerId, dc);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.send({ kind: 'sdp', from: this.selfId, to: peerId, data: JSON.stringify(offer) });
    };
    onSignal = async (signal) => {
        if (!signal || signal.from === this.selfId)
            return;
        if (signal.to !== null && signal.to !== this.selfId)
            return;
        if (!this.shouldConnect(signal.from))
            return;
        try {
            if (signal.kind === 'hello') {
                // They have arrived. If we are the offerer for this pair, start;
                // otherwise wait, because their offer is already on its way.
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
        }
        catch (err) {
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
        }
    };
}

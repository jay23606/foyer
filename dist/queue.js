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
const SIGNAL = 'queue-signal';
export class QueuePeer {
    id;
    pc;
    dc = null;
    listeners = new Map();
    constructor(id, pc) {
        this.id = id;
        this.pc = pc;
    }
    /** @internal */
    attachChannel(dc) {
        this.dc = dc;
        dc.addEventListener('message', e => { this.emit('data', e.data); });
        dc.addEventListener('close', () => { this.emit('close', undefined); });
    }
    /** @internal */
    emit(event, payload) {
        this.listeners.get(event)?.forEach(l => l(payload));
    }
    on = (event, listener) => {
        const set = this.listeners.get(event) ?? new Set();
        set.add(listener);
        this.listeners.set(event, set);
        return () => { set.delete(listener); };
    };
    get open() { return this.dc?.readyState === 'open'; }
    send = (data) => {
        if (this.dc?.readyState === 'open')
            this.dc.send(data);
    };
    close = () => {
        this.dc?.close();
        this.pc.close();
        this.emit('close', undefined);
    };
}
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
/**
 * Pairs with whoever is waiting, or waits to be paired with.
 *
 * Resolves once a peer connection is established, or rejects on timeout.
 */
export const pair = async (supabase, options = {}) => {
    const tag = options.tag ?? 'default';
    const prefix = options.prefix ?? 'foyer_';
    const ice = options.iceServers ?? DEFAULT_ICE;
    const timeout = options.timeoutMs ?? 60_000;
    const me = crypto.randomUUID();
    let channel = null;
    let settled = false;
    const pendingIce = [];
    let pc = null;
    let peer = null;
    const cleanup = () => {
        if (channel) {
            void supabase.removeChannel(channel);
            channel = null;
        }
    };
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            // Stop advertising: a waiter that has given up should not be handed
            // to the next arrival.
            void supabase.from(`${prefix}queue`).delete().eq('client_id', me);
            cleanup();
            reject(new Error('foyer: nobody to pair with'));
        }, timeout);
        const succeed = (p) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(p);
        };
        const newConnection = (other, offering) => {
            const conn = new RTCPeerConnection({ iceServers: ice });
            pc = conn;
            peer = new QueuePeer(other, conn);
            if (options.media) {
                options.media.getTracks().forEach(t => conn.addTrack(t, options.media));
            }
            conn.addEventListener('icecandidate', e => {
                if (!e.candidate)
                    return;
                void channel?.send({
                    type: 'broadcast', event: SIGNAL,
                    payload: { kind: 'ice', from: me, to: other, data: JSON.stringify(e.candidate.toJSON()) },
                });
            });
            conn.addEventListener('track', e => {
                const remote = e.streams[0];
                if (remote && peer)
                    peer.emit('stream', remote);
            });
            conn.addEventListener('connectionstatechange', () => {
                if (conn.connectionState === 'connected' && peer)
                    succeed(peer);
                if ((conn.connectionState === 'failed' || conn.connectionState === 'closed') && peer) {
                    peer.emit('close', undefined);
                }
            });
            if (offering) {
                const dc = conn.createDataChannel('foyer', options.channel ?? {});
                peer.attachChannel(dc);
            }
            else {
                conn.addEventListener('datachannel', e => { peer?.attachChannel(e.channel); });
            }
            return conn;
        };
        const onSignal = async (s) => {
            if (!s || s.to !== me)
                return;
            if (s.kind === 'ice') {
                const candidate = JSON.parse(s.data);
                if (!pc?.remoteDescription) {
                    pendingIce.push(candidate);
                    return;
                }
                try {
                    await pc.addIceCandidate(candidate);
                }
                catch { /* stale */ }
                return;
            }
            const description = JSON.parse(s.data);
            // An offer from a stranger who claimed us: they found us waiting.
            const conn = pc ?? newConnection(s.from, false);
            await conn.setRemoteDescription(description);
            while (pendingIce.length) {
                try {
                    await conn.addIceCandidate(pendingIce.shift());
                }
                catch { /* stale */ }
            }
            if (description.type !== 'offer')
                return;
            const answer = await conn.createAnswer();
            await conn.setLocalDescription(answer);
            void channel?.send({
                type: 'broadcast', event: SIGNAL,
                payload: { kind: 'sdp', from: me, to: s.from, data: JSON.stringify(answer) },
            });
        };
        void (async () => {
            try {
                const ch = supabase.channel(`foyer:queue:${tag}`, {
                    config: { broadcast: { self: false, ack: true } },
                });
                ch.on('broadcast', { event: SIGNAL }, ({ payload }) => { void onSignal(payload); });
                channel = ch;
                await new Promise((ok, bad) => {
                    ch.subscribe((status, err) => {
                        if (status === 'SUBSCRIBED')
                            return ok();
                        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                            bad(err ?? new Error(`foyer: queue signalling failed (${status})`));
                        }
                    });
                });
                // Subscribe before claiming. Claim first and a fast partner could
                // offer into a channel we are not listening on yet.
                const { data, error } = await supabase.rpc(`${prefix}claim_peer`, {
                    my_id: me, my_tag: tag,
                });
                if (error)
                    throw new Error(`foyer: claim failed (${error.message})`);
                const claimed = data;
                if (!claimed)
                    return; // waiting; their offer will arrive over the channel
                const conn = newConnection(claimed, true);
                const offer = await conn.createOffer();
                await conn.setLocalDescription(offer);
                void ch.send({
                    type: 'broadcast', event: SIGNAL,
                    payload: { kind: 'sdp', from: me, to: claimed, data: JSON.stringify(offer) },
                });
            }
            catch (err) {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                cleanup();
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        })();
    });
};

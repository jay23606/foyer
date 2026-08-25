# foyer

**Peer-to-peer rooms for Supabase.** Lobbies, presence, chat, moderation,
voice and video, with no server to deploy.

A foyer is the room people meet in before anything happens. That is what this
is: the layer between "two browsers exist" and "a multiplayer app".

```ts
import { createFoyer } from '@jay23606/foyer'

const foyer = createFoyer({ supabase })

await foyer.signIn('ranger')

const room = await foyer.createRoom({
  metadata: { map: 'e1m1', mode: 'deathmatch' },
  maxPlayers: 8,
})

room.on('players', players => render(players))
room.on('message', m => log(m))

await room.say('anyone want a game?')
```

## Why not just use a WebRTC library?

Because connecting two peers is the part that is already solved.
[Trystero](https://github.com/dmotz/trystero) does peer discovery and transport
well, across half a dozen decentralised backends, and if that is all you need
you should use it.

What nobody hands you is everything above the connection: a live room list,
presence, chat with join and leave notices, host authority, kick and ban that
actually stick, per-player state, and identity that survives a refresh. That
gets rebuilt from scratch in every project, and it is most of the work.

foyer is Supabase-only on purpose. A library that abstracts over six signalling
backends can only use what all six have in common — so it cannot enforce
anything. Committing to one backend buys:

- **Moderation the client cannot ignore.** A ban is a row-level security policy
  on the rejoin, not a request the client is trusted to honour.
- **Identity that persists.** Anonymous auth by default, upgradeable to a real
  account later without losing the player's history.
- **A live lobby**, not just a room whose name you already knew.
- **Memory.** Rooms, results and state are rows. Peers alone forget everything.

## Two ways to meet someone

`join` needs a room you already know about. `queue` needs nothing -- you ask
for whoever is waiting, and if nobody is, you become the one waiting.

```js
// a room you were told about
const room = await foyer.join('NVVPT')

// or whoever is out there
const peer = await foyer.queue({ tag: 'chat', media: cam })
peer.on('stream', s => video.srcObject = s)
peer.send('hi')
```

The queue is deliberately anonymous: it never touches profiles or auth,
because apps that pair strangers hold no accounts and want none. It stores an
ephemeral random id and a tag, and nothing else.

Claiming is one database function rather than a read then a write. Two people
asking at the same moment must not both be handed the same partner, and
`for update skip locked` is what makes that impossible rather than merely
unlikely.

## Voice and video

The media mesh takes constraints, or a stream you already hold — a camera
preview, a shared screen — so it does not open a second capture.

```js
const media = room.media()
await media.start({ audio: true, video: true })   // from a click

media.onStream((peerId, stream) => addTile(peerId, stream))
media.onLeave(peerId => removeTile(peerId))

media.toggleMuted()
media.toggleCamera()
```

An **audio-only** mesh plays itself through a hidden element: someone who
asked for voice should not have to render anything. A mesh carrying **video**
does not, because only the app knows where a picture goes — so remote media
arrives through `onStream` and you place it.

Quality is chosen from how many peers are receiving, because a mesh multiplies
a stream by its audience: two people can afford a decent picture, sixteen
cannot. The default lands around a megabit up at any room size. Replace the
whole curve if that is wrong for your app:

```js
createFoyer({
  supabase,
  videoQuality: peers => peers <= 2
    ? { maxBitrate: 1_200_000, scaleResolutionDownBy: 1 }  // a call, make it look good
    : { maxBitrate: 100_000, scaleResolutionDownBy: 4 },   // a wall of thumbnails
})
```

Muting and camera toggles flip `track.enabled` rather than adding or removing
tracks, because changing tracks on a live connection triggers renegotiation:
a fresh offer and answer in the middle of a call.

One mesh, one name. It began audio-only and was called `VoiceMesh`; it carries
video now, so it is `MediaMesh`, reached through `room.media()`.

## Topology is a decision, so foyer makes you state it

```ts
const net = room.connect({ topology: 'star' })  // or 'mesh'
```

- **`star`** — everyone connects to the host and nobody else. Correct when one
  peer is authoritative, as in a client/server game where the host *is* the
  server. Costs n-1 connections.
- **`mesh`** — everyone connects to everyone. Correct when peers must reach
  each other, as in voice chat, where a star means everyone hears the host and
  nobody hears anyone else. Costs n(n-1)/2.

This looks like a detail and is not. Choosing the wrong one produces a system
that connects perfectly and is quietly useless, which is far harder to diagnose
than one that fails outright. Voice riding on a star topology is the specific
mistake this API exists to prevent.

## Setup

```bash
npm install @jay23606/foyer @supabase/supabase-js
```

Run `supabase/schema.sql` against your project, and enable anonymous sign-ins
under Authentication → Providers.

Tables are prefixed (`foyer_` by default) so several apps can share one
project. Change it in the schema and pass the same value to `createFoyer`.

The anon key is public by design — row-level security is what protects the
data. The service role key must never reach the browser.

## Options

Sensible defaults, adjustable where an app might reasonably differ.

| option | default | why you might change it |
|---|---|---|
| `prefix` | `foyer_` | share one project between apps |
| `iceServers` | a public STUN | your own STUN, or a TURN relay |
| `videoQuality` | scales with audience | a call that should look good; thumbnails that need not |
| `codeLength` | `5` | more room in a busy deployment |
| `codeAlphabet` | no `O`/`0`, no `I`/`1` | add or remove characters |
| `peerGraceMs` | `0` | tolerate a stumbling connection instead of dropping it |
| `audioConstraints` | echo cancellation on | sending music rather than speech |
| `hostMigration` | `false` | a room that should outlive its host |
| `reconnectAttempts` | `3` | rebuild a failed connection, or do not |
| `url`, `anonKey` | read off the client | avoid undocumented fields |

Per call rather than per client: `topology` on `connect`, `tag`, `timeoutMs`
and `signal` on `queue`, `channel` reliability on `connect`, `maxPlayers` on a
room.

A search can be called off, which matters because the alternative is waiting out
a timeout after someone has already clicked away:

```js
const stop = new AbortController()
cancelButton.onclick = () => stop.abort()
const peer = await foyer.queue({ tag: 'chat', signal: stop.signal })
```

Aborting withdraws the advertisement too. A waiter still listed is a partner
somebody else is about to be handed.

Two things are deliberately not adjustable. **Topology has no default**,
because a wrong guess there produces a system that connects perfectly and is
quietly useless. And **voice is always a mesh**, because a star means everyone
hears the host and nobody hears each other — offering the choice would only
let someone pick the broken one.

## Status

Extracted from [netquake](https://github.com/jay23606/netquake) after building
the same peer-to-peer plumbing there a fourth time, and netquake is its first
consumer: its lobby, chat, moderation, identity and voice all run on this in
production.

What has actually run, and where:

| | proven by |
|---|---|
| rooms, lobby, chat, moderation, identity | netquake, in production |
| voice mesh | netquake, in production |
| `PeerNet` (data channels, mesh) | p2p-chat, two browsers on separate origins |
| queue (random pairing) | the claim function in SQL, plus two browsers |
| video | two browsers exchanging canvas-generated streams |
| topology rules, room codes | unit tests |

netquake keeps its own signalling broker rather than using `PeerNet`, because
its engine owns peer connections through its own interface and wants only the
offers and candidates.

ICE gives up for reasons that do not last -- a network changing hands, a laptop
waking -- so a failed connection is rebuilt rather than mourned. Only the side
that offered retries, because two ends rebuilding at once collide exactly as two
simultaneous offers do, and each attempt waits longer than the last.

When a host leaves, the room closes by default -- correct for a game whose host
is also the server, wrong for a conversation. `hostMigration` promotes the
longest-present player instead. Every client works out the same successor, so it
does not matter who notices first.

One gap worth knowing: video has been verified with synthetic streams rather
than a real camera, so the capture path itself is untested. The star topology
also has no consumer -- p2p-chat uses a mesh and netquake keeps its own broker.

The topology rules and room-code generation are covered by tests (`npm test`),
including the two properties a bug would break: that both peers agree a pair
should be wired, and that exactly one of them offers.

No TURN server, so peers behind symmetric NAT will not connect. Pass your own
`iceServers` if that matters to you.

MIT.

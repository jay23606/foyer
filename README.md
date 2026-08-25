# foyer

**Peer-to-peer rooms for Supabase.** Lobbies, presence, chat, moderation and
voice, with no server to deploy.

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

## Status

Early. The schema, identity and lobby layers are implemented. Peer connections
and the voice mesh are next; both exist in working form in
[netquake](https://github.com/jay23606/netquake), which is where this library
was extracted from after building the same thing eleven times.

No TURN server, so peers behind symmetric NAT will not connect. Pass your own
`iceServers` if that matters to you.

MIT.

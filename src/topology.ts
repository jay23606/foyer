import type { Topology } from './types.js'

// The two decisions that govern every peer connection, as pure functions.
//
// They live apart from PeerNet because they are the whole design and they are
// the only part of it that can be tested without a browser, a database and two
// live sessions. Getting either wrong produces a system that connects
// perfectly and is quietly useless, which is far harder to diagnose than one
// that fails outright -- so they are worth pinning down exactly.

/**
 * Should these two peers be connected at all?
 *
 * In a `star` only host-to-client pairs are wired: correct when one peer is
 * authoritative, and wrong for anything peers must exchange directly. In a
 * `mesh` everyone is wired to everyone.
 */
export const shouldConnect = (
	topology: Topology,
	selfId: string,
	hostId: string,
	peerId: string
): boolean =>
	topology === 'mesh'
		? peerId !== selfId
		: peerId !== selfId && (selfId === hostId || peerId === hostId)

/**
 * Which side sends the offer?
 *
 * Exactly one must, or both offer at once and the negotiation collides.
 *
 * In a `star` the client offers and the host answers, so the host never has to
 * know who is arriving before they arrive. In a `mesh` there is no host to
 * lean on, so the lower id offers -- both peers compute the same answer from
 * data they already hold, with no extra round trip.
 */
export const isOfferer = (
	topology: Topology,
	selfId: string,
	hostId: string,
	peerId: string
): boolean =>
	topology === 'star'
		? selfId !== hostId
		: selfId < peerId

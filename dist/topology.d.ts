import type { Topology } from './types.js';
/**
 * Should these two peers be connected at all?
 *
 * In a `star` only host-to-client pairs are wired: correct when one peer is
 * authoritative, and wrong for anything peers must exchange directly. In a
 * `mesh` everyone is wired to everyone.
 */
export declare const shouldConnect: (topology: Topology, selfId: string, hostId: string, peerId: string) => boolean;
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
export declare const isOfferer: (topology: Topology, selfId: string, hostId: string, peerId: string) => boolean;

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldConnect, isOfferer, makeCode, CODE_ALPHABET } from '../dist/index.js'

// These run against dist/ rather than src/, so they check what a consumer
// actually installs.

const HOST = 'host-id'
const A = 'aaa-client'
const B = 'bbb-client'
const C = 'ccc-client'

test('star wires clients to the host and nowhere else', () => {
	// The host reaches every client.
	assert.equal(shouldConnect('star', HOST, HOST, A), true)
	assert.equal(shouldConnect('star', HOST, HOST, B), true)
	// A client reaches the host.
	assert.equal(shouldConnect('star', A, HOST, HOST), true)
	// Clients do not reach each other. This is the line that makes voice on a
	// star useless, so it is the one most worth pinning down.
	assert.equal(shouldConnect('star', A, HOST, B), false)
	assert.equal(shouldConnect('star', B, HOST, A), false)
})

test('mesh wires everyone to everyone', () => {
	assert.equal(shouldConnect('mesh', A, HOST, B), true)
	assert.equal(shouldConnect('mesh', B, HOST, A), true)
	assert.equal(shouldConnect('mesh', A, HOST, HOST), true)
})

test('nobody connects to themselves, in either topology', () => {
	for (const t of ['star', 'mesh']) {
		assert.equal(shouldConnect(t, A, HOST, A), false, t)
		assert.equal(shouldConnect(t, HOST, HOST, HOST), false, t)
	}
})

test('shouldConnect is symmetric', () => {
	// If one side thinks the pair should be wired and the other does not, one
	// peer waits forever for an offer that is never sent.
	const ids = [HOST, A, B, C]
	for (const t of ['star', 'mesh']) {
		for (const x of ids) {
			for (const y of ids) {
				assert.equal(
					shouldConnect(t, x, HOST, y),
					shouldConnect(t, y, HOST, x),
					`${t}: ${x} vs ${y} disagree`
				)
			}
		}
	}
})

test('exactly one side of every pair offers', () => {
	// The property that prevents glare. If both sides offer at once the
	// negotiation collides; if neither does, nobody ever connects.
	const ids = [HOST, A, B, C]
	for (const t of ['star', 'mesh']) {
		for (const x of ids) {
			for (const y of ids) {
				if (x === y) continue
				if (!shouldConnect(t, x, HOST, y)) continue
				const forward = isOfferer(t, x, HOST, y)
				const back = isOfferer(t, y, HOST, x)
				assert.notEqual(forward, back, `${t}: ${x}/${y} both ${forward ? 'offer' : 'wait'}`)
			}
		}
	}
})

test('in a star the client offers, not the host', () => {
	// So the host never has to know who is arriving before they arrive.
	assert.equal(isOfferer('star', A, HOST, HOST), true)
	assert.equal(isOfferer('star', HOST, HOST, A), false)
})

test('room codes avoid characters people mishear', () => {
	assert.equal(/[O0I1]/.test(CODE_ALPHABET), false)
	for (let i = 0; i < 200; i += 1) {
		const code = makeCode()
		assert.equal(code.length, 5)
		assert.match(code, /^[A-Z2-9]+$/)
		assert.equal(/[O0I1]/.test(code), false)
	}
})

test('room codes honour a requested length', () => {
	assert.equal(makeCode(8).length, 8)
	assert.equal(makeCode(1).length, 1)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldConnect, isOfferer } from '../dist/index.js'

// Reconnection has no pure function to test, but it rests on one rule that
// does: only the side that offered retries. If that rule were wrong, both ends
// would rebuild at once and collide exactly as two simultaneous offers do.
//
// The retry itself needs two browsers and a network that fails on cue, which is
// not something a unit test can arrange. What is testable is the property the
// retry depends on, so that is what is pinned down here.

const HOST = 'host-id'
const A = 'aaa'
const B = 'bbb'
const C = 'ccc'

test('exactly one side of a pair would retry', () => {
	const ids = [HOST, A, B, C]
	for (const t of ['star', 'mesh']) {
		for (const x of ids) {
			for (const y of ids) {
				if (x === y || !shouldConnect(t, x, HOST, y)) continue
				const xRetries = isOfferer(t, x, HOST, y)
				const yRetries = isOfferer(t, y, HOST, x)
				assert.notEqual(
					xRetries, yRetries,
					`${t}: ${x}/${y} would both ${xRetries ? 'rebuild' : 'wait'}`
				)
			}
		}
	}
})

test('the retrying side is stable across attempts', () => {
	// Whoever offered first must be the one who offers again. If this drifted,
	// a second failure would be repaired by the other end and the two would
	// swap roles mid-recovery.
	for (let i = 0; i < 50; i += 1) {
		assert.equal(isOfferer('mesh', A, HOST, B), isOfferer('mesh', A, HOST, B))
		assert.equal(isOfferer('star', A, HOST, HOST), isOfferer('star', A, HOST, HOST))
	}
})

test('a star never asks two clients to reconnect to each other', () => {
	// They were never connected, so a retry between them would be building
	// something that should not exist.
	assert.equal(shouldConnect('star', A, HOST, B), false)
	assert.equal(shouldConnect('star', B, HOST, C), false)
})

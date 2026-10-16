const assert = require('node:assert/strict')
const { mkdtemp, readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { test } = require('node:test')
const { FileStore } = require('../cjs/fastify-file-session-store')
const get = (store, id) => new Promise((resolve, reject) =>
	store.get(id, (error, value) => error ? reject(error) : resolve(value)))
const set = (store, id, value) => new Promise((resolve, reject) =>
	store.set(id, value, error => error ? reject(error) : resolve()))
const fixture = async () => new FileStore(await mkdtemp(join(tmpdir(), 'session-transactions-')))

test('nested mutation is durable and store instances never share cached identity', async () => {
	const store = await fixture()
	await set(store, 'one', { propertySelect: { key: { revision: 1 } } })
	const loaded = await get(store, 'one')
	loaded.propertySelect.key.revision = 2
	await set(store, 'one', loaded)
	assert.equal(JSON.parse(await readFile(store.sessionFile('one'))).propertySelect.key.revision, 2)
	assert.equal((await get(new FileStore(store.directory), 'one')).propertySelect.key.revision, 2)
	const other = await fixture()
	assert.equal(await get(other, 'one'), undefined)
	await set(other, 'one', { value: 'separate directory' })
	assert.equal((await get(store, 'one')).propertySelect.key.revision, 2)
})

test('concurrent autosaves merge changed leaves and transactions retain every namespace', async () => {
	const store = await fixture()
	await set(store, 'one', { list: { invoice: { columns: ['number'], offset: 0 } } })
	const [a, b, c, d] = await Promise.all(Array.from({ length: 4 }, () => get(store, 'one')))
	a.list.invoice.columns = ['number', 'customer.name']
	b.list.invoice.offset = 50
	await Promise.all([
		set(store, 'one', a), set(store, 'one', b),
		store.transact('one', c, data => { data.propertySelect = { ...(data.propertySelect ?? {}), a: { revision: 1 } } }),
		store.transact('one', d, data => { data.propertySelect = { ...(data.propertySelect ?? {}), b: { revision: 1 } } })
	])
	const result = await get(new FileStore(store.directory), 'one')
	assert.deepEqual(result.list.invoice, { columns: ['number', 'customer.name'], offset: 50 })
	assert.deepEqual(result.propertySelect, { a: { revision: 1 }, b: { revision: 1 } })
	assert.equal(store.locks.size, 0)
})

test('revocation, expiry and missing reload reject every stale generation', async () => {
	const store = await fixture()
	await set(store, 'revoked', { value: 1 })
	const stale = await get(store, 'revoked')
	await store.revoke('revoked')
	await assert.rejects(set(store, 'revoked', stale), { code: 'SESSION_STALE' })
	await assert.rejects(store.refresh('revoked', stale), { code: 'SESSION_STALE' })
	assert.equal(await get(store, 'revoked'), undefined)
	await set(store, 'expired', { cookie: { expires: new Date(Date.now() + 30).toISOString() }, value: 1 })
	const expired = await get(store, 'expired')
	await new Promise(resolve => setTimeout(resolve, 50))
	await assert.rejects(set(store, 'expired', expired), { code: 'SESSION_STALE' })
	assert.equal(await get(store, 'expired'), undefined)
})

test('failed durable writes do not publish mutated snapshots or retain locks', async () => {
	const store = await fixture()
	await set(store, 'one', { value: 1 })
	const session = await get(store, 'one')
	const original = store.persist
	store.persist = async () => { throw new Error('synthetic disk failure') }
	await assert.rejects(store.transact('one', session, data => { data.value = 2 }), /disk failure/)
	assert.equal(session.value, 1)
	store.persist = original
	assert.equal((await get(store, 'one')).value, 1)
	await store.transact('one', session, data => { data.value = 3 })
	assert.equal((await get(store, 'one')).value, 3)
	assert.equal(store.locks.size, 0)
})

test('malformed storage rejects rather than recreating an authoritative session', async () => {
	const store = await fixture()
	await writeFile(store.sessionFile('one'), '{broken')
	await assert.rejects(get(store, 'one'), SyntaxError)
	await assert.rejects(set(store, 'one', { value: 1 }), SyntaxError)
})


test('expiry during an outstanding transaction rejects its commit', async () => {
	const store = await fixture()
	await set(store, 'one', { cookie: { expires: new Date(Date.now() + 60).toISOString() }, value: 1 })
	const session = await get(store, 'one')
	await assert.rejects(store.transact('one', session, async data => {
		data.value = 2
		await new Promise(resolve => setTimeout(resolve, 80))
	}), { code: 'SESSION_STALE' })
	assert.equal(await get(store, 'one'), undefined)
})

test('concurrent transactions using the same request object preserve both queued updates', async () => {
	const store = await fixture()
	const session = { list: { invoice: { columns: ['number'] } } }
	await Promise.all([
		store.transact('one', session, data => { data.first = true }),
		store.transact('one', session, data => { data.second = true })
	])
	const loaded = await get(store, 'one')
	assert.equal(loaded.first, true)
	assert.equal(loaded.second, true)
	await Promise.all([
		store.transact('one', loaded, data => { data.third = true }),
		store.transact('one', loaded, data => { data.fourth = true })
	])
	const result = await get(store, 'one')
	assert.equal(result.third, true)
	assert.equal(result.fourth, true)
	assert.deepEqual(result.list, session.list)
})

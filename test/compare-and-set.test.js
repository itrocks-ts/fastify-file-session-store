const assert = require('node:assert/strict')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { afterEach, test } = require('node:test')
const { FileStore } = require('../cjs/fastify-file-session-store')
const metadata = '__fastifySessionMetadata'
const directories = []
const fixture = async () => {
	const directory = await mkdtemp(join(tmpdir(), 'session-cas-'))
	directories.push(directory)
	return new FileStore(directory)
}
const get = (store, id) => new Promise((resolve, reject) =>
	store.get(id, (error, session) => error ? reject(error) : resolve(session)))
const set = (store, id, session) => new Promise((resolve, reject) =>
	store.set(id, session, error => error ? reject(error) : resolve()))
const cas = (store, id, generation, session) => new Promise((resolve, reject) =>
	store.compareAndSet(id, generation, session, error => error ? reject(error) : resolve()))
const session = (generation, data = {}) => Object.defineProperty(data, metadata, {
	enumerable: true, value: Object.freeze({ generation })
})
afterEach(async () => Promise.all(
	directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
))

test('CAS merges concurrent saves of the same generation and preserves immutable Fastify metadata', async () => {
	const store = await fixture()
	const initial = session('first', { list: { columns: ['name'], offset: 0 } })
	await set(store, 'file', initial)
	const a = await get(store, 'file')
	const b = await get(store, 'file')
	a.list.columns = ['email']
	b.list.offset = 50
	await Promise.all([cas(store, 'file', 'first', a), cas(store, 'file', 'first', b)])
	const saved = JSON.parse(await readFile(store.sessionFile('file'), 'utf8'))
	assert.deepEqual(saved.list, { columns: ['email'], offset: 50 })
	assert.equal(saved[metadata].generation, 'first')
	assert.deepEqual((await store.list())[0].data, { list: saved.list })
	assert.equal(initial[metadata].generation, 'first')
	assert.equal(store.locks.size, 0)
})

test('rotation replaces business data and rejects old Fastify and transaction leases', async () => {
	const store = await fixture()
	await set(store, 'file', session('first', { user: 'old', oldState: true }))
	const stale = await get(store, 'file')
	await cas(store, 'file', 'first', session('second', { user: 'new' }))
	await assert.rejects(cas(store, 'file', 'first', stale), { code: 'ENOENT' })
	await assert.rejects(set(store, 'file', stale), { code: 'SESSION_STALE' })
	await assert.rejects(store.refresh('file', stale), { code: 'SESSION_STALE' })
	const saved = await get(new FileStore(store.directory), 'file')
	assert.equal(saved.user, 'new')
	assert.equal(saved.oldState, undefined)
	assert.equal(saved[metadata].generation, 'second')
})

test('a generation-checked replacement without a lease preserves leases of the same Fastify generation', async () => {
	const store = await fixture()
	await set(store, 'file', session('first', { first: 1 }))
	const loaded = await get(store, 'file')
	await cas(store, 'file', 'first', session('first', { second: 2 }))
	loaded.third = 3
	await cas(store, 'file', 'first', loaded)
	const saved = await get(store, 'file')
	assert.equal(saved.first, undefined)
	assert.equal(saved.second, 2)
	assert.equal(saved.third, 3)
})

test('only one concurrent rotation succeeds and revocation cannot be undone by a pending CAS', async () => {
	const store = await fixture()
	await set(store, 'file', session('first'))
	const results = await Promise.allSettled([
		cas(store, 'file', 'first', session('second')), cas(store, 'file', 'first', session('third'))
	])
	assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
	assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ENOENT')
	const current = await get(store, 'file')
	const revoke = store.revoke('file')
	const save = cas(store, 'file', current[metadata].generation, current)
	await revoke
	await assert.rejects(save, { code: 'ENOENT' })
	assert.equal(await get(store, 'file'), undefined)
})

test('missing and expired sessions reject CAS; legacy sessions use their storage id as generation', async () => {
	const store = await fixture()
	await assert.rejects(cas(store, 'absent', 'absent', session('new')), { code: 'ENOENT' })
	await set(store, 'expired', session('first', { cookie: { expires: new Date(Date.now() - 1000).toISOString() } }))
	await assert.rejects(cas(store, 'expired', 'first', session('new')), { code: 'ENOENT' })
	await set(store, 'legacy', { user: 'old-cookie' })
	const legacy = await get(store, 'legacy')
	legacy.user = 'migrated'
	await cas(store, 'legacy', 'legacy', legacy)
	assert.equal((await get(store, 'legacy')).user, 'migrated')
})

test('CAS acknowledges only durable writes, keeps prior state on failure and propagates corruption', async () => {
	const store = await fixture()
	await set(store, 'file', session('first', { value: 1 }))
	const current = await get(store, 'file')
	current.value = 2
	const persist = store.persist
	store.persist = async () => { throw Object.assign(new Error('Disk failure'), { code: 'EIO' }) }
	await assert.rejects(cas(store, 'file', 'first', current), { code: 'EIO' })
	store.persist = persist
	assert.equal((await get(store, 'file')).value, 1)
	await cas(store, 'file', 'first', current)
	assert.equal((await get(store, 'file')).value, 2)
	await writeFile(store.sessionFile('file'), '{broken')
	await assert.rejects(cas(store, 'file', 'first', current), SyntaxError)
	assert.equal(store.locks.size, 0)
})

test('new-session transactions update the live session without exposing reserved metadata', async () => {
	const store = await fixture()
	const current = session('first')
	await store.transact('file', current, data => {
		data.state = { revision: 1 }
		data[metadata] = { generation: 'forged' }
	})
	assert.deepEqual(current.state, { revision: 1 })
	assert.equal(current[metadata].generation, 'first')
	assert.equal((await get(store, 'file'))[metadata].generation, 'first')
})

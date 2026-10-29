const assert = require('node:assert/strict')
const Fastify = require('fastify')
const cookiePlugin = require('@fastify/cookie')
const sessionPlugin = require(process.env.FASTIFY_SESSION_MODULE || '@fastify/session')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { FileStore } = require('../cjs/fastify-file-session-store')
const deferred = () => {
	let resolve
	const promise = new Promise(done => { resolve = done })
	return { promise, resolve }
}
const get = (store, id) => new Promise((resolve, reject) =>
	store.get(id, (error, value) => error ? reject(error) : resolve(value)))
const set = (store, id, value) => new Promise((resolve, reject) =>
	store.set(id, value, error => error ? reject(error) : resolve()))
const cookieOf = response => response.headers['set-cookie'].split(';')[0]

test('real session plugin persists, reloads, rotates, migrates legacy cookies and destroys sessions', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'fastify-cas-'))
	const store = new FileStore(directory)
	const app = Fastify()
	const acquired = deferred()
	const release = deferred()
	const secret = 'actual-session-contract-test-secret-at-least-32-characters'
	await app.register(cookiePlugin)
	await app.register(sessionPlugin, { secret, cookie: { secure: false }, store })
	app.get('/seed', async request => {
		request.session.user = 'alice'
		request.session.private = 'discard on rotation'
		return { user: request.session.user }
	})
	app.get('/read', async request => {
		await request.session.reload()
		return { user: request.session.user, private: request.session.private,
			id: request.session.sessionId, storage: request.session.sessionStoreId ?? request.session.sessionId }
	})
	app.get('/rotate', async request => {
		await request.session.regenerate(['user'])
		await request.session.save()
		return { user: request.session.user, private: request.session.private,
			id: request.session.sessionId, storage: request.session.sessionStoreId ?? request.session.sessionId }
	})
	app.get('/slow', async request => {
		acquired.resolve()
		await release.promise
		request.session.user = 'obsolete'
		try { await request.session.save(); return { saved: true } }
		catch (error) {
			request.session = null
			return { error: error.code }
		}
	})
	app.get('/destroy', async request => { await request.session.destroy(); return {} })
	try {
		await app.ready()
		const seeded = await app.inject('/seed')
		assert.equal(seeded.statusCode, 200)
		const oldCookie = cookieOf(seeded)
		const old = await app.inject({ url: '/read', headers: { cookie: oldCookie } })
		assert.equal(old.statusCode, 200)
		const before = old.json()
		const slow = app.inject({ url: '/slow', headers: { cookie: oldCookie } })
		await acquired.promise
		const rotated = await app.inject({ url: '/rotate', headers: { cookie: oldCookie } })
		assert.equal(rotated.statusCode, 200, rotated.body)
		const after = rotated.json()
		assert.equal(after.user, 'alice')
		assert.equal(after.private, undefined)
		assert.notEqual(after.id, before.id)
		const newCookie = cookieOf(rotated)
		release.resolve()
		const stale = (await slow).json()
		assert.ok(['ENOENT', 'SESSION_STALE'].includes(stale.error))
		const saved = await get(new FileStore(directory), after.storage)
		assert.equal(saved.user, 'alice')
		assert.equal(saved.private, undefined)
		assert.equal((await app.inject({ url: '/read', headers: { cookie: oldCookie } })).json().user, undefined)
		assert.equal((await app.inject({ url: '/read', headers: { cookie: newCookie } })).json().user, 'alice')
		await app.inject({ url: '/destroy', headers: { cookie: newCookie } })
		assert.equal(await get(store, after.storage), undefined)
		await set(store, 'legacy', { user: 'legacy-user' })
		const signer = new cookiePlugin.Signer(secret)
		const legacyCookie = 'sessionId=' + encodeURIComponent(signer.sign('legacy'))
		const legacy = await app.inject({ url: '/rotate', headers: { cookie: legacyCookie } })
		assert.equal(legacy.statusCode, 200, legacy.body)
		assert.equal(legacy.json().user, 'legacy-user')
		assert.equal((await app.inject({ url: '/read', headers: { cookie: cookieOf(legacy) } })).json().user,
			'legacy-user')
	}
	finally {
		release.resolve()
		await app.close()
		await rm(directory, { recursive: true, force: true })
	}
})

const assert           = require('node:assert/strict')
const { mkdtemp }      = require('node:fs/promises')
const { readFile }     = require('node:fs/promises')
const { stat }         = require('node:fs/promises')
const { tmpdir }       = require('node:os')
const { join }         = require('node:path')
const { describe, it } = require('node:test')
const { FileStore }    = require('../cjs/fastify-file-session-store')

function destroy(store, sessionId)
{
	return new Promise((resolve, reject) => store.destroy(sessionId, error => error ? reject(error) : resolve()))
}

function set(store, sessionId, session)
{
	return new Promise((resolve, reject) => store.set(sessionId, session, error => error ? reject(error) : resolve()))
}

describe('FileStore', () => {
	it('creates private storage and revokes sessions idempotently', async () => {
		const parent    = await mkdtemp(join(tmpdir(), 'itrocks-session-'))
		const directory = join(parent, 'sessions')
		const store     = new FileStore(directory)

		await set(store, 'secret-session-id', { user: { id: 42 } })

		assert.equal((await stat(directory)).mode & 0o777, 0o700)
		assert.equal((await stat(join(directory, 'secret-session-id'))).mode & 0o777, 0o600)
		assert.deepEqual(JSON.parse(await readFile(join(directory, 'secret-session-id'), 'utf8')), { user: { id: 42 } })

		await destroy(store, 'secret-session-id')
		await destroy(store, 'secret-session-id')
	})
})

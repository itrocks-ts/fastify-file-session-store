import { SessionStore }                           from '@fastify/session'
import { SessionStore as ManageableSessionStore } from '@itrocks/session'
import { StoredSession }                          from '@itrocks/session'
import { Session }                                from 'fastify'
import { randomUUID }                             from 'node:crypto'
import { chmod }                                  from 'node:fs/promises'
import { mkdir }                                  from 'node:fs/promises'
import { readdir }                                from 'node:fs/promises'
import { readFile }                               from 'node:fs/promises'
import { rename }                                 from 'node:fs/promises'
import { stat }                                   from 'node:fs/promises'
import { unlink }                                 from 'node:fs/promises'
import { writeFile }                              from 'node:fs/promises'

type Data = Record<string, any>
type Lease = { base: Data; generation: string }
const fastifyMarker = '__fastifySessionMetadata'
const marker = '__itrocksSessionGeneration'

function snapshot(session: Data): Data
{
	return JSON.parse(JSON.stringify(Object.fromEntries(
		Object.entries(session).filter(([key]) => key !== marker && key !== fastifyMarker)
	)))
}

// Apply only changes made by this request; unrelated concurrent namespaces survive autosave.
function merge(base: Data, local: Data, current: Data): Data
{
	const result = structuredClone(current)
	for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
		if (JSON.stringify(base[key]) === JSON.stringify(local[key])) continue
		if (!(key in local)) delete result[key]
		else if ((base[key] === undefined || plain(base[key])) && plain(local[key]) && plain(current[key]))
			Object.defineProperty(result, key, {
				configurable: true, enumerable: true, writable: true, value: merge(base[key] ?? {}, local[key], current[key])
			})
		else Object.defineProperty(result, key, {
			configurable: true, enumerable: true, writable: true, value: structuredClone(local[key])
		})
	}
	return result
}

function plain(value: unknown): value is Data
{
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

export class SessionExpiredError extends Error
{

	readonly code = 'SESSION_STALE'
	constructor()
	{
		super('The session has expired or been revoked')
	}

}

/** Single-process transactions. Every durable write, autosave and revocation shares the same session lock. */
export class FileStore implements ManageableSessionStore, SessionStore
{

	private readonly leases = new WeakMap<object, Lease>()
	private readonly locks = new Map<string, Promise<unknown>>()

	constructor(public directory: string)
	{
	}

	compareAndSet(sessionId: string, expectedGeneration: string, session: Session, callback: (error?: any) => void): void
	{
		this.write(sessionId, session, () => {}, { generation: expectedGeneration }).then(() => callback(), error => {
			if (error instanceof SessionExpiredError) {
				error = Object.assign(new Error('The session does not exist or has changed'), { code: 'ENOENT' })
			}
			callback(error)
		})
	}

	destroy(sessionId: string, callback: (error?: any) => void): void
	{
		this.revoke(sessionId).then(() => callback(), callback)
	}

	get(sessionId: string, callback: (error: any, session?: Session | null) => void): void
	{
		this.lock(sessionId, async () => {
			const data = await this.read(sessionId)
			if (!data) return undefined
			// Migrate a legacy session before issuing a lease for it.
			if (!data[marker]) {
				data[marker] = { generation: randomUUID() }
				await this.persist(sessionId, data)
			}
			this.attach(data, data[marker].generation, snapshot(data))
			return data as Session
		}).then(session => callback(null, session), callback)
	}

	private attach(session: Data, generation: string, base: Data): void
	{
		const token = { generation }
		session[marker] = token
		this.leases.set(token, { base: structuredClone(base), generation })
	}

	async list(): Promise<StoredSession[]>
	{
		let files
		try { files = await readdir(this.directory, { withFileTypes: true }) }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
			throw error
		}
		const result: StoredSession[] = []
		for (const file of files) {
			if (!file.isFile() || file.name.startsWith('.')) continue
			await this.lock(file.name, async () => {
				const data = await this.read(file.name)
				if (data) result.push({
					data: snapshot(data), id: file.name, updatedAt: (await stat(this.sessionFile(file.name))).mtime
				})
			})
		}
		return result
	}

	private async lock<T>(id: string, operation: () => Promise<T>): Promise<T>
	{
		this.sessionFile(id)
		const previous = this.locks.get(id) ?? Promise.resolve()
		const next = previous.catch(() => {}).then(operation)
		this.locks.set(id, next)
		try { return await next }
		finally { if (this.locks.get(id) === next) this.locks.delete(id) }
	}

	private async persist(id: string, data: Data): Promise<void>
	{
		await mkdir(this.directory, { mode: 0o700, recursive: true })
		await chmod(this.directory, 0o700)
		const temporary = `${this.directory}/.${randomUUID()}.tmp`
		try {
			await writeFile(temporary, JSON.stringify(data), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
			await rename(temporary, this.sessionFile(id))
		}
		finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
	}

	private async read(id: string): Promise<Data | undefined>
	{
		let data: Data
		try { data = JSON.parse(await readFile(this.sessionFile(id), 'utf8')) }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
			throw error
		}
		const expiry = data.cookie?.expires
		if (expiry && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now())) {
			await unlink(this.sessionFile(id))
			return undefined
		}
		return data
	}

	async refresh(sessionId: string, session: Data): Promise<void>
	{
		await this.lock(sessionId, async () => {
			const lease = this.leases.get(session[marker])
			const stored = await this.read(sessionId)
			if (!lease || !stored || stored[marker]?.generation !== lease.generation) throw new SessionExpiredError()
			for (const key of Object.keys(session))
				if (key !== 'cookie' && key !== marker && key !== fastifyMarker) delete session[key]
			for (const [key, value] of Object.entries(snapshot(stored))) if (key !== 'cookie') session[key] = value
			this.attach(session, lease.generation, snapshot(stored))
		})
	}

	async revoke(sessionId: string): Promise<void>
	{
		await this.lock(sessionId, async () => {
			await unlink(this.sessionFile(sessionId)).catch(error => { if (error.code !== 'ENOENT') throw error })
		})
	}

	sessionFile(sessionId: string): string
	{
		if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('Invalid session identifier')
		return this.directory + '/' + sessionId
	}

	set(sessionId: string, session: Session, callback: (error?: any) => void): void
	{
		this.transact(sessionId, session, () => {}).then(() => callback(), callback)
	}

	async transact<T>(sessionId: string, session: Data, operation: (data: Data) => T | Promise<T>): Promise<T>
	{
		return this.write(sessionId, session, operation)
	}

	private async write<T>(
		sessionId: string, session: Data, operation: (data: Data) => T | Promise<T>, expected?: { generation: string }
	): Promise<T>
	{
		// Capture synchronously: callers cannot change a pending write through a retained nested reference.
		const local = snapshot(session)
		const fastifyGeneration = session[fastifyMarker]?.generation
		const initialToken = session[marker]
		const baseline = this.leases.get(initialToken)?.base ?? {}
		return this.lock(sessionId, async () => {
			const token = session[marker]
			const lease = token && this.leases.get(token)
			const stored = await this.read(sessionId)
			const previousGeneration = stored?.[fastifyMarker]?.generation ?? sessionId
			if (expected && (!stored || previousGeneration !== expected.generation)) throw new SessionExpiredError()
			if (token && (!lease || !stored || stored[marker]?.generation !== lease.generation))
				throw new SessionExpiredError()
			if (!token && stored && !expected) throw new SessionExpiredError()
			const nextGeneration = fastifyGeneration ?? stored?.[fastifyMarker]?.generation
			const rotating = expected && nextGeneration !== previousGeneration
			const generation = rotating ? randomUUID() : (lease?.generation ?? stored?.[marker]?.generation ?? randomUUID())
			const data = lease && !rotating ? merge(baseline, local, snapshot(stored!)) : structuredClone(local)
			const result = await operation(data)
			// An operation may cross the absolute expiry while holding the lock.
			if (stored?.cookie?.expires && Date.parse(stored.cookie.expires) <= Date.now())
				throw new SessionExpiredError()
			delete data[fastifyMarker]
			delete data[marker]
			await this.persist(sessionId, {
				...data,
				...(nextGeneration === undefined ? {} : { [fastifyMarker]: { generation: nextGeneration } }),
				[marker]: { generation }
			})
			// Keep framework session methods/cookie instances intact. Merge edits made during the await.
			const updated = merge(local, snapshot(session), data)
			for (const key of Object.keys(session))
				if (key !== 'cookie' && key !== marker && key !== fastifyMarker) delete session[key]
			for (const [key, value] of Object.entries(updated)) if (key !== 'cookie') session[key] = value
			this.attach(session, generation, data)
			return result
		})
	}

}

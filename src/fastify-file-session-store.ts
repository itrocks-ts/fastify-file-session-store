import { SessionStore } from '@fastify/session'

import { SessionStore as ManageableSessionStore } from '@itrocks/session'
import { StoredSession }                          from '@itrocks/session'

import { Session } from 'fastify'

import { chmod }     from 'node:fs/promises'
import { mkdir }     from 'node:fs/promises'
import { readdir }   from 'node:fs/promises'
import { readFile }  from 'node:fs/promises'
import { stat }      from 'node:fs/promises'
import { unlink }    from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'

const cache: Record<string, Session> = {}

export class FileStore implements ManageableSessionStore, SessionStore
{

	constructor(public directory: string)
	{}

	destroy(sessionId: string, callback: (error?: any) => void)
	{
		this.revoke(sessionId).then(() => callback()).catch(callback)
	}

	get(sessionId: string, callback: (error: any, session?: Session | null) => void)
	{
		if (cache[sessionId]) {
			return callback(null, cache[sessionId])
		}
		readFile(this.sessionFile(sessionId))
			.then((data: Buffer | void) => {
				if (!data) {
					return callback(null)
				}
				const stringData = data + ''
				if (!stringData.length) {
					return callback(null)
				}
				let session: Session
				try {
					session = JSON.parse(stringData)
				}
				catch {
					return callback(null)
				}
				cache[sessionId] = session
				callback(null, session)
			})
			.catch(_error => { callback(null) })
	}

	async list(): Promise<StoredSession[]>
	{
		let files
		try {
			files = await readdir(this.directory, { withFileTypes: true })
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
			throw new Error('Unable to list sessions')
		}

		const sessions = await Promise.all(files
			.filter(file => file.isFile())
			.map(async file => {
				const session = await this.read(file.name)
				if (!session) return
				try {
					return {
						data:      session as unknown as Record<string, unknown>,
						id:        file.name,
						updatedAt: (await stat(this.sessionFile(file.name))).mtime
					}
				}
				catch {
					return
				}
			})
		)
		return sessions.filter(session => session !== undefined)
	}

	private read(sessionId: string): Promise<Session | undefined>
	{
		return new Promise(resolve => this.get(sessionId, (_error, session) => resolve(session ?? undefined)))
	}

	async revoke(sessionId: string): Promise<void>
	{
		delete cache[sessionId]
		try {
			await unlink(this.sessionFile(sessionId))
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw new Error('Unable to revoke the session')
			}
		}
	}

	sessionFile(sessionId: string)
	{
		return this.directory + '/' + sessionId
	}

	set(sessionId: string, session: Session, callback: (error?: any) => void)
	{
		const string = JSON.stringify(session)
		if (cache[sessionId] && (string === JSON.stringify(cache[sessionId]))) {
			return callback()
		}
		cache[sessionId] = session
		mkdir(this.directory, { mode: 0o700, recursive: true })
			.then(() => chmod(this.directory, 0o700))
			.then(() => writeFile(
				this.sessionFile(sessionId), JSON.stringify(session), { encoding: 'utf8', mode: 0o600 }
			))
			.then(() => chmod(this.sessionFile(sessionId), 0o600))
			.then(callback)
			.catch(() => callback(new Error('Unable to persist the session')))
	}

}

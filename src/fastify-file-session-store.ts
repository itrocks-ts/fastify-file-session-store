import { SessionStore } from '@fastify/session'
import { Session }      from 'fastify'
import { chmod }        from 'node:fs/promises'
import { mkdir }        from 'node:fs/promises'
import { readFile }     from 'node:fs/promises'
import { unlink }       from 'node:fs/promises'
import { writeFile }    from 'node:fs/promises'

const cache: Record<string, Session> = {}

export class FileStore implements SessionStore
{

	constructor(public directory: string)
	{}

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
			.then(() => writeFile(this.sessionFile(sessionId), JSON.stringify(session), { encoding: 'utf8', mode: 0o600 }))
			.then(() => chmod(this.sessionFile(sessionId), 0o600))
			.then(callback)
			.catch(() => callback(new Error('Unable to persist the session')))
	}

	get(sessionId: string, callback: (error: any, session?: Session | null) => void)
	{
		if (cache[sessionId]) {
			return callback(null, cache[sessionId])
		}
		readFile(this.sessionFile(sessionId))
			.then((data: Buffer|void) => {
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

	destroy(sessionId: string, callback: (error?: any) => void)
	{
		delete cache[sessionId]
		unlink(this.sessionFile(sessionId))
			.then(callback)
			.catch(error => ((error as NodeJS.ErrnoException).code === 'ENOENT')
				? callback()
				: callback(new Error('Unable to revoke the session'))
			)
	}

}

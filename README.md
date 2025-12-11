[![npm version](https://img.shields.io/npm/v/@itrocks/fastify-file-session-store?logo=npm)](https://www.npmjs.org/package/@itrocks/fastify-file-session-store)
[![npm downloads](https://img.shields.io/npm/dm/@itrocks/fastify-file-session-store)](https://www.npmjs.org/package/@itrocks/fastify-file-session-store)
[![GitHub](https://img.shields.io/github/last-commit/itrocks-ts/fastify-file-session-store?color=2dba4e&label=commit&logo=github)](https://github.com/itrocks-ts/fastify-file-session-store)
[![issues](https://img.shields.io/github/issues/itrocks-ts/fastify-file-session-store)](https://github.com/itrocks-ts/fastify-file-session-store/issues)
[![discord](https://img.shields.io/discord/1314141024020467782?color=7289da&label=discord&logo=discord&logoColor=white)](https://25.re/ditr)

# fastify-file-session-store

Simple session data persistence for Fastify using JSON files.

*This documentation was written by an artificial intelligence and may contain errors or approximations.
It has not yet been fully reviewed by a human. If anything seems unclear or incomplete,
please feel free to contact the author of this package.*

## Installation

```bash
npm i @itrocks/fastify-file-session-store @fastify/session fastify
```

`@itrocks/fastify-file-session-store` does not install `fastify` or
`@fastify/session` as direct dependencies of your application: you must declare
them yourself in your project.

## Usage

`FileStore` is an implementation of `SessionStore` for
[`@fastify/session`](https://github.com/fastify/session) that stores each
session as a JSON file on disk. It is intended for simple Fastify
applications, where lightweight session persistence is enough and you do not
want to set up a dedicated database.

### Minimal example

```ts
import Fastify from 'fastify'
import fastifySession from '@fastify/session'
import { FileStore } from '@itrocks/fastify-file-session-store'

const app = Fastify()

app.register(fastifySession, {
  secret: 'a very secret key with at least 32 characters',
  cookie: {
    secure: false, // set to true when running behind HTTPS
  },
  store: new FileStore('./sessions'),
})

app.get('/', async (request, reply) => {
  request.session.views = (request.session.views ?? 0) + 1
  return { views: request.session.views }
})

app.listen({ port: 3000 })
  .then(() => console.log('Server listening on http://localhost:3000'))
```

### Complete and realistic example

The following example shows a more advanced configuration using
[`node:path`](https://nodejs.org/api/path.html) to define a sessions
directory, basic error handling, and reuse of the same store across several
routes.

```ts
import Fastify from 'fastify'
import fastifySession from '@fastify/session'
import { FileStore } from '@itrocks/fastify-file-session-store'
import { join, normalize } from 'node:path'

const app = Fastify({ logger: true })

// Absolute path to the sessions directory, for example in a data folder
const sessionDir = normalize(join(__dirname, '../data/sessions'))

app.register(fastifySession, {
  secret: process.env.SESSION_SECRET ?? 'change-me-in-production',
  cookie: {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
  store: new FileStore(sessionDir),
})

app.get('/login', async (request, reply) => {
  const userId = request.query.userId ?? 'guest'
  request.session.user = { id: userId }
  return { ok: true, user: request.session.user }
})

app.get('/me', async (request, reply) => {
  if (!request.session.user) {
    reply.code(401)
    return { error: 'Not authenticated' }
  }
  return { user: request.session.user }
})

app.get('/logout', async (request, reply) => {
  // Destroy the session in the store and in the cookie
  await request.session.destroy()
  return { ok: true }
})

app.listen({ port: 3000 }).catch((error) => {
  app.log.error(error, 'Cannot start server')
  process.exit(1)
})
```

## API

### `class FileStore implements SessionStore`

Implementation of `SessionStore` (the `@fastify/session` interface) that saves
sessions into individual JSON files.

Each session id corresponds to a file in the directory provided to the
constructor. An in-memory cache is used to avoid unnecessary disk access when
the session has not changed.

#### `new FileStore(directory: string)`

- `directory`: path to the directory where session files will be created. It
  can be relative to the current process directory or absolute. The directory
  must exist and be readable and writable by the Node.js process.

Returns a `FileStore` instance to pass to the `store` option of
`@fastify/session`.

#### `sessionFile(sessionId: string): string`

Builds the full path to the session file corresponding to `sessionId`. This
method is exposed publicly but is generally only useful if you want to
diagnose or manipulate the session files manually.

#### `set(sessionId: string, session: Session, callback: (error?: any) => void): void`

Method called by `@fastify/session` when a session must be stored.

- `sessionId`: unique identifier of the session.
- `session`: `Session` object provided by Fastify, serializable to JSON.
- `callback(error?)`: function to call once the write is finished or in case
  of error.

The store serializes the session to JSON and writes it to a file. If the
content has not changed since the last write, the file is not rewritten and
the callback is called immediately.

#### `get(sessionId: string, callback: (error: any, session?: Session | null) => void): void`

Method called by `@fastify/session` to load an existing session.

- `sessionId`: identifier of the session to read.
- `callback(error, session?)`:
  - `error` is `null` or `undefined` when everything went well;
  - `session` is:
    - the `Session` object that was found;
    - `null`/`undefined` when no valid session exists for that id.

The store reads the corresponding session file, parses it as JSON and returns
the session.

If a read or parse error occurs, no exception is thrown: the callback is
called with `error` set to `null` and without a session, which
`@fastify/session` interprets as "no session".

#### `destroy(sessionId: string, callback: (error?: any) => void): void`

Removes the corresponding session from memory and from disk.

- `sessionId`: identifier of the session to destroy.
- `callback(error?)`: function called after the deletion, or with an error if
  something went wrong.

This method is typically called when a user logs out or when the session
expires.

## Typical use cases

- **Simple Fastify projects without a dedicated session database**: you want
  session persistence across server restarts, but you do not want to set up
  Redis, a SQL database or another external service.
- **Development or demo environments**: file-based persistence is convenient
  to quickly test an application or share a local demo.
- **Single-instance applications**: when your application runs on a single
  machine (or with a shared filesystem) and you do not need session
  consistency across several nodes.
- **Session debugging**: because sessions are stored as JSON files, you can
  open the file corresponding to a given `sessionId` to inspect or debug the
  session state.

import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';

import { createApp, type CreateAppOptions } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { cardSyncActorRef } from '../services/cardSyncDigests.js';
import { CardSyncScenario } from './cardSyncScenario.js';
import { listenLoopback } from './loopback.js';

/**
 * The real app (createApp) over a card-sync scenario's repository, on the
 * scenario's clock, with one signed-in owner: E2a's route tests drive the
 * owner API exactly as the web client does (session cookie, Origin and
 * X-Holdr-Request on writes). Synthetic data only.
 */

export const OWNER_ORIGIN = 'http://localhost:5173';
export const OWNER_PASSWORD = 'correct horse battery staple';
export const OWNER_SERVICE_TOKEN = 'c3'.repeat(32);
const FAST_SCRYPT = { ln: 10, r: 8, p: 1 };

export class CardSyncOwnerWorld extends CardSyncScenario {
  app!: Express;
  cookie!: string;
  /** The signed-in owner as the card ledger names actors. */
  owner!: string;
  readonly logs: string[] = [];

  /**
   * `gate: 'open'` (default) hands extension sets' plans the database's generation; `'not-wired'` is createApp's default.
   * `authorization` passes E2b's owner authorization options (its gate, origin and device API) to createApp.
   */
  static async create(options: {
    gate?: 'open' | 'not-wired'; file?: string;
    authorization?: (world: CardSyncOwnerWorld) => CreateAppOptions['cardSyncAuthorization'];
  } = {}): Promise<CardSyncOwnerWorld> {
    const world = new CardSyncOwnerWorld(options.file);
    const appOptions: CreateAppOptions = {
      repo: world.repo, serviceToken: OWNER_SERVICE_TOKEN, allowedOrigins: [OWNER_ORIGIN], snapshotsEnabled: false,
      scryptParams: FAST_SCRYPT, now: () => new Date(world.clock), log: (line) => { world.logs.push(line); },
      ...(options.gate === 'not-wired' ? {} : { cardSyncGate: { generationForSourceChecks: () => world.generation() } }),
      ...(options.authorization ? { cardSyncAuthorization: options.authorization(world) } : {}),
    };
    const built = createApp(appOptions);
    world.app = built.app;
    const user = built.users.createUser('alex', await hashPassword(OWNER_PASSWORD, FAST_SCRYPT));
    world.owner = cardSyncActorRef(user.id);
    world.cookie = await world.signIn();
    return world;
  }

  async signIn(): Promise<string> {
    const res = await (await this.http()).post('/auth/login').set('Origin', OWNER_ORIGIN).set('X-Holdr-Request', '1')
      .send({ username: 'alex', password: OWNER_PASSWORD });
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'] as unknown as string[]).find((value) => value.startsWith('holdr_session='))!.split(';')[0];
  }

  /** supertest on a fresh loopback server (closed when the test ends). */
  async http() {
    return request(await listenLoopback(this.app));
  }

  async get(path: string) {
    return (await this.http()).get(path).set('Cookie', this.cookie);
  }

  async post(path: string, body: unknown) {
    return (await this.http()).post(path).set('Cookie', this.cookie).set('Origin', OWNER_ORIGIN).set('X-Holdr-Request', '1')
      .send(body as object);
  }

  async patch(path: string, body: unknown) {
    return (await this.http()).patch(path).set('Cookie', this.cookie).set('Origin', OWNER_ORIGIN).set('X-Holdr-Request', '1')
      .send(body as object);
  }

  /** The service principal (direct loopback bearer). */
  async asService(method: 'get' | 'post', path: string, body: unknown = {}) {
    const test = (await this.http())[method](path).set('Authorization', `Bearer ${OWNER_SERVICE_TOKEN}`);
    return method === 'post' ? test.set('Content-Type', 'application/json').send(body as object) : test;
  }

  async reverify(password = OWNER_PASSWORD) {
    return this.post('/auth/reverify', { password });
  }

  /** A set's current version, read directly. */
  setVersion(setId: string): number {
    return this.db.prepare('SELECT version FROM card_sync_observation_sets WHERE id = ?').pluck().get(setId) as number;
  }
}

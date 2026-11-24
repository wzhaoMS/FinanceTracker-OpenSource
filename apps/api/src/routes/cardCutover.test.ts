import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { buildCardImportPayload, serializeCardImportPayload } from '@finance-tracker/shared';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { cardAccountEpoch, hasCutoverReceiptSchema, installCutoverReceiptSchema } from '../services/guardedCardCommit.js';
import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { serviceMayUseCardRoute } from '../auth/serviceScope.js';
import { listenLoopback } from '../testing/loopback.js';

const repos: SqliteStateRepo[] = [];
afterEach(() => { for (const repo of repos.splice(0)) repo.close(); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const encoded = (hex: string) => 'h1:' + [...hex].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
const TOKEN='7c'.repeat(32);
const ORIGIN='http://127.0.0.1:5173';
async function fixture(installSchema = true) {
  const repo=new SqliteStateRepo({file:':memory:'});repos.push(repo);
  if(installSchema)installCutoverReceiptSchema(repo.internalGetDb());
  const account=repo.createCardAccount({issuer:'chase',owner:'alex',last4:'7531',currency:'USD'});
  const payload=buildCardImportPayload({issuer:'chase',source:'ofx',parserVersion:'test',currency:'USD',cards:['7531'],
    coverage:{start:'2026-10-17',end:'2026-10-20'},rows:[{transactionDate:'2026-10-18',postedDate:'2026-10-19',
      amountMinor:100,kind:'purchase',description:'Synthetic',status:'posted',externalId:'synthetic-guarded'}]}).payload;
  const schemaBefore=repo.internalGetDb().prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  const schemaVersionBefore=repo.internalGetDb().pragma('schema_version',{simple:true});
  const built=createApp({repo,serviceToken:TOKEN,allowedOrigins:[ORIGIN],snapshotsEnabled:false,log:()=>{}});
  built.users.createUser('alex',await hashPassword('synthetic-password-only',{ln:10,r:8,p:1}));
  const app=built.app;
  const login=await request(await listenLoopback(app)).post('/auth/login').set('Origin',ORIGIN).set('X-Holdr-Request','1')
    .send({username:'alex',password:'synthetic-password-only'});
  const cookie=(login.headers['set-cookie'] as unknown as string[]).find(v=>v.startsWith('holdr_session='))!.split(';')[0];
  const epoch=cardAccountEpoch(repo.internalGetDb(),account.id),jobId=hash('job'),proposalDigest=hash('proposal');
  const query=(previewDigest:string)=>new URLSearchParams({cardAccountId:account.id,jobId:encoded(jobId),epoch:encoded(epoch),
    proposalDigest:encoded(proposalDigest),start:'2026-10-17',issuer:'chase',owner:'alex',currency:'USD',last4:'7531',previewDigest}).toString();
  // The guarded commit's own mechanics, as the signed-in owner commits: the service principal must also send the W4
  // proof (E1), which its own tests cover (services/cardImport/proof).
  const commit=async(previewDigest=repo.previewCardImport({cardAccountId:account.id,payload}).previewDigest)=>
    request(await listenLoopback(app)).post('/card-imports/cutover-commit?'+query(previewDigest))
      .set('Cookie',cookie).set('Origin',ORIGIN).set('X-Holdr-Request','1').send(payload);
  return{repo,app,account,payload,epoch,jobId,proposalDigest,query,commit,schemaBefore,schemaVersionBefore};
}
describe('atomic cutover commit',()=>{
  it('refuses the service principal\'s cutover commit without the pre-commit proof (W4 E1), writing nothing',async()=>{
    const f=await fixture();
    const res=await request(await listenLoopback(f.app)).post('/card-imports/cutover-commit?'
      +f.query(f.repo.previewCardImport({cardAccountId:f.account.id,payload:f.payload}).previewDigest))
      .set('Authorization','Bearer '+TOKEN).send(f.payload);
    expect([res.status,res.body.code]).toEqual([400,'proof-required']);
    expect(f.repo.listCardTransactions({cardAccountId:f.account.id})).toHaveLength(0);
    expect(f.repo.internalGetDb().prepare('SELECT count(*) AS n FROM card_cutover_commit_receipts').get()).toEqual({n:0});
  });
  it('startup and absent-schema requests perform no DDL; only explicit schema installation enables cutover',async()=>{
    const f=await fixture(false),db=f.repo.internalGetDb();
    expect(hasCutoverReceiptSchema(db)).toBe(false);
    expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()).toEqual(f.schemaBefore);
    expect(db.pragma('schema_version',{simple:true})).toBe(f.schemaVersionBefore);
    const capability=await request(await listenLoopback(f.app)).get('/card-imports/cutover-capability').set('Authorization','Bearer '+TOKEN);
    expect(capability.body).toMatchObject({status:'held',ready:false,atomicAccountEpoch:false,durableJobReceipt:false});
    expect((await f.commit()).status).toBe(409);
    expect((await request(await listenLoopback(f.app)).get('/card-imports/cutover-receipt?'+new URLSearchParams({
      cardAccountId:f.account.id,jobId:encoded(f.jobId),payloadSha256:encoded(hash(serializeCardImportPayload(f.payload))),
    }).toString()).set('Authorization','Bearer '+TOKEN)).status).toBe(409);
    expect(f.repo.listCardTransactions({cardAccountId:f.account.id})).toHaveLength(0);
    expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()).toEqual(f.schemaBefore);
    expect(db.pragma('schema_version',{simple:true})).toBe(f.schemaVersionBefore);
    installCutoverReceiptSchema(db);
    expect((await request(await listenLoopback(f.app)).get('/card-imports/cutover-capability').set('Authorization','Bearer '+TOKEN)).body.ready).toBe(true);
    expect((await f.commit()).status).toBe(200);
  });
  it('a conflicting receipt table is a hold and is never repaired by reads or commit',async()=>{
    const f=await fixture(false),db=f.repo.internalGetDb();
    db.exec('CREATE TABLE card_cutover_commit_receipts(unexpected TEXT)');
    const version=db.pragma('schema_version',{simple:true});
    expect((await request(await listenLoopback(f.app)).get('/card-imports/cutover-capability').set('Authorization','Bearer '+TOKEN)).body.status).toBe('held');
    expect((await f.commit()).status).toBe(409);
    expect(()=>installCutoverReceiptSchema(db)).toThrow();
    expect(db.pragma('schema_version',{simple:true})).toBe(version);
  });
  it('commits transaction rows and exact job receipt atomically, with native idempotent repeat',async()=>{
    const f=await fixture();
    expect((await request(await listenLoopback(f.app)).get('/card-imports/cutover-capability')).status).toBe(401);
    expect((await request(await listenLoopback(f.app)).get('/card-imports/cutover-capability').set('Authorization','Bearer '+TOKEN)).body.atomicAccountEpoch).toBe(true);
    const first=await f.commit();
    expect(first.status).toBe(200);
    expect(first.body.receipt.newCount).toBe(1);
    expect(first.body.receipt.epochBefore).toBe(f.epoch);
    expect(first.body.receipt.epochAfter).not.toBe(f.epoch);
    const stored=await request(await listenLoopback(f.app)).get('/card-imports/cutover-receipt?'+new URLSearchParams({
      cardAccountId:f.account.id,jobId:encoded(f.jobId),payloadSha256:encoded(hash(serializeCardImportPayload(f.payload))),
    }).toString()).set('Authorization','Bearer '+TOKEN);
    expect(stored.body.receipt).toEqual(first.body.receipt);
    const second=await f.commit();
    expect(second.status).toBe(200);expect(second.body.repeated).toBe(true);
    expect(second.body.receipt).toEqual(first.body.receipt);
    expect(f.repo.listCardTransactions({cardAccountId:f.account.id})).toHaveLength(1);
    expect(f.repo.internalGetDb().prepare('SELECT count(*) AS n FROM card_cutover_commit_receipts').get()).toEqual({n:1});
  });
  it('closing an account after preview rejects before any row write despite an otherwise unchanged preview digest',async()=>{
    const f=await fixture(),preview=f.repo.previewCardImport({cardAccountId:f.account.id,payload:f.payload}).previewDigest;
    f.repo.updateCardAccount(f.account.id,{status:'closed'});
    expect((await f.commit(preview)).status).toBe(409);
    expect(f.repo.listCardTransactions({cardAccountId:f.account.id})).toHaveLength(0);
    expect(f.repo.internalGetDb().prepare('SELECT count(*) AS n FROM card_cutover_commit_receipts').get()).toEqual({n:0});
  });
  it('an epoch change unrelated to this job cannot be treated as commit recovery',async()=>{
    const f=await fixture();
    f.repo.updateCardAccount(f.account.id,{nickname:'Changed'});
    expect((await f.commit()).status).toBe(409);
    expect(f.repo.listCardTransactions({cardAccountId:f.account.id})).toHaveLength(0);
  });
  it('a receipt insertion failure rolls back the card import in the same transaction',async()=>{
    const f=await fixture();
    f.repo.internalGetDb().exec(`CREATE TRIGGER refuse_test_receipt BEFORE INSERT ON card_cutover_commit_receipts
      BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;`);
    expect((await f.commit()).status).toBeGreaterThanOrEqual(400);
    expect(f.repo.listCardTransactions({cardAccountId:f.account.id})).toHaveLength(0);
    expect(f.repo.listCardImportBatches()).toHaveLength(0);
  });
  it('a committed receipt never authorizes a changed payload or post-commit account epoch',async()=>{
    const f=await fixture();
    expect((await f.commit()).status).toBe(200);
    f.payload.rows[0].description='Changed after receipt';
    expect((await f.commit()).status).toBe(409);
    f.payload.rows[0].description='Synthetic';
    f.repo.updateCardAccount(f.account.id,{nickname:'Changed after commit'});
    expect((await f.commit()).status).toBe(409);
    expect(f.repo.listCardTransactions({cardAccountId:f.account.id})).toHaveLength(1);
  });
  it('allows only the exact guarded service import route and preserves other service-principal restrictions',async()=>{
    expect(serviceMayUseCardRoute('POST','/card-imports/cutover-commit')).toBe(true);
    for(const p of ['/card-imports/cutover-commit/extra','/card-imports/cutover-receipt','/card-accounts','/card-transactions'])
      expect(serviceMayUseCardRoute('POST',p)).toBe(false);
    expect(serviceMayUseCardRoute('PATCH','/card-imports/cutover-commit')).toBe(false);
    const f=await fixture();
    expect((await request(await listenLoopback(f.app)).post('/card-accounts').set('Authorization','Bearer '+TOKEN)
      .send({issuer:'chase',owner:'alex',last4:'7531',currency:'USD'})).status).toBe(403);
    expect((await request(await listenLoopback(f.app)).post('/card-imports/cutover-commit?'+f.query(f.repo.previewCardImport({cardAccountId:f.account.id,payload:f.payload}).previewDigest))
      .set('Authorization','Bearer '+TOKEN).set('X-Forwarded-For','192.0.2.10').send(f.payload)).status).not.toBe(200);
  });
});

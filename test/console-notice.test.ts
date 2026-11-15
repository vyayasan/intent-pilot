import { describe,it,expect } from 'vitest';
import { createConsoleApi, type CaseState } from '../src/console/api.js';
import { parseNotice,makeNoticeProposal } from '../src/intake/notice.js';
import type { Terms } from '../src/domain/types.js';
import type { PlanResult } from '../src/agent/planner.js';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const before={monthlyPrice:100,annualPrice:984,currency:'USD',category:'software',noticeDays:30};
const after={...before,monthlyPrice:90};
const raw='Acme: USD90 per month or USD984 per year upfront. Category software. 30 days notice.';
const plan=(terms:Terms=after):PlanResult=>({ok:true,gate:{accepted:true,finalCadence:'annual',reasons:[]} as any,proposal:{extracted_terms:terms,rationale:'Annual remains cheaper and cash-safe; fresh approval still required.',cited_facts:['USD90 per month','USD984 per year']} as any});
function setup(extra:any={}){
 let clock=new Date('2026-11-10T02:00:00Z');let calls=0;
 const seed:CaseState={kase:{id:'case_notice',vendor:'Acme',rawTerms:'Acme USD100 monthly USD984 annual',terms:{...before}},forecast:{weeklyBalances:Array(12).fill(5000),reserveFloor:500},transactionIds:[],log:[]};
 const api=createConsoleApi({key:'k',approver:'test-reviewer',sessionToken:'tok',allowedOrigins:['http://localhost'],seedCases:[seed],now:()=>clock,planner:async()=>{calls++;return plan();},...extra});
 const post=(path:string,body:any)=>api(new Request('http://localhost'+path,{method:'POST',headers:{'content-type':'application/json','x-console-token':'tok',origin:'http://localhost'},body:JSON.stringify(body)}));
 const get=async()=>(await(await api(new Request('http://localhost/api/cases'))).json()).cases[0];
 const propose=()=>post('/api/notice-propose',{caseId:seed.kase.id,filename:'synthetic.eml',content:'From: billing@example.invalid\nContent-Type: text/plain\n\n'+raw});
 const approve=()=>post('/api/approve',{caseId:seed.kase.id});
 return {api,post,get,propose,approve,calls:()=>calls,advance:()=>clock=new Date(clock.getTime()+16*60_000)};
}
describe('reviewed notice workflow',()=>{
 it('compares model terms without mutating approval/card; apply invalidates approval, freezes and cannot replay',async()=>{
 const s=setup();const ap=await(await s.approve()).json();expect(ap.approval.cadence).toBe('annual');
 expect((await s.post('/api/create-card',{caseId:'case_notice',approval:ap.approval})).status).toBe(200);
 const old=await s.get(); const d=await(await s.propose()).json();expect(d.proposal.status).toBe('review');expect(d.proposal.decision.cadence).toBe('annual');
 const staged=await s.get();expect(staged.card.status).toBe('ACTIVE');expect(staged.kase.terms).toEqual(old.kase.terms);expect(staged.intent).toEqual(old.intent);
 const body={caseId:'case_notice',proposalId:d.proposal.id,confirm:true};expect((await s.post('/api/notice-apply',body)).status).toBe(200);
 const applied=await s.get();expect(applied.kase.terms.monthlyPrice).toBe(90);expect(applied.card.status).toBe('FROZEN');expect(applied.requiresReapproval).toBe(true);
 expect((await s.post('/api/notice-apply',body)).status).toBe(409);
 expect((await s.post('/api/create-card',{caseId:'case_notice',approval:ap.approval})).status).toBe(409);
 expect((await(await s.approve()).json()).approval.cadence).toBe('annual');s.api.flush();
 });
 it('requires an approved baseline, explicit review and matching vendor',async()=>{const s=setup();expect((await s.propose()).status).toBe(409);await s.approve();expect((await s.post('/api/notice-propose',{caseId:'case_notice',filename:'n.txt',content:'Other vendor USD1'})).status).toBe(409);expect(s.calls()).toBe(0);const p=await(await s.propose()).json();expect((await s.post('/api/notice-apply',{caseId:'case_notice',proposalId:p.proposal.id})).status).toBe(400);s.api.flush();});
 it('blocks stale or expired review',async()=>{for(const mode of ['expiry','terms']){const s=setup();await s.approve();const p=await(await s.propose()).json();if(mode==='expiry')s.advance();else await s.post('/api/change-terms',{caseId:'case_notice',terms:{...before,noticeDays:45},rawTerms:'changed elsewhere'});expect((await s.post('/api/notice-apply',{caseId:'case_notice',proposalId:p.proposal.id,confirm:true})).status).toBe(409);s.api.flush();}});
 it('persists pending proposal across restart',async()=>{const dir=mkdtempSync(tmpdir()+'/notice-test-');try{const s=setup({stateFile:dir+'/state.json'});await s.approve();const p=await(await s.propose()).json();s.api.flush();const s2=setup({stateFile:dir+'/state.json'});expect((await s2.get()).noticeProposal.id).toBe(p.proposal.id);s2.api.flush();}finally{rmSync(dir,{recursive:true,force:true});}});
 it('model refusal and unchanged proposals cannot apply',async()=>{for(const output of [{ok:false,error:'not enough evidence'},plan(before)]){const s=setup({planner:async()=>output});await s.approve();const p=await(await s.propose()).json();expect(['blocked','no-change']).toContain(p.proposal.status);expect((await s.post('/api/notice-apply',{caseId:'case_notice',proposalId:p.proposal.id,confirm:true})).status).toBe(409);s.api.flush();}});
});
describe('untrusted file parsing',()=>{
 it('records headers without trusting them',()=>{const p=parseNotice('n.eml','From: CEO <fake@invalid>\nSubject: notice\nContent-Type: text/plain\n\nAcme words');expect(p.source.sender).toContain('fake@invalid');expect(p.source.trust).toContain('unverified');expect(p.text).toBe('Acme words');});
 it.each([['n.html','<html>no</html>'],['n.eml','Content-Type: multipart/mixed\n\nno'],['n.eml','Content-Transfer-Encoding: base64\n\nYQ=='],['n.txt',''],['n.txt','x'.repeat(8001)]])('rejects unsupported input %s',(name,text)=>expect(()=>parseNotice(name,text)).toThrow());
 it('does not interpret missing fields as deleted old deal options',()=>{const p=makeNoticeProposal('v',{filename:'real-anonymised.txt',sha256:'s',trust:'unverified'},'renewal soon',before,plan({...after,annualPrice:null}),undefined,new Date());expect(p.status).toBe('blocked');expect(p.terms).toBeUndefined();});
});

import { extractTerms } from '../src/agent/planner.js';
import { Outbox } from '../src/notify/outbox.js';
describe('missing evidence is a real model outcome',()=>{
 it('accepts a grounded read-only information request instead of inventing required fields',async()=>{
 const c={id:'c',vendor:'Squarespace',rawTerms:'Squarespace domain will auto-renew soon.'};
 const result=await extractTerms({step:async()=>[{type:'tool_use',id:'info',name:'request_information',input:{reason:'This renewal reminder does not state a price or currency. Supply the complete priced terms before comparing.',missing_fields:['price','currency','category'],cited_facts:['auto-renew soon']}}]},c,{weeklyBalances:Array(12).fill(1500),reserveFloor:500});
 expect(result.ok).toBe(false);expect(result.proposal).toBeUndefined();expect(result.clarification?.missing_fields).toContain('price');
 });
 it('rejects a fabricated information-request citation',async()=>{
 const result=await extractTerms({step:async()=>[{type:'tool_use',id:'x',name:'request_information',input:{reason:'need more',missing_fields:['price'],cited_facts:['made up price']}}]},{id:'c',vendor:'V',rawTerms:'V renewal soon'},{weeklyBalances:Array(12).fill(1500),reserveFloor:500});expect(result.clarification).toBeUndefined();expect(result.ok).toBe(false);
 });
 it('labels native sandbox notifications, real provider merchant and non-settlement',()=>{
 const r=new Outbox(()=>new Date(),'Airwallex sandbox simulation').emit('purchase_cleared',{caseId:'c',vendor:'Acme case',recipient:'buyer@example.invalid',detail:{amount:984,currency:'USD',providerMerchant:'AIRPRO_TX_GENERATOR'}});
 expect(r.subject).toContain('[TEST]');expect(r.body).toContain('Provider-reported merchant: AIRPRO_TX_GENERATOR');expect(r.body).toContain('not a merchant or provider receipt');expect(r.html).toContain('No real merchant purchase or settlement');
 });
});
import { makeSim } from '../src/sim/simGateway.js';
describe('notice failure locks',()=>{
 it('persists a consumed proposal and reapproval lock when provider freeze is unknown',async()=>{
 const dir=mkdtempSync(tmpdir()+'/notice-freeze-');const gw=makeSim();gw.freezeCard=()=>{throw Error('lost provider response');};
 try{const s=setup({stateFile:dir+'/s.json',gateway:gw});const a=await(await s.approve()).json();await s.post('/api/create-card',{caseId:'case_notice',approval:a.approval});const p=await(await s.propose()).json();const body={caseId:'case_notice',proposalId:p.proposal.id,confirm:true};expect((await s.post('/api/notice-apply',body)).status).toBe(409);const after=await s.get();expect(after.freezeState).toBe('unknown');expect(after.requiresReapproval).toBe(true);expect(after.kase.terms.monthlyPrice).toBe(100);expect(after.noticeProposal.status).toBe('blocked');s.api.flush();const reopened=setup({stateFile:dir+'/s.json',gateway:gw});expect((await reopened.get()).freezeState).toBe('unknown');expect((await reopened.post('/api/notice-apply',body)).status).toBe(409);expect((await reopened.approve()).status).toBe(409);reopened.api.flush();}finally{rmSync(dir,{recursive:true,force:true});}
 });
});

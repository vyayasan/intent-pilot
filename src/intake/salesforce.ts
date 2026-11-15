import {createHash} from 'node:crypto';
export interface ContractSnapshot {id:string;vendor:string;rawTerms:string;version:string;url:string;readAt:string;status:string}
export interface ContractSource {read(id:string):Promise<ContractSnapshot>}
/** Fixed Salesforce org at configuration, never a user-supplied fetch destination. No write API. */
export class SalesforceContracts implements ContractSource {
 private origin:string;
 constructor(private options:{instance:string;clientId:string;clientSecret:string;fetchImpl?:typeof fetch}){
  const u=new URL(options.instance);if(u.protocol!=='https:'||!u.hostname.endsWith('.my.salesforce.com')||u.pathname!=='/'||u.search||u.hash)throw Error('A fixed HTTPS Salesforce org origin is required');this.origin=u.origin;
 }
 async read(id:string):Promise<ContractSnapshot>{
  if(!/^800[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id))throw Error('Invalid Contract id');
  const f=this.options.fetchImpl||fetch;const token=await f(this.origin+'/services/oauth2/token',{method:'POST',redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:this.options.clientId,client_secret:this.options.clientSecret}),signal:AbortSignal.timeout(15000)});
  if(!token.ok)throw Error('Salesforce authentication unavailable (HTTP '+token.status+')');const auth=await token.json() as any;if(typeof auth.access_token!=='string')throw Error('Salesforce returned no access token');
  const r=await f(this.origin+'/services/data/v65.0/sobjects/Contract/'+id+'?fields=Id,ContractNumber,Status,SpecialTerms,SystemModstamp,Account.Name',{headers:{authorization:'Bearer '+auth.access_token},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('Contract read unavailable (HTTP '+r.status+')');const j=await r.json()as any;
  if(j.Id!==id||typeof j.SpecialTerms!=='string'||!j.SpecialTerms.trim()||j.SpecialTerms.length>7800||!j.SystemModstamp||!j.Account?.Name)throw Error('Contract terms, version or account missing');
  const vendor=String(j.Account.Name).slice(0,120),rawTerms=vendor+'\n'+j.SpecialTerms;
  return {id,vendor,rawTerms,version:createHash('sha256').update(JSON.stringify([j.Id,j.SystemModstamp,j.Status,vendor,j.SpecialTerms])).digest('hex'),status:String(j.Status),url:this.origin+'/lightning/r/Contract/'+id+'/view',readAt:new Date().toISOString()};
 }
}

// Run only on an operator's machine with secure env injection. No live run is implied by this file.
import {readFileSync,mkdirSync,writeFileSync,appendFileSync} from "node:fs";
import {createHash,randomBytes} from "node:crypto";
import {createInterface} from "node:readline/promises";
import {stdin,stdout} from "node:process";
import {resolve} from "node:path";
import {AirwallexClient} from "../src/gateway/airwallex.js";
import {LiveIssuingGateway} from "../src/gateway/live.js";
import {createConsoleApi,demoCases} from "../src/console/api.js";
import {fromUpload} from "../src/intake/intake.js";
import {ProofConfigSchema,assertSandbox,assertProofTransaction} from "./proof-config.js";

const base="https://api.sandbox.airwallex.com";
assertSandbox(process.env.AIRWALLEX_BASE??base);
if(process.env.ABH_SANDBOX_PROOF!=="YES")throw new Error("Set ABH_SANDBOX_PROOF=YES after reading the runbook");
if(!stdin.isTTY)throw new Error("Interactive operator approval required; do not pipe approvals");
const clientId=process.env.AIRWALLEX_CLIENT_ID,apiKey=process.env.AIRWALLEX_API_KEY;
if(!clientId||!apiKey)throw new Error("Securely inject AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY on your machine; never put them in chat");
const approver=process.env.ABH_APPROVER_LABEL;
if(!approver)throw new Error("Set ABH_APPROVER_LABEL to the local operator label (not production authentication)");
const file=resolve(process.argv[2]??"proof-input.example.json");
const input=ProofConfigSchema.parse(JSON.parse(readFileSync(file,"utf8")));
const originalIntake=fromUpload(file+":original",input.originalText),changedIntake=fromUpload(file+":changed",input.changedText);
if(!originalIntake.ok||!changedIntake.ok)throw new Error("File intake failed");
const runId=process.env.ABH_PROOF_RUN_ID;
if(!runId||!/^[a-zA-Z0-9_-]{4,60}$/.test(runId))throw new Error("Set a new ABH_PROOF_RUN_ID (4-60 letters/numbers/underscore/hyphen)");
const runDir=resolve("runs",runId);mkdirSync(runDir); // Exclusive directory: reruns never repeat financial actions blindly.
const journal=resolve(runDir,"receipts.jsonl");
const receipt=(step:string,detail:Record<string,unknown>)=>appendFileSync(journal,JSON.stringify({at:new Date().toISOString(),step,...detail})+"\n");
const hash=(t:string)=>createHash("sha256").update(t).digest("hex");
writeFileSync(resolve(runDir,"manifest.json"),JSON.stringify({runId,base,inputLabel:input.inputLabel,sourceFile:file,sourceHash:hash(readFileSync(file,"utf8")),operator:approver,authentication:"local terminal confirmation, not production identity",model:"none - deterministic proof",status:"STARTED"},null,2));
const client=new AirwallexClient({clientId,apiKey,baseUrl:base,maxRps:2});
const seed=[demoCases()[0]];seed[0].kase.terms=input.original;seed[0].kase.rawTerms=originalIntake.rawTerms!;
const handle=createConsoleApi({gateway:new LiveIssuingGateway(client),seedCases:seed,approver,key:randomBytes(32).toString("hex")});
const rl=createInterface({input:stdin,output:stdout});
async function post(path:string,body:unknown,expect=200){
 const r=await handle(new Request("http://localhost/api/"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}));
 const data=await r.json();receipt(path,{http:r.status});
 if(r.status!==expect)throw new Error("Unexpected response at "+path+"; reconcile using private receipts before a new attempt");
 return data;
}
async function confirm(phrase:string,detail:string){console.log(detail);if(await rl.question("Type "+phrase+" to approve this sandbox action: ")!==phrase)throw new Error("Operator stopped; no automatic continuation");}
try{
 receipt("file_intake",{provenance:input.inputLabel,originalIntake:originalIntake.provenance,changedIntake:changedIntake.provenance,structuredTerms:"operator-supplied fixture, not model-extracted",originalTextHash:hash(input.originalText),changedTextHash:hash(input.changedText)});
 await confirm("APPROVE 100 USD",input.originalText+"\nPolicy chooses monthly, cap 100 USD, software only. Sandbox funds only.");
 const approved=await post("approve",{caseId:input.caseId});
 receipt("approval",{cap:approved.approval.amountCap,currency:approved.approval.currency,termsHash:approved.approval.termsHash});
 const issued=await post("create-card",{approval:approved.approval});
 receipt("old_card",{cardId:issued.card.id,controls:issued.card.controls});
 // Check ready state without attempting payments on a not-ready card.
 const old=await client.call<any>("GET",`/api/v1/issuing/cards/${encodeURIComponent(issued.card.id)}`);
 if((old.card_id??old.id)!==issued.card.id||old.card_status!=="ACTIVE")throw new Error("Old card ACTIVE read-back not confirmed");
 await confirm("PURCHASE 100 USD","Simulate and capture one 100 USD purchase on the old sandbox card.");
 const allowed=await post("simulate",{caseId:input.caseId,kind:"in-policy"});assertProofTransaction(allowed.transaction,"CLEARING");
 receipt("old_purchase_cleared",{cardId:issued.card.id,transactionId:allowed.transaction.id,amount:100,status:allowed.transaction.status});
 await confirm("CHANGE DEAL",input.changedText+"\nInvalidate old approval and freeze old card. No automatic new card approval.");
 await post("change-terms",{caseId:input.caseId,terms:input.changed,rawTerms:changedIntake.rawTerms});
 receipt("freeze_readback_verified",{cardId:issued.card.id,status:"INACTIVE"});
 await post("create-card",{approval:approved.approval},409);receipt("stale_approval_refused",{cardId:issued.card.id});
 const declined=await post("simulate",{caseId:input.caseId,kind:"in-policy"});assertProofTransaction(declined.transaction,"CARD_INACTIVE");
 receipt("old_purchase_declined",{cardId:issued.card.id,transactionId:declined.transaction.id,amount:100,status:declined.transaction.status,reason:declined.transaction.failureReason});
 await confirm("APPROVE 90 USD",input.changedText+"\nApprove fresh monthly intent, cap 90 USD. The old card stays frozen.");
 const fresh=await post("approve",{caseId:input.caseId});
 if(fresh.approval.amountCap!==90)throw new Error("New approval cap mismatch");
 const replacement=await post("create-card",{approval:fresh.approval});
 if(replacement.card.id===issued.card.id)throw new Error("Replacement must be a different card");
 receipt("new_card",{cardId:replacement.card.id,controls:replacement.card.controls});
 const ready=await client.call<any>("GET",`/api/v1/issuing/cards/${encodeURIComponent(replacement.card.id)}`);
 if((ready.card_id??ready.id)!==replacement.card.id||ready.card_status!=="ACTIVE")throw new Error("Replacement ACTIVE read-back not confirmed");
 await confirm("PURCHASE 90 USD","Simulate and capture one 90 USD purchase on the replacement sandbox card.");
 const cleared=await post("simulate",{caseId:input.caseId,kind:"in-policy"});assertProofTransaction(cleared.transaction,"CLEARING");
 receipt("new_purchase_cleared",{cardId:replacement.card.id,transactionId:cleared.transaction.id,amount:90,status:cleared.transaction.status});
 // Leave both demo cards inactive. Their IDs stay in receipts for dashboard inspection.
 await post("freeze",{caseId:input.caseId});receipt("replacement_cleanup",{cardId:replacement.card.id,status:"INACTIVE"});
 writeFileSync(resolve(runDir,"outcome.json"),JSON.stringify({status:"PASS",runId,live:"Airwallex sandbox",model:"none",oldCard:issued.card.id,newCard:replacement.card.id},null,2));
 console.log("PASS. Inspect private receipts and both cards in the sandbox dashboard. No production money or live Visa tooling was used.");
}catch{
 receipt("STOPPED",{reason:"mismatch, error or operator stop; remote actions may have occurred; reconcile manually before any retry"});
 console.error("STOPPED. No automatic retry/resume. Inspect receipts and sandbox state. Previously issued cards may still be active; reconcile/freeze them before another run.");process.exitCode=1;
}finally{rl.close();}

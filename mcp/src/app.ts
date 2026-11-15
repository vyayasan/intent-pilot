import {App} from '@modelcontextprotocol/ext-apps';
// @ts-ignore Generated read-only subset of the actual refreshed console renderer.
import {showSnapshot} from './review.js';
const app=new App({name:'IntentPay Read-only Review',version:'0.1.0'});
function receive(result:any){if(result.isError){document.getElementById('readhealth')!.textContent='Read failed. Not current evidence.';return;}showSnapshot(result.structuredContent);}
app.ontoolresult=receive;
document.getElementById('refresh')!.addEventListener('click',async()=>{try{receive(await app.callServerTool({name:'show_review',arguments:{}}))}catch{document.getElementById('readhealth')!.textContent='Read failed. Previous snapshot may be stale.'}});
app.connect().catch(()=>{document.getElementById('readhealth')!.textContent='MCP host connection failed. No account access.'});

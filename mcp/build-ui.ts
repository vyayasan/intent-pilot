import {page,pageCss,pageJs} from './vendor/page.js';
import fs from 'node:fs';
let html=page.replace('<link rel="stylesheet" href="/console.css">','<style>'+pageCss+'</style>').replace('__GATEWAY_MODE__','READ-ONLY MCP · LIVE SANDBOX READS · SYNTHETIC TEST CASE').replace('__GATEWAY_FOOTER__','Saved test terms/forecast plus current Airwallex sandbox card and ledger reads. No action tools.');
html=html.replace(/<div class="qrow">.*?<div id="cases"><\/div>/s,'<p class="navhead">Fixture review queue</p><button class="act sec" id="refresh">Reload fixture snapshot</button><div id="readhealth" role="status">Waiting for MCP host...</div><div id="cases"></div>');
html=html.replace('<script src="/console.js"></script>','<script type="module" src="/src/app.ts"></script>');
fs.writeFileSync('mcp-app.html',html);
let render=pageJs.slice(pageJs.indexOf('function render()'),pageJs.indexOf('  var na ='));
render += `
  p.querySelectorAll('button,input,textarea,#realterms,#reconcile-card').forEach(function(el){el.remove()});
  p.querySelectorAll('.box').forEach(function(el){if(el.querySelector('h3')?.textContent==='Notice to decision')el.remove()});
  p.querySelectorAll('.btns').forEach(function(el){el.remove()});
}\n`;
const helpers=`var state={cases:[],audit:[],sel:null,approval:null,cardRecon:null,showIntake:false,live:false,notifications:[]};
function current(){return state.cases.find(c=>c.kase.id===state.sel)}
function esc(s){return String(s==null?'':s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))}
function currentForecast(c){return c.forecast?c.forecast.weeklyBalances:[]}
`;
fs.writeFileSync('src/review.js',helpers+render+`\nexport function showSnapshot(data){if(!data||!Array.isArray(data.cases))throw Error('No valid snapshot');state.cases=data.cases;state.audit=data.audit||[];state.notifications=[];state.sel=data.selectedCaseId||data.cases[0]?.kase.id;render();document.getElementById('readhealth').textContent='Current Airwallex sandbox card/ledger reads. Terms and forecast are saved synthetic scenario inputs.';}`);

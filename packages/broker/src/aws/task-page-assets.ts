// The task page's one script and its stylesheet. Both are static text: no model or reader value is ever put in them.

/**
 * The page's one script. It finds a deep link's target (the hash, else `?doc=`), opens every `<details>` around
 * it and scrolls there. `#<document>/<claim>` (for example `#coding-plan/2.1`) means that claim of the document's
 * current version, built the way `claimAnchor` builds claim element IDs (`coding-plan-v2-2-1`). Then, every 20 s while
 * the page is visible and for 30 minutes at most, it asks `/task/status` (same origin) where the task stands and, when that
 * differs from the page, shows the hidden "moved on" banner (showing the page again asks at once, unless it asked under 5 s
 * ago); it never reloads by itself, so nothing half-typed is lost.
 * The page reads fully without it.
 */
export const TASK_PAGE_SCRIPT = String.raw`(function(){
var CLAIM=/^([a-z]+(?:-[a-z]+)*)\/([1-9][0-9]{0,2}(?:\.[1-9][0-9]{0,2}){0,2})$/;
function claimAnchor(anchor,version,claimId){return anchor+"-v"+version+"-"+claimId.replace(/\./g,"-");}
function target(){
  var hash=location.hash.replace(/^#/,"");
  try{hash=decodeURIComponent(hash);}catch(e){}
  var found=CLAIM.exec(hash);
  if(found){
    var section=document.getElementById(found[1]);
    var version=section&&section.getAttribute("data-current");
    var claim=version&&document.getElementById(claimAnchor(found[1],version,found[2]));
    return claim||section;
  }
  if(hash)return document.getElementById(hash);
  var asked=/[?&]doc=(requirements|design|coding-plan)(?:&|$)/.exec(location.search);
  return asked?document.getElementById(asked[1]):null;
}
function go(){
  var el=target();
  if(!el)return;
  for(var up=el;up;up=up.parentElement){if(up.tagName==="DETAILS")up.open=true;}
  var first=el.firstElementChild;
  if(first&&first.tagName==="DETAILS")first.open=true;
  el.scrollIntoView({block:"start"});
  el.classList.add("flash");
  setTimeout(function(){el.classList.remove("flash");},2000);
}
go();
window.addEventListener("hashchange",go);
})();
(function(){
var box=document.getElementById("moved-on");
if(!box||typeof fetch!=="function"||typeof setInterval!=="function")return;
var url=box.getAttribute("data-check"),version=box.getAttribute("data-version"),stage=box.getAttribute("data-stage");
if(!url||!/^\/review\/[0-9a-fA-F-]{36}\/task\/status$/.test(url))return;
var EVERY=20000,LIMIT=30*60*1000,SOON=5000,started=Date.now(),asked=0,timer=null,asking=false;
function stop(){if(timer!==null){clearInterval(timer);timer=null;}}
function check(){
  if(timer===null||asking||document.hidden)return;
  if(Date.now()-started>=LIMIT){stop();return;}
  asking=true;
  asked=Date.now();
  fetch(url,{credentials:"same-origin",cache:"no-store",headers:{accept:"application/json"}}).then(function(reply){
    if(reply.status===401||reply.status===403||reply.status===404){stop();return null;}
    return reply.ok?reply.json():null;
  }).then(function(now){
    if(timer!==null&&now&&(String(now.revision)!==version||String(now.stage)!==stage)){stop();box.hidden=false;}
  }).catch(function(){}).then(function(){asking=false;});
}
var refresh=document.getElementById("moved-on-refresh");
if(refresh)refresh.addEventListener("click",function(){location.reload();});
timer=setInterval(check,EVERY);
document.addEventListener("visibilitychange",function(){if(!document.hidden&&Date.now()-asked>=SOON)check();});
})();`;

/** Colours are custom properties with a dark set; nothing scrolls the page sideways at 360 px (code blocks and tables scroll inside themselves). */
export const TASK_PAGE_STYLE = String.raw`:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--panel:#f6f8fa;--focus:#0969da;--ok:#1a7f37;--warn:#9a6700;font-family:system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--panel:#161b22;--focus:#58a6ff;--ok:#3fb950;--warn:#d29922}}
*{box-sizing:border-box}
body{margin:0 auto;max-width:52rem;padding:clamp(1rem,4vw,2.5rem);line-height:1.55;background:var(--bg);color:var(--fg);overflow-wrap:anywhere}
h1,h2,h3,h4{line-height:1.2}h1{margin:.2rem 0 .5rem}
.muted{color:var(--muted)}
.tag{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:0 .5rem;font-size:.85rem}
a{color:var(--focus)}
a:focus,summary:focus{outline:3px solid var(--focus);outline-offset:2px}
summary{cursor:pointer}
figure,details,table,blockquote,svg{max-width:100%;min-width:0}
pre{display:block;overflow-x:auto;max-width:100%;margin:.5rem 0;padding:.5rem 1rem;background:var(--panel);border-left:3px solid var(--line);font-family:ui-monospace,monospace;font-size:.9rem}
pre,.checks table{scrollbar-width:auto;scrollbar-color:var(--muted) var(--panel)}
pre{background:linear-gradient(to right,var(--panel),var(--panel)) left/1.5rem 100% no-repeat local,linear-gradient(to left,var(--panel),var(--panel)) right/1.5rem 100% no-repeat local,linear-gradient(to right,var(--line),transparent) left/.7rem 100% no-repeat scroll,linear-gradient(to left,var(--line),transparent) right/.7rem 100% no-repeat scroll,var(--panel)}
@supports not (scrollbar-color:auto){pre::-webkit-scrollbar,.checks table::-webkit-scrollbar{height:.6rem;background:var(--panel)}
pre::-webkit-scrollbar-thumb,.checks table::-webkit-scrollbar-thumb{background:var(--muted);border-radius:999px}}
pre.doc-text{white-space:pre-wrap;overflow-wrap:anywhere}
code{font-family:ui-monospace,monospace}
svg{height:auto}
.progress{display:flex;flex-wrap:wrap;gap:.25rem .5rem;list-style:none;margin:.75rem 0;padding:0}
.step{border:1px solid var(--line);border-radius:999px;padding:.1rem .7rem;font-size:.9rem;color:var(--muted)}
.step a{color:inherit;text-decoration:underline;text-underline-offset:.2em}
.step a:hover{color:var(--focus)}
.step a:focus{outline:3px solid var(--focus);outline-offset:2px;border-radius:999px}
.step.done{color:var(--fg)}
.step.done::before{content:"\2713\00a0"}
.step.current{border-color:var(--focus);color:var(--fg);font-weight:600}
.step.current::before{content:"\25cf\00a0"}
main>section,.kind{border-top:1px solid var(--line);padding:.5rem 0}
.kind>details>summary{font-weight:600}
.from-note{background:var(--panel);border-left:3px solid var(--focus);padding:.4rem .8rem}
.doc-header h2,.doc-header h3{margin-bottom:.2rem}
.doc-title{margin:.1rem 0;font-weight:600}
.doc-status{margin:.2rem 0}
.status{border-radius:999px;padding:0 .5rem;font-size:.85rem;border:1px solid currentColor}
.status.approved{color:var(--ok)}
.status.pending{color:var(--warn)}
.not-current{color:var(--muted)}
.versions{margin-top:1rem}
.versions>.doc{border-top:1px dashed var(--line);margin-top:.75rem}
.claim{margin:.3rem 0;border-left:2px solid var(--line);padding-left:.6rem}
.claim-id{font-family:ui-monospace,monospace;color:var(--muted)}
.claim-text{font-weight:500}
.level-1>summary .claim-text{font-size:1.05rem}
.claim-body{margin:.3rem 0 .3rem .5rem}
.more{margin:.3rem 0}
.badge{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:0 .45rem;font-size:.75rem;font-weight:400}
.badge-new{color:var(--ok)}
.badge-changed,.badge-approved-changed{color:var(--warn)}
.badge-recommended{color:var(--focus)}
.evidence{margin:.5rem 0;padding:0}
.evidence figcaption,.evidence-status,.evidence-note,.lang{color:var(--muted);font-size:.85rem}
.evidence-missing{border:1px dashed var(--line);padding:.3rem .6rem}
.evidence-quote,.why-quote{margin:.5rem 0;padding:.2rem 1rem;border-left:3px solid var(--line)}
.evidence-quote footer,.why-quote footer{color:var(--muted);font-size:.85rem}
.ln{display:inline-block;min-width:3ch;margin-right:1ch;text-align:right;color:var(--muted);user-select:none}
.decision{border:1px solid var(--line);border-radius:.4rem;margin:.6rem 0;padding:.4rem .8rem;background:var(--panel)}
.decision-id{font-weight:700}
.options{list-style:none;margin:.3rem 0;padding:0}
.option{margin:.25rem 0}
.option.recommended .option-label{font-weight:600}
.consequence,.decision-note,.decision-claim{color:var(--muted)}
.decision-list{margin:.5rem 0}
.decision-list-title{margin:0 0 .2rem;font-weight:600}
.decision-list ul{margin:0;padding-left:1.2rem}
.decision-link{overflow-wrap:anywhere}
.changes,.why{margin:.5rem 0}
.checks table{display:block;overflow-x:auto;border-collapse:collapse}
.checks th,.checks td{border:1px solid var(--line);padding:.2rem .5rem;text-align:left;word-break:normal;overflow-wrap:normal;white-space:nowrap}
.checks th.check-label,.checks td.check-label{white-space:normal;overflow-wrap:break-word}
.flash{outline:3px solid var(--focus);outline-offset:2px;background:var(--panel)}
.history{padding-left:1.2rem}
.history time{color:var(--muted);font-size:.85rem}
.accepted-by{color:var(--muted)}
[hidden]{display:none!important}
.moved-on{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;margin:0 0 .75rem;padding:.5rem .8rem;background:var(--panel);border:1px solid var(--focus);border-radius:.4rem}
.moved-on p{margin:0}
.moved-on button{font:inherit;padding:.2rem .8rem;border:1px solid var(--focus);border-radius:999px;background:var(--bg);color:var(--fg);cursor:pointer}
.moved-on button:focus{outline:3px solid var(--focus);outline-offset:2px}
@media (max-width:35rem){body{padding:1rem}
.checks table,.checks tbody,.checks tr{display:block;overflow-x:visible}
.checks thead{position:absolute;height:1px;overflow:hidden;clip-path:inset(50%)}
.checks tr{border:1px solid var(--line);margin:.4rem 0;padding:.3rem .5rem}
.checks td{display:inline;border:0;padding:0}
.checks td.check-label{display:block;font-weight:600}
.checks td.check-proves,.checks td.check-status{white-space:normal}
.checks td.check-proves::before,.checks td.check-status::before{content:"\0020\00b7\0020"}}
`.replace(/\n/g, "");

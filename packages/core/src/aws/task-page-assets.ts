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
  // Keyboard and screen-reader users land on the target too, not on the link they used.
  if(!el.hasAttribute("tabindex"))el.setAttribute("tabindex","-1");
  if(typeof el.focus==="function")el.focus({preventScroll:true});
  el.classList.add("flash");
  setTimeout(function(){el.classList.remove("flash");},2000);
}
go();
window.addEventListener("hashchange",go);
})();
(function(){
var box=document.getElementById("moved-on");
if(!box||typeof fetch!=="function"||typeof setInterval!=="function")return;
// With the deciding script on the page, its poll of the page API is the only one.
if(document.getElementById("agentx-page-data"))return;
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
export const TASK_PAGE_STYLE = String.raw`:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--panel:#f6f8fa;--focus:#0969da;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;font-family:system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--panel:#161b22;--focus:#58a6ff;--ok:#3fb950;--warn:#d29922;--bad:#ff7b72}}
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
.evidence-code pre,.evidence-sketch pre{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
.code-line{display:inline-grid;grid-template-columns:auto minmax(0,1fr);vertical-align:top;width:100%}
.code-text{min-width:0}
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
.e2e-rows{display:block;overflow-x:auto;border-collapse:collapse}
.e2e-rows th,.e2e-rows td{border:1px solid var(--line);padding:.2rem .5rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.e2e-rows tr[data-status="FAILED"] td:nth-child(2){color:var(--bad);font-weight:600}
.e2e-rows tr[data-status="PASSED"] td:nth-child(2){color:var(--ok)}
.e2e-rows tr[data-status="UNKNOWN"] td:nth-child(2){color:var(--warn)}
.flash{outline:3px solid var(--focus);outline-offset:2px;background:var(--panel)}
.history{padding-left:1.2rem}
.history time{color:var(--muted);font-size:.85rem}
.accepted-by{color:var(--muted)}
.task-people-list{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}
.task-people-person,.task-people-confirmation{border:1px solid var(--line);border-radius:.4rem;padding:.6rem;min-width:0}
.task-people-person h3,.task-people-person p{margin:.2rem 0}
.task-people-role{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.4rem .6rem;align-items:end;margin-top:.5rem}
.task-people-role label,.task-people-status{grid-column:1/-1}
.task-people select{min-height:2.75rem;max-width:100%;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:.4rem}
.task-people-you{font-size:.75rem;border:1px solid currentColor;border-radius:999px;padding:0 .4rem}
.task-people-takeover{margin-top:.75rem}.task-people-confirmation a{display:inline-block;margin-left:.75rem}
[hidden]{display:none!important}
.moved-on{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;margin:0 0 .75rem;padding:.5rem .8rem;background:var(--panel);border:1px solid var(--focus);border-radius:.4rem}
.moved-on p{margin:0}
.moved-on button{font:inherit;padding:.2rem .8rem;border:1px solid var(--focus);border-radius:999px;background:var(--bg);color:var(--fg);cursor:pointer}
.moved-on button:focus{outline:3px solid var(--focus);outline-offset:2px}
.decide-bar{position:sticky;bottom:0;display:flex;flex-wrap:wrap;gap:.5rem;padding-bottom:calc(.5rem + env(safe-area-inset-bottom));align-items:center;z-index:1;margin:1rem 0 0;padding-top:.5rem;padding-left:.5rem;padding-right:.5rem;background:var(--panel);border-top:2px solid var(--focus)}
.decide-bar p{margin:0;flex:1 1 10rem}
button,.decide-bar button{min-height:2.75rem}
button{font:inherit;padding:.4rem 1rem;border:1px solid var(--line);border-radius:.4rem;background:var(--bg);color:var(--fg);cursor:pointer}
button:focus,input:focus,textarea:focus{outline:3px solid var(--focus);outline-offset:2px}
textarea{width:100%;max-width:100%;min-height:5rem;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:.3rem}
dialog{width:min(40rem,100vw);max-height:100dvh;overflow-y:auto;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:.5rem}
dialog::backdrop{background:rgba(0,0,0,.4)}
.dialog-actions{display:flex;flex-wrap:wrap;gap:.5rem}
.answer{border:0;margin:0;padding:0;min-width:0}
.answer legend{padding:0;font-weight:500}
.answer .option{display:flex;gap:.5rem;align-items:flex-start}
.answer input[type=radio]{min-width:1.25rem;min-height:1.25rem;margin-top:.3rem}
.no-decisions{color:var(--muted)}
.suggestions{margin:.2rem 0;color:var(--muted)}
.comments{margin:.5rem 0}
.threads,.replies{list-style:none;margin:0;padding:0}
.replies{margin-left:1rem;border-left:2px solid var(--line);padding-left:.6rem}
.comment{margin:.4rem 0;padding:.3rem .6rem;border:1px solid var(--line);border-radius:.4rem;min-width:0}
.comment-agentx{background:var(--panel)}
.comment-meta{margin:0;font-size:.85rem;color:var(--muted)}
.comment-author{color:var(--fg);font-weight:600}
.comment-text{margin:.2rem 0;white-space:pre-wrap;overflow-wrap:anywhere}
.comment-state,.comment-sent,.comment-deleted,.from-version,.comment-edited{color:var(--muted);font-size:.9rem}
.comment-state,.comment-sent,.comment-deleted,.comment-link{margin:.2rem 0}
.comment-link{font-size:.9rem}
.chip{display:inline-block;border-radius:999px;padding:0 .5rem;font-size:.8rem;font-weight:600;background:var(--focus);color:var(--bg)}
.tag-owner{font-size:.75rem}
.badge-comments{color:var(--muted)}
.removed-claim{border-top:1px dashed var(--line);margin:.5rem 0}
.comment-error,.error{color:var(--warn);font-weight:600}
.comment-form{margin:.4rem 0}.comment-form label{display:block}.comment-form .comment-ask{display:flex;gap:.5rem;align-items:center;min-height:2.75rem}
#decide-dialog label{display:inline}#decide-dialog li{margin:.3rem 0}#decide-dialog input[type=checkbox]{min-width:1.25rem;min-height:1.25rem}
@media (max-width:35rem){dialog{margin:0;width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;border-radius:0}}
@media (max-width:35rem){body{padding:1rem}
.task-people-role{grid-template-columns:1fr}.task-people-role label,.task-people-status{grid-column:1}.task-people-role button{width:100%}
.checks table,.checks tbody,.checks tr{display:block;overflow-x:visible}
.checks thead{position:absolute;height:1px;overflow:hidden;clip-path:inset(50%)}
.checks tr{border:1px solid var(--line);margin:.4rem 0;padding:.3rem .5rem}
.checks td{display:inline;border:0;padding:0}
.checks td.check-label{display:block;font-weight:600}
.checks td.check-proves,.checks td.check-status{white-space:normal}
.checks td.check-proves::before,.checks td.check-status::before{content:"\0020\00b7\0020"}}
`.replace(/\n/g, "");

/**
 * Every word the deciding script can put on the page (spec 061 slice 2). Kept here, not in the script's text, so a test
 * can sweep them; the script receives them as JSON.
 */
export const TASK_PAGE_DECIDING_COPY = {
  toAnswer: " to answer",
  allAnswered: "All decisions answered",
  nextDecision: "Next decision (",
  closeCount: ")",
  approveTitle: "Approve ",
  changesTitle: "Request changes to ",
  youChose: ": You chose ",
  recommendedOpen: " (AgentX recommended ",
  recommendedClose: ")",
  commentsToSend: "Comments to send",
  noteApprove: "Note for AgentX (optional)",
  noteChanges: "What should change?",
  submitCoding: "Approve and start coding",
  submitOther: "Approve and continue",
  send: "Send",
  needOne: "Include at least one comment or write a note.",
  retrying: "Retrying…",
  retried: "Retried. AgentX is checking the plan against the runtime again.",
  retryOwnerOnly: "Only the task owner can retry these checks.",
  sending: "Sending…",
  sent: "Sent. AgentX is on the next step.",
  changed: "This task changed. Refresh the page and try again.",
  unavailable: "AgentX couldn't do that right now. Try again shortly.",
  signIn: "Your sign-in ended. Open the link from Slack again, then try once more.",
  showIt: "Show it",
  movedOn: "This task moved on.",
  isReady: " is ready.",
  yourComment: "Your comment",
  ask: "Ask AgentX to reply to this comment",
  post: "Post",
  cancel: "Cancel",
  save: "Save",
  edit: "Edit",
  remove: "Delete",
  confirmRemove: "Delete this comment?",
  aComment: "A comment",
  removed: "Comment deleted",
  sentApproval: "Sent with your approval, so it can't be edited.",
  sentOwnerApproval: "Sent with the owner's approval, so it can't be edited.",
  sentChanges: "Sent with Request changes, so it can't be edited.",
  sentDecision: "Sent with a decision, so it can't be edited.",
  fromVersion: "from v",
  edited: "(edited)",
  owner: "Owner",
  agentx: "AgentX",
  agentxAi: "AgentX (AI)",
  answeringWho: "answering ",
  skipped: "Edited after it was asked, so AgentX didn't answer.",
  reply: "Reply",
  done: "Done",
  notChanged: "Not changed",
  becauseColon: ": ",
  doneIn: " in ",
  seeClaim: "See ",
  claimWord: "claim ",
  inWord: " in ",
  fromWord: "from ",
  versionWord: " v",
  inRequirements: "the requirements",
  inDesign: "the design",
  inPlan: "the coding plan",
  nameRequirements: "requirements",
  nameDesign: "design",
  namePlan: "coding plan",
  dot: "· ",
  sentToCoding: "Sent to coding when the plan was approved.",
  answering: "AgentX is answering…",
  couldnt: "AgentX couldn't answer this one.",
  notAnswered: "Not answered",
  askUnavailable: "AgentX can answer comments only on tasks started in Slack.",
  // One line for every cap (an hour, the task, the thread, all tasks): it never names the limit that refused the question.
  askLimited: "AgentX has answered a lot of questions recently. Try again later, or ask in the task's Slack thread.",
  tooLong: "Keep comments under 2,000 characters.",
  suggest: "Suggest this",
  youSuggest: "You suggest this · Undo",
  suggests: " suggests: ",
  suggestMany: " suggest: ",
  and: " and ",
  someone: "A teammate",
  peopleReview: "Review this change",
  peopleSending: "Sending…",
  peoplePending: "Open the confirmation page to finish this change.",
  peopleDone: "People updated.",
} as const;

/**
 * The deciding and commenting script (spec 061 slice 2), included by nonce only when the reader can comment or decide.
 * It reads the page's JSON data island and builds everything with createElement and textContent: no markup from strings,
 * no handlers in attributes, no navigation built from data (only reload). It turns on the owner's sticky bar ("N to
 * answer", Approve, Request changes) and the one confirmation dialog; the Comment, Reply, Edit, Delete and Suggest
 * controls; drafts kept per document in the tab's sessionStorage (a convenience: any storage failure is ignored, a sign-in that ended clears them, and drafts older
 * than 7 days are dropped); and the page's one poll of `api/state` (every 20 s while visible, every 60 s after 10 quiet
 * minutes), which refreshes the CSRF token, shows the "moved on" banner and re-renders threads when comments change.
 */
export const TASK_PAGE_DECIDING_SCRIPT = String.raw`(function(){
var COPY=${JSON.stringify(TASK_PAGE_DECIDING_COPY)};
var island=document.getElementById("agentx-page-data");
if(!island||typeof fetch!=="function")return;
var data;
try{data=JSON.parse(island.textContent);}catch(e){return;}
var UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var TOKEN=/^[A-Za-z0-9_-]{32,64}$/;
if(!data||typeof data!=="object"||!UUID.test(String(data.taskId)))return;
var taskId=String(data.taskId).toLowerCase();
var API="/review/"+taskId+"/task/api/";
var csrf=TOKEN.test(String(data.csrf))?String(data.csrf):"";
var revision=Number(data.revision)||0;
var commentSeq=Number(data.commentSeq)||0;
var canComment=data.canComment===true,canDecide=data.canDecide===true,canSuggest=data.canSuggest===true,canAsk=data.canAsk===true&&data.askAvailable!==false;
var canRead=data.canRead===undefined?true:data.canRead===true,canManagePeople=data.canManagePeople===true,canTakeOwnership=data.canTakeOwnership===true;
var canRetry=data.canRetry===true;
var hasProjection=false,peopleRevision=null,accessGeneration=0;
function validProjection(state){
  var keys=["canRead","canComment","canSuggest","canDecide","canAsk","canManagePeople","canTakeOwnership"];
  for(var i=0;i<keys.length;i++)if(typeof state[keys[i]]!=="boolean")return false;
  return state.peopleRevision===undefined||Number.isSafeInteger(state.peopleRevision);
}
function applyProjection(state){
  if(!validProjection(state)){
    if(state&&state.canRead===false){hasProjection=true;canRead=false;canComment=false;canSuggest=false;canDecide=false;canAsk=false;canManagePeople=false;canTakeOwnership=false;accessGeneration+=1;applyCurrentAccess();}
    return false;
  }
  if(peopleRevision!==null&&state.peopleRevision!==undefined&&state.peopleRevision<peopleRevision)return false;
  if(peopleRevision!==null&&state.peopleRevision===undefined)return false;
  var prior={canRead:canRead,canComment:canComment,canSuggest:canSuggest,canDecide:canDecide,canAsk:canAsk,canManagePeople:canManagePeople,canTakeOwnership:canTakeOwnership};
  var permissionKeys=["canRead","canComment","canSuggest","canDecide","canAsk","canManagePeople","canTakeOwnership"];
  if(hasProjection)for(var p=0;p<permissionKeys.length;p++)if(prior[permissionKeys[p]]===false&&state[permissionKeys[p]]===true&&(peopleRevision===null||state.peopleRevision===undefined||state.peopleRevision<=peopleRevision))return false;
  var changed=canRead!==state.canRead||canComment!==state.canComment||canSuggest!==state.canSuggest||canDecide!==state.canDecide||canAsk!==state.canAsk||canManagePeople!==state.canManagePeople||canTakeOwnership!==state.canTakeOwnership;
  hasProjection=true;
  if(state.peopleRevision!==undefined)peopleRevision=state.peopleRevision;
  canRead=state.canRead;canComment=canRead&&state.canComment;canSuggest=canRead&&state.canSuggest;canDecide=canRead&&state.canDecide;canAsk=canRead&&state.canAsk&&state.askAvailable!==false;canManagePeople=canRead&&state.canManagePeople;canTakeOwnership=canRead&&state.canTakeOwnership;
  if(changed)accessGeneration+=1;
  applyCurrentAccess();
  return true;
}
var current=data.current&&typeof data.current==="object"?data.current:null;
applyProjection(data);
var DOCS={"requirements":"requirements","design":"design","coding-plan":"plan"};
var LABELS={"requirements":"Requirements","design":"Design","coding-plan":"Coding plan"};
var DRAFT_DAYS=7*24*3600*1000;
var formSeq=0;
function arr(value){return Object.prototype.toString.call(value)==="[object Array]"?value:[];}
function str(value){return typeof value==="string"?value:"";}
function has(object,key){return Object.prototype.hasOwnProperty.call(object,key);}
function make(tag,attributes,text){
  var node=document.createElement(tag);
  if(attributes)for(var name in attributes){if(has(attributes,name)&&!/^on/i.test(name))node.setAttribute(name,attributes[name]);}
  if(text!==undefined&&text!==null)node.textContent=String(text);
  return node;
}
function uuid(){
  if(typeof crypto!=="undefined"&&crypto&&typeof crypto.randomUUID==="function")return crypto.randomUUID();
  var bytes=[],hex="";
  for(var i=0;i<16;i++)bytes.push(typeof crypto!=="undefined"&&crypto&&crypto.getRandomValues?crypto.getRandomValues(new Uint8Array(1))[0]:Math.floor(Math.random()*256));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  for(i=0;i<16;i++){hex+=(bytes[i]+256).toString(16).slice(1);if(i===3||i===5||i===7||i===9)hex+="-";}
  return hex;
}
function openAround(node){for(var up=node;up;up=up.parentElement){if(up.tagName==="DETAILS")up.open=true;}}
function applyCurrentAccess(){
  var controls=document.querySelectorAll(".comment-open,.reply-open,.comment-edit,.comment-delete,.suggest,#decide-next,#decide-approve,#decide-request-changes,#decide-submit");
  var radios=document.querySelectorAll("input");
  var retryNode=document.getElementById("retry-application");
  if(retryNode&&!canRead){retryNode.disabled=true;retryNode.hidden=true;}
  for(var i=0;i<controls.length;i++){
    var node=controls[i],nodeId=node.getAttribute("id")||"",nodeName=node.getAttribute("name")||"",allowed=node.classList&&node.classList.contains("suggest")?canSuggest:(nodeId.indexOf("decide-")===0||nodeName.indexOf("answer-")===0)?canDecide:canComment;
    node.disabled=!allowed;
    if(!allowed)node.hidden=true;
  }
  for(i=0;i<radios.length;i++)if((radios[i].getAttribute("name")||"").indexOf("answer-")===0){radios[i].disabled=!canDecide;if(!canDecide)radios[i].hidden=true;}
  var textareas=document.querySelectorAll("textarea");
  for(i=0;i<textareas.length;i++)textareas[i].disabled=textareas[i].getAttribute("id")==="decide-note"?!canDecide:!canComment;
  var forms=document.querySelectorAll(".comment-form");
  for(i=0;i<forms.length;i++){
    var formButtons=forms[i].querySelectorAll("button");
    for(var b=0;b<formButtons.length;b++)if(formButtons[b].textContent!==COPY.cancel)formButtons[b].disabled=!canComment;
  }
  var askInputs=document.querySelectorAll(".comment-ask input");
  for(i=0;i<askInputs.length;i++)askInputs[i].disabled=!canAsk;
  var confirmations=document.querySelectorAll(".comment-confirm button");
  for(i=0;i<confirmations.length;i++)confirmations[i].disabled=!canComment;
  var dialog=document.getElementById("decide-dialog");
  if(dialog){
    var dialogInputs=dialog.querySelectorAll("input"),dialogButtons=dialog.querySelectorAll("button");
    for(i=0;i<dialogInputs.length;i++)dialogInputs[i].disabled=!canDecide;
    for(i=0;i<dialogButtons.length;i++)dialogButtons[i].disabled=!canDecide&&dialogButtons[i].textContent!==COPY.cancel;
    if(!canDecide&&dialog.open&&typeof dialog.close==="function")dialog.close();
  }
  var roleForms=document.querySelectorAll("[data-people-role-form]");
  for(i=0;i<roleForms.length;i++){
    var roleSelect=roleForms[i].querySelector("select"),roleButton=roleForms[i].querySelector("button");
    if(roleSelect)roleSelect.disabled=!canManagePeople;
    if(roleButton)roleButton.disabled=!canManagePeople;
  }
  var takeoverForms=document.querySelectorAll("[data-people-take-ownership-form]");
  for(i=0;i<takeoverForms.length;i++){var takeoverButton=takeoverForms[i].querySelector("button");if(takeoverButton)takeoverButton.disabled=!canTakeOwnership;}
  var peopleConfirm=document.querySelector("[data-people-confirm]");
  if(peopleConfirm)peopleConfirm.disabled=!(canManagePeople||canTakeOwnership);
}
function hideRemovedTask(){
  var root=document.querySelector("main")||document.body;
  if(root){root.hidden=true;}
  var dialog=document.getElementById("decide-dialog");if(dialog&&dialog.open&&typeof dialog.close==="function")dialog.close();
}
function stopAccess(clearAllDrafts){
  if(!stopped){stopped=true;accessGeneration+=1;}
  canRead=false;canComment=false;canSuggest=false;canDecide=false;canAsk=false;canManagePeople=false;canTakeOwnership=false;
  if(timer!==null){clearTimeout(timer);timer=null;}
  applyCurrentAccess();hideRemovedTask();
  if(clearAllDrafts)clearDrafts();else clearTaskDrafts();
}
function canPost(path,body){
  if(stopped||!canRead)return false;
  if(path==="decision")return canDecide;
  if(path==="retry")return canRetry;
  if(path==="suggestions")return canSuggest;
  if(path==="comments"||path.indexOf("comments/")===0)return canComment&&!(body&&body.ask===true&&!canAsk);
  if(path==="people/role")return canManagePeople;
  if(path==="people/take-ownership")return canTakeOwnership;
  if(/^people\/requests\/[0-9a-f-]{36}\/confirm$/i.test(path))return canManagePeople||canTakeOwnership;
  return false;
}
function peoplePath(path){return path==="people/role"||path==="people/take-ownership"||path.indexOf("people/requests/")===0;}

/* ---------- talking to the API ---------- */
function call(method,path,body,retried){
  var requestGeneration=accessGeneration;
  if(method==="POST"&&!canPost(path,body))return Promise.resolve({status:403,body:{error:"request_refused"}});
  var init={method:method,credentials:"same-origin",cache:"no-store",headers:{accept:"application/json"}};
  if(body!==undefined){init.headers["content-type"]="application/json";init.headers["x-agentx-csrf"]=csrf;init.body=JSON.stringify(body);}
  return fetch(API+path,init).then(function(reply){
    return reply.json().then(function(json){return json;},function(){return {};}).then(function(json){
      var answer={status:reply.status,body:json&&typeof json==="object"?json:{}};
      /* The sign-in ended: what this tab kept is dropped, as on a shared device it should be. */
      if(answer.status===401)stopAccess(true);
      if(method==="POST"&&answer.status===403&&answer.body.error==="request_refused"&&!retried){
        return readState().then(function(state){return state&&requestGeneration===accessGeneration&&canPost(path,body)?call(method,path,body,true):{status:403,body:{error:"request_refused"}};});
      }
      if((peoplePath(path)||path==="retry")&&((answer.status===403&&answer.body.error!=="request_refused")||answer.status===404)&&!retried){
        return readState().then(function(){return answer;});
      }
      if((answer.status===403&&answer.body.error!=="request_refused")||answer.status===404)stopAccess(false);
      return answer;
    });
  });
}
function said(answer){
  if(answer.status===401)return COPY.signIn;
  var message=str(answer.body.message);
  if(message!==""&&message.length<=400)return message;
  return answer.status===409?COPY.changed:COPY.unavailable;
}

/* ---------- drafts ---------- */
var store=null;
/* The tab's own storage: drafts survive a refresh, never the tab, and never reach another tab or a later reader. */
try{store=window.sessionStorage;if(store){var probe="agentx:probe";store.setItem(probe,"1");store.removeItem(probe);}}catch(e){store=null;}
function clearDrafts(){
  drafts={};
  try{
    if(!store)return;
    var mine=[];
    for(var i=0;i<store.length;i++){var k=store.key(i);if(k&&k.indexOf("agentx:")===0)mine.push(k);}
    for(i=0;i<mine.length;i++)store.removeItem(mine[i]);
  }catch(e){}
}
function clearTaskDrafts(){
  drafts={};
  try{if(!store)return;var mine=[];for(var i=0;i<store.length;i++){var k=store.key(i);if(k&&k.indexOf("agentx:"+taskId+":")===0)mine.push(k);}for(i=0;i<mine.length;i++)store.removeItem(mine[i]);}catch(e){}
}
var drafts={};
function draftKey(anchor){return "agentx:"+taskId+":"+anchor;}
function emptyDraft(){return {v:1,at:Date.now(),answers:{},opened:[],drafts:{},excluded:[],note:""};}
function loadDraft(anchor){
  if(has(drafts,anchor))return drafts[anchor];
  var draft=emptyDraft();
  try{
    var raw=store?store.getItem(draftKey(anchor)):null;
    var parsed=raw?JSON.parse(raw):null;
    if(parsed&&typeof parsed==="object"&&parsed.v===1&&typeof parsed.at==="number"&&Date.now()-parsed.at<DRAFT_DAYS){
      draft.at=parsed.at;
      if(parsed.answers&&typeof parsed.answers==="object")for(var key in parsed.answers){if(has(parsed.answers,key)&&typeof parsed.answers[key]==="string")draft.answers[key]=parsed.answers[key];}
      draft.opened=arr(parsed.opened).filter(function(x){return typeof x==="string";});
      if(parsed.drafts&&typeof parsed.drafts==="object")for(var place in parsed.drafts){if(has(parsed.drafts,place)&&typeof parsed.drafts[place]==="string")draft.drafts[place]=parsed.drafts[place];}
      draft.excluded=arr(parsed.excluded).filter(function(x){return typeof x==="string";});
      draft.note=str(parsed.note);
    }else if(raw&&store){store.removeItem(draftKey(anchor));}
  }catch(e){}
  drafts[anchor]=draft;
  return draft;
}
function saveDraft(anchor){
  if(stopped)return;
  var draft=loadDraft(anchor);
  draft.at=Date.now();
  try{
    if(!store)return;
    var empty=draft.opened.length===0&&draft.excluded.length===0&&draft.note===""&&Object.keys(draft.drafts).length===0;
    if(empty)store.removeItem(draftKey(anchor));else store.setItem(draftKey(anchor),JSON.stringify(draft));
  }catch(e){}
}
/* Old drafts of any task are dropped. */
try{
  if(store){
    var stale=[];
    for(var s=0;s<store.length;s++){
      var k=store.key(s);
      if(k&&k.indexOf("agentx:")===0){
        try{var v=JSON.parse(store.getItem(k));if(!v||typeof v.at!=="number"||Date.now()-v.at>=DRAFT_DAYS)stale.push(k);}catch(e){stale.push(k);}
      }
    }
    for(s=0;s<stale.length;s++)store.removeItem(stale[s]);
  }
}catch(e){}

/* ---------- where things are ---------- */
/* The document section a control sits in: its anchor, its version, and the comment store's name for it. */
function placeOf(node){
  var section=node&&node.closest?node.closest("section.doc"):null;
  var found=section?/^(requirements|design|coding-plan)-v([1-9][0-9]*)$/.exec(section.getAttribute("id")||""):null;
  return found?{section:section,anchor:found[1],version:Number(found[2]),document:DOCS[found[1]]}:null;
}
/* Each document's current version on the page. */
function shownVersions(){
  var out={};
  var kinds=document.querySelectorAll("section.kind");
  for(var i=0;i<kinds.length;i++){var v=Number(kinds[i].getAttribute("data-current"));if(DOCS[kinds[i].getAttribute("id")]&&v>0)out[kinds[i].getAttribute("id")]=v;}
  return out;
}
function currentSection(anchor){var v=shownVersions()[anchor];return v?document.getElementById(anchor+"-v"+v):null;}
function targetOf(key){
  if(key==="document")return {kind:"document"};
  var found=/^(claim|decision|check):(.{1,64})$/.exec(key);
  return found?{kind:found[1],id:found[2]}:null;
}
function keyOf(target){
  if(!target||typeof target!=="object")return "";
  return target.kind==="document"?"document":(target.kind==="claim"||target.kind==="decision"||target.kind==="check")&&typeof target.id==="string"?target.kind+":"+target.id:"";
}
function containerFor(section,key){
  var all=section?section.querySelectorAll("section.comments"):[];
  for(var i=0;i<all.length;i++)if(all[i].getAttribute("data-comments")===key)return all[i];
  return null;
}

/* ---------- showing a comment ---------- */
var STATES={answering:COPY.answering,couldnt:COPY.couldnt,not_answered:COPY.notAnswered,unavailable:COPY.askUnavailable,skipped:COPY.skipped,sent_to_coding:COPY.sentToCoding};
var DOC_ANCHORS={requirements:"requirements",design:"design",plan:"coding-plan"};
function claimAnchor(anchor,version,claimId){return anchor+"-v"+version+"-"+claimId.replace(/\./g,"-");}
var DOC_WORDS={requirements:{the:COPY.inRequirements,bare:COPY.nameRequirements},design:{the:COPY.inDesign,bare:COPY.nameDesign},plan:{the:COPY.inPlan,bare:COPY.namePlan}};
function dotted(text){
  // The separator dot is for the eye; a screen reader skips it.
  var span=make("span",{"class":"answering"});
  span.appendChild(make("span",{"aria-hidden":"true"},COPY.dot));
  span.appendChild(document.createTextNode(text));
  return span;
}
var CLAIM_ID=/^[1-9][0-9]{0,2}(?:\.[1-9][0-9]{0,2}){0,2}$/;
function shortTime(at){var d=new Date(at);if(isNaN(d.getTime()))return "";var iso=d.toISOString();return iso.slice(0,10)+" "+iso.slice(11,16)+" UTC";}
function validComment(c){return c&&typeof c==="object"&&UUID.test(str(c.id))&&(c.parentId===undefined||UUID.test(str(c.parentId)))&&c.author&&typeof c.author==="object"&&typeof c.version==="number";}
function commentNode(c,shownVersion,isReply){
  var agentx=c.author.kind==="agentx";
  var article=make("article",{"class":"comment"+(agentx?" comment-agentx":""),id:"comment-"+c.id,"data-comment":c.id,"data-rev":String(Number(c.rev)||1)});
  var meta=make("p",{"class":"comment-meta"});
  if(agentx&&typeof c.answering==="string"&&c.answering!==""){
    // An answer to someone's question: labelled as AI, with the asker's name from the page's own record.
    meta.appendChild(make("span",{"class":"chip chip-agentx"},COPY.agentxAi));
    meta.appendChild(document.createTextNode(" "));
    meta.appendChild(dotted(COPY.answeringWho+c.answering));
  }
  else if(agentx&&c.planner&&typeof c.planner==="object"){
    // The planner's outcome, apart from AgentX's own answer to a question.
    meta.appendChild(make("span",{"class":"chip chip-agentx"},COPY.agentx));
    meta.appendChild(document.createTextNode(" "));
    var words=has(DOC_WORDS,c.planner.document)?DOC_WORDS[c.planner.document].bare:"";
    meta.appendChild(dotted(COPY.fromWord+words+COPY.versionWord+Number(c.planner.version)));
  }
  else if(agentx){meta.appendChild(make("span",{"class":"chip chip-agentx"},COPY.agentx));}
  else{
    meta.appendChild(make("span",{"class":"comment-author"},str(c.author.name)||COPY.someone));
    if(c.author.owner===true){meta.appendChild(document.createTextNode(" "));meta.appendChild(make("span",{"class":"tag tag-owner"},COPY.owner));}
  }
  meta.appendChild(document.createTextNode(" "));
  meta.appendChild(make("time",{datetime:str(c.createdAt)},shortTime(c.createdAt)));
  if(c.version<shownVersion){meta.appendChild(document.createTextNode(" "));meta.appendChild(make("span",{"class":"from-version"},COPY.fromVersion+c.version));}
  if(c.edited===true&&c.deleted!==true){meta.appendChild(document.createTextNode(" "));meta.appendChild(make("span",{"class":"comment-edited"},COPY.edited));}
  article.appendChild(meta);
  if(c.deleted===true)article.appendChild(make("p",{"class":"comment-deleted"},COPY.removed));
  else if(agentx&&c.planner&&typeof c.planner==="object"){
    // After an Approve the comment was handled in the next document; after Request changes, in the same one again.
    var handledIn=has(DOC_ANCHORS,c.planner.in)?c.planner.in:"";
    var handled=handledIn===""?"":COPY.doneIn+DOC_WORDS[handledIn].the;
    var lead=handled===""?(c.planner.outcome==="done"?COPY.done+COPY.becauseColon:COPY.notChanged+" because: "):(c.planner.outcome==="done"?COPY.done:COPY.notChanged)+handled+COPY.becauseColon;
    var claim=typeof c.planner.claim==="string"&&CLAIM_ID.test(c.planner.claim)?c.planner.claim:"";
    var where=has(DOC_ANCHORS,c.planner.document)?c.planner.document:"";
    var shown=Number(c.planner.version);
    var sentence=make("p",{"class":"comment-text"},lead);
    var parts=arr(c.planner.parts);
    if(parts.length===0||where===""||!(shown>0))sentence.appendChild(document.createTextNode(str(c.text)));
    else for(var q=0;q<parts.length;q++){
      /* A claim number of the version that handled the comment links to that version's own claim. */
      if(parts[q]&&typeof parts[q].claim==="string"&&CLAIM_ID.test(parts[q].claim))sentence.appendChild(make("a",{"class":"claim-link",href:"#"+claimAnchor(DOC_ANCHORS[where],shown,parts[q].claim)},parts[q].claim));
      else sentence.appendChild(document.createTextNode(str(parts[q]&&(typeof parts[q].text==="string"?parts[q].text:parts[q].claim))));
    }
    article.appendChild(sentence);
    if(claim!==""&&where!==""&&shown>0){
      // The link is to that version's own claim, which a later version may have renumbered.
      var seen=make("p",{"class":"comment-link"},COPY.seeClaim);
      seen.appendChild(make("a",{"class":"claim-link",href:"#"+claimAnchor(DOC_ANCHORS[where],shown,claim)},COPY.claimWord+claim));
      seen.appendChild(document.createTextNode(COPY.inWord+DOC_WORDS[where].bare+COPY.versionWord+shown+"."));
      article.appendChild(seen);
    }
  }
  else article.appendChild(make("p",{"class":"comment-text"},str(c.text)));
  if(typeof c.agentx==="string"&&has(STATES,c.agentx))article.appendChild(make("p",{"class":"comment-state"},STATES[c.agentx]));
  var yours=!agentx&&c.author.you===true&&c.deleted!==true;
  if(yours&&c.sent===true)article.appendChild(make("p",{"class":"comment-sent"},c.sentWith==="REQUEST_CHANGES"?COPY.sentChanges:c.sentWith!=="APPROVE"?COPY.sentDecision:c.author.owner===true?COPY.sentApproval:COPY.sentOwnerApproval));
  var actions=[];
  if(yours&&c.sent!==true&&canComment){
    actions.push(make("button",{type:"button","class":"comment-edit","data-comment":c.id,"aria-describedby":"comment-"+c.id},COPY.edit));
    actions.push(make("button",{type:"button","class":"comment-delete","data-comment":c.id,"aria-describedby":"comment-"+c.id},COPY.remove));
  }
  if(!isReply&&canComment&&!agentx&&c.deleted!==true)actions.push(make("button",{type:"button","class":"reply-open","data-comment":c.id,"aria-describedby":"comment-"+c.id},COPY.reply));
  if(actions.length>0){
    var p=make("p",{"class":"comment-actions"});
    for(var i=0;i<actions.length;i++){if(i>0)p.appendChild(document.createTextNode(" "));p.appendChild(actions[i]);}
    article.appendChild(p);
  }
  return article;
}
function threadList(comments,shownVersion){
  var top=comments.filter(function(c){return c.parentId===undefined;});
  if(top.length===0)return null;
  var list=make("ol",{"class":"threads"});
  for(var i=0;i<top.length;i++){
    var item=make("li",{"class":"thread"});
    item.appendChild(commentNode(top[i],shownVersion,false));
    var replies=comments.filter(function(r){return r.parentId===top[i].id;});
    if(replies.length>0){
      var ol=make("ol",{"class":"replies"});
      for(var j=0;j<replies.length;j++){var li=make("li");li.appendChild(commentNode(replies[j],shownVersion,true));ol.appendChild(li);}
      item.appendChild(ol);
    }
    list.appendChild(item);
  }
  return list;
}

/* ---------- what is known about comments ---------- */
var known=null; /* the last list from the API */
var openIds=arr(current&&current.openCommentIds).filter(function(x){return UUID.test(str(x));});
function describe(id){
  var article=document.getElementById("comment-"+id);
  if(!article)return COPY.aComment;
  var author=article.querySelector(".comment-author");
  var text=article.querySelector(".comment-text");
  var words=text?text.textContent:"";
  if(words.length>160)words=words.slice(0,159)+"…";
  return (author?author.textContent:COPY.someone)+": "+words;
}

/* Re-renders every thread on the current versions from the API's list; a thread with an open form waits until the form closes. */
function busy(container){
  return container.querySelector(".comment-form")!==null||container.querySelector(".comment-confirm")!==null;
}
function renderContainer(container){
  if(!known)return;
  var place=placeOf(container);
  if(!place)return;
  var key=container.getAttribute("data-comments");
  if(busy(container)){container.setAttribute("data-stale","true");return;}
  container.removeAttribute("data-stale");
  var mine=known.filter(function(c){return c.document===place.document&&c.version<=place.version&&keyOf(c.target)===key;});
  var old=container.querySelector("ol.threads");
  if(old)old.remove();
  var forms=container.querySelectorAll(".comment-form");
  for(var f=0;f<forms.length;f++)forms[f].remove();
  var list=threadList(mine,place.version);
  if(list){
    var label=container.querySelector(".comments-label");
    container.insertBefore(list,label?label.nextSibling:container.firstChild);
  }
  var open=container.querySelectorAll(".comment-open");
  for(var o=0;o<open.length;o++)open[o].hidden=false;
}
function renderAll(){
  var all=document.querySelectorAll("section.comments");
  for(var i=0;i<all.length;i++){var place=placeOf(all[i]);if(place&&shownVersions()[place.anchor]===place.version)renderContainer(all[i]);}
  if(current){
    var doc=DOCS[current.anchor];
    openIds=known.filter(function(c){return c.author.kind==="person"&&c.deleted!==true&&c.sent!==true&&c.document===doc&&c.version<=current.version;}).map(function(c){return c.id;});
  }
}
function renderSuggestions(list){
  var all=document.querySelectorAll(".decision");
  for(var i=0;i<all.length;i++){
    var box=all[i],place=placeOf(box);
    if(!place||shownVersions()[place.anchor]!==place.version)continue;
    var decision=box.getAttribute("data-decision");
    var here=list.filter(function(x){return x&&x.document===place.document&&x.decisionId===decision&&typeof x.optionId==="string";});
    var old=box.querySelectorAll(".suggestions");
    for(var o=0;o<old.length;o++)old[o].remove();
    var options=box.querySelectorAll("li.option");
    var anchor=box.querySelector(".decision-note");
    var after=anchor;
    for(var p=0;p<options.length;p++){
      var optionId=options[p].getAttribute("data-option");
      var labelNode=options[p].querySelector(".option-label");
      var names=here.filter(function(x){return x.optionId===optionId;}).map(function(x){return str(x.name)||COPY.someone;});
      if(names.length===0)continue;
      var joined=names.length===1?names[0]:names.slice(0,-1).join(", ")+COPY.and+names[names.length-1];
      var line=make("p",{"class":"suggestions"},joined+(names.length===1?COPY.suggests:COPY.suggestMany)+(labelNode?labelNode.textContent:""));
      if(after&&after.parentNode===box){box.insertBefore(line,after.nextSibling);after=line;}else box.appendChild(line);
    }
    var mine=here.filter(function(x){return x.you===true;})[0];
    var buttons=box.querySelectorAll(".suggest");
    for(var b=0;b<buttons.length;b++)setSuggest(buttons[b],mine&&mine.optionId===buttons[b].getAttribute("data-option"));
  }
}
function setSuggest(button,on){
  if(on)button.setAttribute("data-mine","true");else button.removeAttribute("data-mine");
  button.textContent=on?COPY.youSuggest:COPY.suggest;
}
function refreshComments(){
  var generation=accessGeneration;
  return call("GET","comments").then(function(answer){
    if(generation!==accessGeneration||stopped||!canRead)return;
    if(answer.status!==200)return;
    known=arr(answer.body.comments).filter(validComment);
    renderAll();
    if(answer.body.suggestions!==undefined)renderSuggestions(arr(answer.body.suggestions));
  },function(){});
}

/* ---------- comment forms ---------- */
function formFor(options){
  formSeq+=1;
  var id="comment-form-"+formSeq;
  var box=make("div",{"class":"comment-form"});
  box.appendChild(make("label",{"for":id},options.label||COPY.yourComment));
  var area=make("textarea",{id:id,rows:"4"});
  area.value=options.text||"";
  box.appendChild(area);
  var ask=null;
  if(options.ask){
    var askLabel=make("label",{"class":"comment-ask"});
    ask=make("input",{type:"checkbox"});
    askLabel.appendChild(ask);
    askLabel.appendChild(document.createTextNode(" "+COPY.ask));
    box.appendChild(askLabel);
  }
  var actions=make("p",{"class":"comment-form-actions"});
  var submit=make("button",{type:"button"},options.submit||COPY.post);
  var cancel=make("button",{type:"button"},COPY.cancel);
  actions.appendChild(submit);actions.appendChild(document.createTextNode(" "));actions.appendChild(cancel);
  box.appendChild(actions);
  var error=make("p",{"class":"comment-error",role:"alert"});
  error.hidden=true;
  box.appendChild(error);
  return {box:box,area:area,ask:ask,submit:submit,cancel:cancel,error:error,fail:function(text){error.textContent=text;error.hidden=false;}};
}
function tooLong(text){return Array.from?Array.from(text).length>2000:text.length>2000;}

/* A new comment (key: its place) or a reply (parentId). */
function openCommentForm(place,key,trigger,parentId,text){
  var container,anchorNode;
  if(parentId){
    var article=document.getElementById("comment-"+parentId);
    if(!article)return null;
    container=article.closest("section.comments");
    anchorNode=article.parentElement;
    key=container?container.getAttribute("data-comments"):key;
  }else{
    container=containerFor(place.section,key);
    if(!container){
      container=make("section",{"class":"comments","data-comments":key});
      var label=trigger&&trigger.getAttribute("data-label");
      if(label)container.appendChild(make("h4",{"class":"comments-label"},label));
      var host=trigger&&trigger.closest("section.checks");
      (host||place.section).appendChild(container);
    }
  }
  if(!container)return null;
  var draftName=parentId?"reply:"+parentId:key;
  var existing=container.querySelectorAll(".comment-form");
  for(var i=0;i<existing.length;i++)if(existing[i].getAttribute("data-draft")===draftName){var t=existing[i].querySelector("textarea");if(t)t.focus();return existing[i];}
  var form=formFor({ask:canAsk,text:text});
  form.box.setAttribute("data-draft",draftName);
  if(parentId)anchorNode.appendChild(form.box);
  else{
    var button=null,buttons=container.querySelectorAll(".comment-open");
    if(buttons.length>0)button=buttons[0];
    if(button&&button.parentNode===container)container.insertBefore(form.box,button);else container.appendChild(form.box);
  }
  if(trigger)trigger.hidden=true;
  var requestId=null,sentText=null,sending=false;
  form.area.addEventListener("input",function(){
    if(stopped||!canRead||!canComment)return;
    var draft=loadDraft(place.anchor);
    if(form.area.value==="")delete draft.drafts[draftName];else draft.drafts[draftName]=form.area.value;
    saveDraft(place.anchor);
  });
  function close(){
    form.box.remove();
    if(trigger)trigger.hidden=false;
    var draft=loadDraft(place.anchor);
    delete draft.drafts[draftName];
    saveDraft(place.anchor);
    if(container.getAttribute("data-stale")==="true")renderContainer(container);
  }
  form.cancel.addEventListener("click",function(){close();if(trigger)trigger.focus();});
  form.submit.addEventListener("click",function(){
    if(stopped||!canRead||!canComment)return;
    if(sending)return;
    var value=form.area.value.replace(/^\s+|\s+$/g,"");
    if(value===""){form.area.focus();return;}
    if(tooLong(value)){form.fail(COPY.tooLong);return;}
    var target=targetOf(key);
    if(!target){form.fail(COPY.changed);return;}
    if(value!==sentText||requestId===null){requestId=uuid();sentText=value;}
    var body={requestId:requestId,document:place.document,version:place.version,target:target,text:value,ask:form.ask?form.ask.checked===true&&canAsk:false};
    if(parentId)body.parentId=parentId;
    sending=true;form.submit.disabled=true;form.error.hidden=true;
    var generation=accessGeneration;
    call("POST","comments",body).then(function(answer){
      if(answer.status===401){sending=false;form.fail(said(answer));return;}
      if(generation!==accessGeneration){sending=false;return;}
      sending=false;form.submit.disabled=false;
      if((answer.status===201||answer.status===200)&&validComment(answer.body.comment)){
        close();
        var node=commentNode(answer.body.comment,place.version,Boolean(parentId));
        if(answer.body.askRefused==="limited")node.appendChild(make("p",{"class":"comment-state"},COPY.askLimited));
        if(parentId){
          var item=document.getElementById("comment-"+parentId).parentElement;
          var replies=item.querySelector("ol.replies");
          if(!replies){replies=make("ol",{"class":"replies"});item.appendChild(replies);}
          var li=make("li");li.appendChild(node);replies.appendChild(li);
        }else{
          var list=container.querySelector("ol.threads");
          if(!list){
            list=make("ol",{"class":"threads"});
            var first=container.querySelector(".comment-open");
            if(first&&first.parentNode===container)container.insertBefore(list,first);else container.appendChild(list);
          }
          var thread=make("li",{"class":"thread"});thread.appendChild(node);list.appendChild(thread);
        }
        return;
      }
      form.fail(said(answer));
    },function(){if(generation!==accessGeneration){sending=false;return;}sending=false;form.submit.disabled=false;form.fail(COPY.unavailable);});
  });
  if(!text)form.area.focus();
  return form.box;
}

function replaceComment(article,c){
  var place=placeOf(article);
  var isReply=Boolean(article.closest("ol.replies"));
  article.parentNode.replaceChild(commentNode(c,place?place.version:c.version,isReply),article);
}
function editComment(article){
  if(article.querySelector(".comment-form"))return;
  var id=article.getAttribute("data-comment");
  var textNode=article.querySelector(".comment-text");
  var form=formFor({text:textNode?textNode.textContent:"",submit:COPY.save});
  if(textNode)textNode.hidden=true;
  var actions=article.querySelector(".comment-actions");
  if(actions)actions.hidden=true;
  article.appendChild(form.box);
  form.area.focus();
  var sending=false;
  form.cancel.addEventListener("click",function(){form.box.remove();if(textNode)textNode.hidden=false;if(actions)actions.hidden=false;});
  form.submit.addEventListener("click",function(){
    if(stopped||!canRead||!canComment)return;
    if(sending)return;
    var value=form.area.value.replace(/^\s+|\s+$/g,"");
    if(value===""){form.area.focus();return;}
    if(tooLong(value)){form.fail(COPY.tooLong);return;}
    sending=true;
    var generation=accessGeneration;
    call("POST","comments/"+id+"/edit",{rev:Number(article.getAttribute("data-rev"))||1,text:value}).then(function(answer){
      if(generation!==accessGeneration){sending=false;return;}
      sending=false;
      if(answer.status===200&&validComment(answer.body.comment)){replaceComment(article,answer.body.comment);return;}
      form.fail(said(answer));
    },function(){if(generation!==accessGeneration){sending=false;return;}sending=false;form.fail(COPY.unavailable);});
  });
}
function deleteComment(article,trigger){
  if(article.querySelector(".comment-confirm"))return;
  var id=article.getAttribute("data-comment");
  var box=make("p",{"class":"comment-confirm",role:"group","aria-label":COPY.confirmRemove});
  box.appendChild(make("span",null,COPY.confirmRemove+" "));
  var yes=make("button",{type:"button"},COPY.remove);
  var no=make("button",{type:"button"},COPY.cancel);
  box.appendChild(yes);box.appendChild(document.createTextNode(" "));box.appendChild(no);
  var error=make("p",{"class":"comment-error",role:"alert"});error.hidden=true;
  article.appendChild(box);article.appendChild(error);
  no.focus();
  no.addEventListener("click",function(){box.remove();error.remove();if(trigger)trigger.focus();});
  yes.addEventListener("click",function(){
    if(stopped||!canRead||!canComment)return;
    yes.disabled=true;
    var generation=accessGeneration;
    call("POST","comments/"+id+"/delete",{rev:Number(article.getAttribute("data-rev"))||1}).then(function(answer){
      if(generation!==accessGeneration)return;
      if(answer.status===200&&validComment(answer.body.comment)){replaceComment(article,answer.body.comment);return;}
      yes.disabled=false;error.textContent=said(answer);error.hidden=false;
    },function(){if(generation!==accessGeneration)return;yes.disabled=false;error.textContent=COPY.unavailable;error.hidden=false;});
  });
}
function suggestOption(button){
  if(stopped||!canRead||!canSuggest)return;
  var place=placeOf(button);
  var box=button.closest(".decision");
  if(!place||!box)return;
  var mine=button.getAttribute("data-mine")==="true";
  var decisionId=box.getAttribute("data-decision");
  var optionId=button.getAttribute("data-option");
  button.disabled=true;
  var generation=accessGeneration;
  call("POST","suggestions",{document:place.document,decisionId:decisionId,optionId:mine?null:optionId}).then(function(answer){
    if(generation!==accessGeneration)return;
    button.disabled=false;
    var error=box.querySelector(".suggest-error");
    if(answer.status!==200){
      if(!error){error=make("p",{"class":"comment-error suggest-error",role:"alert"});box.appendChild(error);}
      error.textContent=said(answer);error.hidden=false;return;
    }
    if(error)error.hidden=true;
    var buttons=box.querySelectorAll(".suggest");
    for(var i=0;i<buttons.length;i++)setSuggest(buttons[i],!mine&&buttons[i]===button);
    return refreshComments();
  },function(){if(generation!==accessGeneration)return;button.disabled=false;});
}

/* ---------- turning controls on ---------- */
if(canComment){
  var controls=document.querySelectorAll(".comment-open, .reply-open, .comment-edit, .comment-delete");
  for(var c=0;c<controls.length;c++)controls[c].hidden=false;
}
if(canSuggest&&current){
  var suggests=document.querySelectorAll(".suggest");
  for(var g=0;g<suggests.length;g++)suggests[g].hidden=false;
}
document.addEventListener("click",function(event){
  if(stopped||!canRead)return;
  var node=event.target;
  if(!node||!node.closest)return;
  var button=node.closest("button");
  if(!button)return;
  var place=placeOf(button);
  if(button.classList.contains("comment-open")&&canComment&&place){
    var key=button.getAttribute("data-target")||"";
    if(targetOf(key))openCommentForm(place,key,button,null,"");
  }else if(button.classList.contains("reply-open")&&canComment&&place){
    var parent=button.getAttribute("data-comment")||"";
    if(UUID.test(parent))openCommentForm(place,"",button,parent,"");
  }else if(button.classList.contains("comment-edit")&&canComment){
    var article=button.closest("article.comment");
    if(article&&UUID.test(article.getAttribute("data-comment")||""))editComment(article);
  }else if(button.classList.contains("comment-delete")&&canComment){
    var gone=button.closest("article.comment");
    if(gone&&UUID.test(gone.getAttribute("data-comment")||""))deleteComment(gone,button);
  }else if(button.classList.contains("suggest")&&canSuggest&&current){
    suggestOption(button);
  }
});

/* Comment drafts come back wherever their place still exists on the current version. */
(function(){
  var versions=shownVersions();
  for(var anchor in versions){
    if(!has(versions,anchor))continue;
    var section=currentSection(anchor);
    if(!section||!canComment)continue;
    var draft=loadDraft(anchor);
    var place={section:section,anchor:anchor,version:versions[anchor],document:DOCS[anchor]};
    for(var name in draft.drafts){
      if(!has(draft.drafts,name))continue;
      var text=draft.drafts[name],opened=null;
      if(name.indexOf("reply:")===0){
        var parentId=name.slice(6);
        var reply=UUID.test(parentId)?document.getElementById("comment-"+parentId):null;
        var replyButton=reply&&section.contains(reply)?reply.querySelector(".reply-open"):null;
        if(replyButton)opened=openCommentForm(place,"",replyButton,parentId,text);
      }else{
        var buttons=section.querySelectorAll(".comment-open"),button=null;
        for(var i=0;i<buttons.length;i++)if(buttons[i].getAttribute("data-target")===name)button=buttons[i];
        if(button)opened=openCommentForm(place,name,button,null,text);
      }
      if(!opened)delete draft.drafts[name];
    }
    saveDraft(anchor);
  }
})();

/* ---------- answering and deciding (the owner, on the waiting document) ---------- */
var decisions=[],answers={},opened={};
var dialogKind="APPROVE",returnTo=null,ticked={},sending=false,requestId=null,lastSent=null,showIt=null;
var bar={next:document.getElementById("decide-next"),count:document.getElementById("decide-count"),approve:document.getElementById("decide-approve"),changes:document.getElementById("decide-request-changes")};
var dialog=document.getElementById("decide-dialog");
var docSection=current?document.getElementById(current.anchor+"-v"+current.version):null;
if(canDecide&&current&&DOCS[current.anchor]&&docSection&&dialog&&bar.next&&bar.approve&&bar.changes){
  decisions=arr(current.decisions).filter(function(d){return d&&typeof d.id==="string"&&typeof d.recommended==="string";});
  var draft=loadDraft(current.anchor);
  var boxes=docSection.querySelectorAll(".decision");
  for(var i=0;i<decisions.length;i++)(function(d){
    d.options=arr(d.options).filter(function(o){return typeof o==="string";});
    d.labels=d.labels&&typeof d.labels==="object"?d.labels:{};
    d.radios=[];
    for(var b=0;b<boxes.length;b++){
      if(boxes[b].getAttribute("data-decision")!==d.id)continue;
      d.box=boxes[b];
      var inputs=boxes[b].querySelectorAll("input");
      for(var r=0;r<inputs.length;r++)if(inputs[r].getAttribute("type")==="radio"&&inputs[r].getAttribute("name")==="answer-"+d.id)d.radios.push(inputs[r]);
    }
    answers[d.id]=d.recommended;
    for(var r2=0;r2<d.radios.length;r2++)if(d.radios[r2].checked)answers[d.id]=d.radios[r2].value;
    /* A draft answer comes back only where the decision and the option still exist. */
    if(has(draft.answers,d.id)&&d.options.indexOf(draft.answers[d.id])>=0&&draft.opened.indexOf(d.id)>=0){
      answers[d.id]=draft.answers[d.id];opened[d.id]=true;
      for(var r3=0;r3<d.radios.length;r3++)d.radios[r3].checked=d.radios[r3].value===answers[d.id];
    }
    function pick(event){
      if(stopped||!canRead||!canDecide)return;
      var input=event.target;
      if(!input||!input.checked)return;
      answers[d.id]=input.value;opened[d.id]=true;
      var saved=loadDraft(current.anchor);
      saved.answers[d.id]=input.value;
      if(saved.opened.indexOf(d.id)<0)saved.opened.push(d.id);
      saveDraft(current.anchor);
      updateBar();
    }
    for(var r4=0;r4<d.radios.length;r4++){d.radios[r4].addEventListener("change",pick);d.radios[r4].addEventListener("click",pick);}
  })(decisions[i]);
  /* Answers of decisions that are gone are dropped from the draft. */
  draft.opened=draft.opened.filter(function(id){return has(opened,id);});
  for(var key in draft.answers){if(has(draft.answers,key)&&!has(opened,key))delete draft.answers[key];}
  saveDraft(current.anchor);
  bar.count&&(bar.count.hidden=true);
  bar.next.hidden=false;bar.approve.hidden=false;bar.changes.hidden=false;
  updateBar();
  bar.next.addEventListener("click",function(){
    var next=decisions.filter(function(d){return !opened[d.id];})[0];
    if(!next){bar.approve.focus();return;}
    if(next.box){openAround(next.box);next.box.scrollIntoView({block:"center"});}
    if(next.radios[0])next.radios[0].focus();
  });
  bar.approve.addEventListener("click",function(){openDialog("APPROVE",bar.approve);});
  bar.changes.addEventListener("click",function(){openDialog("REQUEST_CHANGES",bar.changes);});
  setUpDialog();
}
function updateBar(){
  var left=decisions.filter(function(d){return !opened[d.id];}).length;
  /* Decisions left: a control that goes to the next one. None left: a plain note, not a button. */
  bar.next.hidden=left===0;
  if(left>0)bar.next.textContent=COPY.nextDecision+left+COPY.toAnswer+COPY.closeCount;
  if(bar.count){bar.count.textContent=COPY.allAnswered;bar.count.hidden=!(left===0&&decisions.length>0);}
}

function el(id){return document.getElementById(id);}
function section(id,show){var node=el(id);if(node)node.hidden=!show;}
function clear(node){while(node&&node.firstChild)node.removeChild(node.firstChild);}
function tickedIds(){return openIds.filter(function(id){return ticked[id]===true;});}
function setUpDialog(){
  el("decide-cancel").addEventListener("click",function(){dialog.close();});
  dialog.addEventListener("close",function(){if(returnTo)returnTo.focus();});
  el("decide-note").addEventListener("input",function(){if(stopped||!canRead||!canDecide)return;var saved=loadDraft(current.anchor);saved.note=el("decide-note").value;saveDraft(current.anchor);});
  el("decide-submit").addEventListener("click",submit);
  showIt=make("button",{type:"button"},COPY.showIt);
  showIt.hidden=true;
  showIt.addEventListener("click",function(){location.reload();});
  var actions=el("decide-submit").parentNode;
  actions.appendChild(document.createTextNode(" "));
  actions.appendChild(showIt);
}
function commentsTitle(){el("decide-comments-title").textContent=COPY.commentsToSend+" ("+tickedIds().length+")";}
function openDialog(kind,button){
  dialogKind=kind;returnTo=button;requestId=null;lastSent=null;
  var approve=kind==="APPROVE";
  var label=LABELS[current.anchor]+" v"+current.version;
  el("decide-title").textContent=(approve?COPY.approveTitle:COPY.changesTitle)+label;
  /* Answers that differ, and decisions not opened. */
  var changed=el("decide-changed-list"),unanswered=el("decide-unanswered-list");
  clear(changed);clear(unanswered);
  for(var i=0;i<decisions.length;i++){
    var d=decisions[i],chosen=answers[d.id],question=str(d.question),rec=str(d.labels[d.recommended]);
    if(chosen!==d.recommended)changed.appendChild(make("li",null,question+COPY.youChose+str(d.labels[chosen])+COPY.recommendedOpen+rec+COPY.recommendedClose));
    else if(!opened[d.id])unanswered.appendChild(make("li",null,question+": "+rec));
  }
  section("decide-changed",changed.children.length>0);
  section("decide-unanswered",unanswered.children.length>0);
  /* Comments: every open one ticked, except those the owner left out before, up to 25. */
  var saved=loadDraft(current.anchor);
  var list=el("decide-comments-list");
  clear(list);ticked={};
  var count=0;
  for(var c=0;c<openIds.length;c++){
    var id=openIds[c];
    var on=saved.excluded.indexOf(id)<0&&count<25;
    if(on){ticked[id]=true;count+=1;}
    var item=make("li");
    var labelNode=make("label");
    var box=make("input",{type:"checkbox",value:id});
    box.checked=on;
    labelNode.appendChild(box);
    labelNode.appendChild(document.createTextNode(" "+describe(id)));
    item.appendChild(labelNode);
    list.appendChild(item);
    (function(box,id){box.addEventListener("change",function(){
      if(stopped||!canRead||!canDecide)return;
      if(box.checked&&tickedIds().length>=25){box.checked=false;el("decide-cap").hidden=false;return;}
      ticked[id]=box.checked;
      /* Only what the owner unticked is remembered; a comment left out by the cap of 25 is not. */
      var draft=loadDraft(current.anchor);
      draft.excluded=draft.excluded.filter(function(x){return x!==id;});
      if(!box.checked)draft.excluded.push(id);
      saveDraft(current.anchor);
      commentsTitle();
    });})(box,id);
  }
  el("decide-cap").hidden=openIds.length<=25;
  section("decide-comments",openIds.length>0);
  commentsTitle();
  /* Optional checks, for the coding plan's approval. */
  var checks=el("decide-checks-list");
  clear(checks);
  var optional=current.anchor==="coding-plan"?arr(current.optionalChecks).filter(function(x){return x&&typeof x.id==="string";}):[];
  for(var k=0;k<optional.length;k++){
    var li=make("li"),checkLabel=make("label"),input=make("input",{type:"checkbox",value:optional[k].id});
    input.checked=optional[k].selected===true;
    checkLabel.appendChild(input);checkLabel.appendChild(document.createTextNode(" "+str(optional[k].label)));
    li.appendChild(checkLabel);checks.appendChild(li);
  }
  section("decide-checks",approve&&optional.length>0);
  el("decide-note-label").textContent=approve?COPY.noteApprove:COPY.noteChanges;
  el("decide-note").value=saved.note;
  el("decide-submit").textContent=approve?(current.anchor==="coding-plan"?COPY.submitCoding:COPY.submitOther):COPY.send;
  el("decide-submit").disabled=false;
  el("decide-error").hidden=true;
  el("decide-status").textContent="";
  showIt.hidden=true;
  sending=false;
  if(typeof dialog.showModal==="function"){if(!dialog.open)dialog.showModal();}else dialog.setAttribute("open","");
}
function fail(text,newer){
  var error=el("decide-error");
  error.textContent=text;error.hidden=false;
  el("decide-status").textContent="";
  if(newer)showIt.hidden=false;
}
function submit(){
  if(!canDecide)return;
  if(sending)return;
  var approve=dialogKind==="APPROVE";
  var note=el("decide-note").value.replace(/^\s+|\s+$/g,"");
  var included=tickedIds();
  if(!approve&&included.length===0&&note===""){fail(COPY.needOne,false);return;}
  var body={
    expectedRevision:revision,artifactDigest:str(current.artifactDigest),decision:dialogKind,
    answers:decisions.map(function(d){return {decisionId:d.id,optionId:answers[d.id],opened:opened[d.id]===true};}),
    includedCommentIds:included
  };
  if(dialogKind==="APPROVE"&&typeof current.workBreakdownDigest==="string")body.workBreakdownDigest=current.workBreakdownDigest;
  if(approve&&current.anchor==="coding-plan"){
    var boxes=el("decide-checks-list").querySelectorAll("input"),chosen=[];
    for(var i=0;i<boxes.length;i++)if(boxes[i].checked)chosen.push(boxes[i].value);
    body.selectedOptionalCheckIds=chosen;
  }
  if(note!=="")body.note=note.slice(0,500);
  /* The same request again (a retry) keeps its ID, so the broker treats it as a replay. */
  var same=JSON.stringify(body);
  if(requestId===null||same!==lastSent){requestId=uuid();lastSent=same;}
  var payload={requestId:requestId};
  for(var name in body)if(has(body,name))payload[name]=body[name];
  sending=true;
  el("decide-submit").disabled=true;
  el("decide-error").hidden=true;
  el("decide-status").textContent=COPY.sending;
  var generation=accessGeneration;
  call("POST","decision",payload).then(function(answer){
    if(generation!==accessGeneration){sending=false;return;}
    if(answer.status===200){
      el("decide-status").textContent=COPY.sent;
      var draft=loadDraft(current.anchor);
      draft.answers={};draft.opened=[];draft.excluded=[];draft.note="";
      saveDraft(current.anchor);
      location.reload();
      return;
    }
    sending=false;el("decide-submit").disabled=false;
    fail(said(answer),answer.status===409);
  },function(){if(generation!==accessGeneration){sending=false;return;}sending=false;el("decide-submit").disabled=false;fail(COPY.unavailable,false);});
}

/* ---------- Retrying a blocked browser and API round ---------- */
var retryButton=el("retry-application"),retryId=null,retrying=false;
function retryFail(text){var node=el("retry-error");if(node){node.textContent=text;node.hidden=false;}var status=el("retry-status");if(status)status.textContent="";retrying=false;if(retryButton)retryButton.disabled=false;}
if(retryButton&&canRetry){
  retryButton.hidden=false;
  retryButton.addEventListener("click",function(){
    if(retrying||stopped||!canRead)return;
    /* The same press again keeps its ID, so the broker treats it as a replay. */
    if(retryId===null)retryId=uuid();
    retrying=true;retryButton.disabled=true;
    var failure=el("retry-error");if(failure)failure.hidden=true;
    var status=el("retry-status");if(status)status.textContent=COPY.retrying;
    var generation=accessGeneration;
    call("POST","retry",{requestId:retryId,expectedRevision:revision}).then(function(answer){
      /* The owner's refusal: not a lost task, so the page stays and says so, whatever else the state read just changed. */
      if(answer.status===403&&answer.body.error!=="request_refused"){canRetry=false;retryButton.hidden=true;retryFail(COPY.retryOwnerOnly);return;}
      if(generation!==accessGeneration){retrying=false;return;}
      if(answer.status===200){if(status)status.textContent=COPY.retried;location.reload();return;}
      if(answer.status===409)retryId=null;
      retryFail(said(answer));
    },function(){if(generation!==accessGeneration){retrying=false;return;}retryFail(COPY.unavailable);});
  });
}

/* ---------- People changes: server-made proposals and explicit confirmation ---------- */
function peopleStatus(form){return form.querySelector(".task-people-status");}
function peopleReply(form,button,path,payload){
  if(button.disabled)return;
  var status=peopleStatus(form),generation=accessGeneration;
  button.disabled=true;if(status)status.textContent=COPY.peopleSending;
  call("POST",path,payload).then(function(answer){
    if(generation!==accessGeneration)return;
    if(answer.status===200&&answer.body.status==="COMMITTED"){if(status)status.textContent=COPY.peopleDone;location.reload();return;}
    if(answer.status===202&&answer.body.status==="PENDING"&&UUID.test(str(answer.body.requestId))){
      if(status)status.textContent=COPY.peoplePending;
      location.assign("/review/"+taskId+"/task/people/confirm/"+String(answer.body.requestId).toLowerCase());return;
    }
    button.disabled=false;if(status)status.textContent=said(answer);button.focus();
  },function(){if(generation!==accessGeneration)return;button.disabled=false;if(status)status.textContent=COPY.unavailable;button.focus();});
}
var peopleRoleForms=document.querySelectorAll("[data-people-role-form]");
for(var pf=0;pf<peopleRoleForms.length;pf++)(function(form){
  var select=form.querySelector("select"),button=form.querySelector("button"),person=form.getAttribute("data-person-id"),rev=Number(form.getAttribute("data-people-revision"));
  if(!select||!button||!UUID.test(str(person))||!Number.isSafeInteger(rev))return;
  button.addEventListener("click",function(){peopleReply(form,button,"people/role",{requestId:uuid(),expectedPeopleRevision:rev,personId:person,role:select.value});});
})(peopleRoleForms[pf]);
var peopleTakeForms=document.querySelectorAll("[data-people-take-ownership-form]");
for(var pt=0;pt<peopleTakeForms.length;pt++)(function(form){
  var button=form.querySelector("button"),rev=Number(form.getAttribute("data-people-revision"));if(!button||!Number.isSafeInteger(rev))return;
  button.addEventListener("click",function(){peopleReply(form,button,"people/take-ownership",{requestId:uuid(),expectedPeopleRevision:rev});});
})(peopleTakeForms[pt]);
var peopleConfirm=document.querySelector("[data-people-confirm]");
if(peopleConfirm){
  var confirmId=peopleConfirm.getAttribute("data-people-confirm"),confirmForm=peopleConfirm.closest(".task-people-confirmation");
  if(confirmForm&&UUID.test(str(confirmId)))peopleConfirm.addEventListener("click",function(){peopleReply(confirmForm,peopleConfirm,"people/requests/"+confirmId+"/confirm",{requestId:confirmId});});
}
applyCurrentAccess();

/* ---------- the page's one poll ---------- */
var banner=document.getElementById("moved-on");
var EVERY=20000,QUIET_EVERY=60000,QUIET_AFTER=600000,IDLE_STOP=7200000;
var lastInput=Date.now(),timer=null,asking=false,stopped=false;
function readState(){
  return call("GET","state").then(function(answer){
    if(stopped)return null;
    if(answer.status===401){stopAccess(true);return null;}
    if(answer.status===403||answer.status===404){stopAccess(false);return null;}
    if(answer.status!==200)return null;
    var state=answer.body;
    var acceptedProjection=state&&typeof state==="object"?applyProjection(state):false;
    if(stopped)return null;
    if(hasProjection&&!acceptedProjection&& !canRead){stopAccess(false);return null;}
    if(hasProjection&&!canRead){stopAccess(false);return null;}
    if(TOKEN.test(str(state.csrf)))csrf=state.csrf;
    return state;
  });
}
function showBanner(state){
  if(!banner)return;
  var versions=shownVersions(),text=COPY.movedOn,docs=arr(state.documents);
  for(var i=0;i<docs.length;i++){
    var anchor=str(docs[i]&&docs[i].anchor),version=Number(docs[i]&&docs[i].version);
    if(has(LABELS,anchor)&&version>(versions[anchor]||0)){text=LABELS[anchor]+" v"+version+COPY.isReady;break;}
  }
  var p=banner.querySelector("p"),button=document.getElementById("moved-on-refresh");
  if(p)p.textContent=text;
  if(button)button.textContent=COPY.showIt;
  banner.hidden=false;
}
function poll(){
  if(timer!==null){clearTimeout(timer);timer=null;}
  if(asking||stopped||document.visibilityState==="hidden"||Date.now()-lastInput>=IDLE_STOP)return;
  asking=true;
  var generation=accessGeneration;
  readState().then(function(state){
    if(!state||generation!==accessGeneration||stopped||!canRead)return;
    var stage=banner?banner.getAttribute("data-stage"):null;
    if(Number(state.revision)!==revision||(stage!==null&&typeof state.stage==="string"&&state.stage!==stage))showBanner(state);
    if(typeof state.commentSeq==="number"&&state.commentSeq!==commentSeq){commentSeq=state.commentSeq;return refreshComments();}
  }).then(null,function(){}).then(function(){asking=false;schedule();});
}
function schedule(){
  if(timer!==null){clearTimeout(timer);timer=null;}
  /* Two hours with no input: no more polls until the reader is back. */
  if(stopped||document.visibilityState==="hidden"||Date.now()-lastInput>=IDLE_STOP)return;
  timer=setTimeout(poll,Date.now()-lastInput>=QUIET_AFTER?QUIET_EVERY:EVERY);
}
function touched(){
  var wasQuiet=Date.now()-lastInput>=QUIET_AFTER;
  lastInput=Date.now();
  if(wasQuiet&&!asking)schedule();
}
document.addEventListener("input",touched);
document.addEventListener("click",touched);
document.addEventListener("keydown",touched);
document.addEventListener("visibilitychange",function(){
  if(document.visibilityState==="hidden"){if(timer!==null){clearTimeout(timer);timer=null;}return;}
  lastInput=Date.now();
  if(!asking)poll();
});
var refresh=document.getElementById("moved-on-refresh");
if(refresh)refresh.addEventListener("click",function(){location.reload();});
if(hasProjection&&!canRead)stopAccess(false);
schedule();
})();`;
